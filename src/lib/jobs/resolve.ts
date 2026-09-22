import { UNCATEGORIZED, categoryPath, indexCategories } from '../ai/taxonomy';
import { normalizeTitle } from '../bookmarks/mutate';
import type { PlannedMove } from '../bookmarks/snapshot';
import { formatFolderPath } from '../bookmarks/tree';
import type { BookmarkOrigin, FlatBookmark, Proposal, ReviewState } from '../types';

/**
 * `proposal.assignments` + review 编辑 → `applySnapshot` 接受的 `PlannedMove[]`（计划 §5.3 第 2 步）。
 * 纯函数，不读树：`applySnapshot` 自己会重新读树校验 `expectedParentId`。
 *
 * - 剔除的、未勾选的 uncategorized / 重复项不动
 * - `existingFolderId` 只对同一根下的书签生效（`ResolvedMove`）；另一根按同名路径新建（`PathMove`）
 * - 父类目复用了同根已有文件夹时，子类目以它为起点（`PathMove.baseParentId`），不在根下重建同名父文件夹
 * - 勾选 uncategorized 时，这些条目移入各自根下的「未分类」文件夹
 * - 同 parent 的条目由 `applySnapshot` 以 'same-parent' 剔除，这里不判断
 */

export const UNCATEGORIZED_FOLDER_TITLE = '未分类';

export type ResolveMovesInput = {
  proposal: Proposal;
  review: ReviewState;
  bookmarks: ReadonlyArray<Pick<FlatBookmark, 'id' | 'rootId' | 'parentId'> & Partial<Pick<FlatBookmark, 'title' | 'folderPath'>>>;
  /** 已有文件夹 id → 所属根 id；未知返回 undefined（当作不同根，按路径新建）。 */
  folderRoot: (folderId: string) => string | undefined;
  /** 制定计划时的 parentId；有则作为 expectedParentId，否则退回当前 parentId。 */
  origins?: Readonly<Record<string, Pick<BookmarkOrigin, 'parentId'>>>;
  uncategorizedTitle?: string;
};

export function resolveMoves(input: ResolveMovesInput): PlannedMove[] {
  const { proposal, review } = input;
  const byId = indexCategories(proposal.categories);
  const bookmarkById = new Map(input.bookmarks.map((b) => [b.id, b]));
  const excluded = new Set(review.excluded);
  const duplicateIds = new Set(proposal.duplicates.flatMap((d) => d.bookmarkIds));
  const uncategorizedTitle = input.uncategorizedTitle ?? UNCATEGORIZED_FOLDER_TITLE;

  const moves: PlannedMove[] = [];
  for (const assignment of proposal.assignments) {
    const bookmark = bookmarkById.get(assignment.bookmarkId);
    if (!bookmark) continue;
    if (excluded.has(bookmark.id)) continue;
    if (duplicateIds.has(bookmark.id) && !review.includeDuplicates) continue;
    const expectedParentId = input.origins?.[bookmark.id]?.parentId ?? bookmark.parentId;

    if (assignment.categoryId === UNCATEGORIZED) {
      if (!review.includeUncategorized) continue;
      moves.push({ bookmarkId: bookmark.id, toPath: [uncategorizedTitle], expectedParentId });
      continue;
    }

    const category = byId.get(assignment.categoryId);
    if (!category) continue;
    if (category.existingFolderId !== undefined && input.folderRoot(category.existingFolderId) === bookmark.rootId) {
      moves.push({ bookmarkId: bookmark.id, toParentId: category.existingFolderId, expectedParentId });
      continue;
    }
    // 父类目复用了同根的已有文件夹（可能在任意深度）：子类目建在它下面，而不是按标题在根下再建一个同名父文件夹
    const parent = category.parentId !== undefined ? byId.get(category.parentId) : undefined;
    if (parent?.existingFolderId !== undefined && input.folderRoot(parent.existingFolderId) === bookmark.rootId) {
      moves.push({ bookmarkId: bookmark.id, baseParentId: parent.existingFolderId, toPath: [category.title], expectedParentId });
      continue;
    }
    moves.push({ bookmarkId: bookmark.id, toPath: categoryPath(category, byId), expectedParentId });
  }
  return moves;
}

export function folderPathsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((title, i) => normalizeTitle(title) === normalizeTitle(b[i] ?? ''));
}

/** 目标已是制定计划时的父文件夹：apply 会按 same-parent 丢掉，预览里标「保持不动」。 */
export function isKeepStillMove(
  move: PlannedMove,
  bookmark?: Pick<FlatBookmark, 'folderPath' | 'parentId'>,
): boolean {
  if ('toParentId' in move && move.toParentId === move.expectedParentId) return true;
  if ('toPath' in move && bookmark && move.baseParentId === undefined) {
    return folderPathsEqual(bookmark.folderPath, move.toPath);
  }
  return false;
}

export type ApplyCandidate = {
  bookmarkId: string;
  title: string;
  fromLabel: string;
  destLabel: string;
  keepStill: boolean;
  excluded: boolean;
};

/**
 * 应用页清单：所有「有去处」的书签（含已被剔除的），方便勾选部分应用。
 * 未勾选 uncategorized / duplicates 的条目不出现（它们本来就不会动）。
 */
export function listApplyCandidates(
  input: ResolveMovesInput & {
    titleOf?: (id: string) => string;
    rootTitleOf?: (rootId: string) => string;
    existingPathOf?: (folderId: string) => string[] | undefined;
  },
): ApplyCandidate[] {
  const { proposal, review } = input;
  const byId = indexCategories(proposal.categories);
  const bookmarkById = new Map(input.bookmarks.map((b) => [b.id, b]));
  const excluded = new Set(review.excluded);
  const duplicateIds = new Set(proposal.duplicates.flatMap((d) => d.bookmarkIds));
  const uncategorizedTitle = input.uncategorizedTitle ?? UNCATEGORIZED_FOLDER_TITLE;
  const out: ApplyCandidate[] = [];

  for (const assignment of proposal.assignments) {
    const bookmark = bookmarkById.get(assignment.bookmarkId);
    if (!bookmark) continue;
    if (duplicateIds.has(bookmark.id) && !review.includeDuplicates) continue;

    let destLabel: string;
    let destPath: string[];
    let destFolderId: string | undefined;
    if (assignment.categoryId === UNCATEGORIZED) {
      if (!review.includeUncategorized) continue;
      destLabel = uncategorizedTitle;
      destPath = [uncategorizedTitle];
    } else {
      const category = byId.get(assignment.categoryId);
      if (!category) continue;
      destFolderId = category.existingFolderId;
      const existingPath =
        destFolderId !== undefined && input.folderRoot(destFolderId) === bookmark.rootId
          ? input.existingPathOf?.(destFolderId)
          : undefined;
      destPath = existingPath ?? categoryPath(category, byId);
    }

    const rootTitle = input.rootTitleOf?.(bookmark.rootId) ?? '';
    const fromLabel = formatFolderPath(rootTitle ? [rootTitle, ...(bookmark.folderPath ?? [])] : (bookmark.folderPath ?? []));
    destLabel = formatFolderPath(rootTitle ? [rootTitle, ...destPath] : destPath);

    const keepStill =
      (destFolderId !== undefined && destFolderId === bookmark.parentId) ||
      folderPathsEqual(bookmark.folderPath ?? [], destPath);

    out.push({
      bookmarkId: bookmark.id,
      title: input.titleOf?.(bookmark.id) ?? ('title' in bookmark ? String(bookmark.title ?? bookmark.id) : bookmark.id),
      fromLabel,
      destLabel,
      keepStill,
      excluded: excluded.has(bookmark.id),
    });
  }
  return out;
}
