import { UNCATEGORIZED, categoryPath, indexCategories } from '../ai/taxonomy';
import type { PlannedMove } from '../bookmarks/snapshot';
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
  bookmarks: ReadonlyArray<Pick<FlatBookmark, 'id' | 'rootId' | 'parentId'>>;
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

/** 目标已是制定计划时的父文件夹：apply 会按 same-parent 丢掉，预览里标「保持不动」。 */
export function isKeepStillMove(move: PlannedMove): boolean {
  return 'toParentId' in move && move.toParentId === move.expectedParentId;
}
