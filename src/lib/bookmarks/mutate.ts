import type { BookmarksApi, BookmarkTreeNode, MoveDestination } from './api';
import { indexRawTree } from './tree';

/**
 * 写入层只封装三个动作。只依赖 `BookmarksApi`，不 import `browser`。
 *
 * - `ensureFolder`：同级同名（normalize 后）则复用，否则 create **不传 index**（追加到末尾）
 * - `moveBookmark`：薄包 `move`
 * - `removeEmptyCreatedFolders`：只用 `remove()`，非空抛错就保留；绝不 `removeTree`
 */

/** 同名判断用：NFKC → trim → 忽略大小写。否则每次整理都会叠一层「前端 (1)」。 */
export function normalizeTitle(title: string): string {
  return title.normalize('NFKC').trim().toLowerCase();
}

export type EnsureFolderResult = {
  id: string;
  /** true 表示本次新建（调用方应记入 createdFolderIds）。 */
  created: boolean;
};

/**
 * 在 `parentId` 下找 normalize 后同名的子文件夹；找不到就新建（追加末尾，不改动兄弟的 index）。
 * 每次都重新读树，保证看到本次整理里刚建好的文件夹。
 */
export async function ensureFolder(api: BookmarksApi, parentId: string, title: string): Promise<EnsureFolderResult> {
  const displayTitle = title.trim();
  if (displayTitle === '') throw new Error('ensureFolder: folder title must not be empty.');

  const index = indexRawTree(await api.getTree());
  const parent = index.get(parentId);
  if (!parent || parent.url !== undefined) {
    throw new Error(`ensureFolder: parent ${parentId} does not exist or is not a folder.`);
  }

  const wanted = normalizeTitle(title);
  const existing = (parent.children ?? []).find(
    (child) => child.url === undefined && normalizeTitle(child.title) === wanted,
  );
  if (existing) return { id: existing.id, created: false };

  const created = await api.create({ parentId, title: displayTitle });
  return { id: created.id, created: true };
}

export type EnsureFolderPathResult = {
  /** 路径最后一段对应的文件夹 id。 */
  id: string;
  /** 本次新建的文件夹 id，按创建顺序（父在前）。 */
  createdIds: string[];
};

/** 从 `rootId` 出发逐级 `ensureFolder`；`path` 为空时直接返回 `rootId`。 */
export async function ensureFolderPath(api: BookmarksApi, rootId: string, path: string[]): Promise<EnsureFolderPathResult> {
  let parentId = rootId;
  const createdIds: string[] = [];
  for (const title of path) {
    const result = await ensureFolder(api, parentId, title);
    if (result.created) createdIds.push(result.id);
    parentId = result.id;
  }
  return { id: parentId, createdIds };
}

export function moveBookmark(api: BookmarksApi, id: string, dest: MoveDestination): Promise<BookmarkTreeNode> {
  return api.move(id, dest);
}

export type RemoveEmptyFoldersResult = {
  removed: string[];
  /** `remove()` 抛错（通常是非空）而保留的文件夹。 */
  kept: string[];
  /** 已经不存在（例如被用户删掉）的 id。 */
  missing: string[];
};

/**
 * 撤销 / 回滚时清理本次新建的文件夹。只调用 `remove()`：非空会抛错，catch 后保留，
 * 这样用户在新文件夹里手动加的东西不会被误删。绝不 `removeTree`。
 *
 * `ids` 按创建顺序传入（父在前）；这里倒序处理，先删子文件夹再删父文件夹。
 */
export async function removeEmptyCreatedFolders(api: BookmarksApi, ids: string[]): Promise<RemoveEmptyFoldersResult> {
  const result: RemoveEmptyFoldersResult = { removed: [], kept: [], missing: [] };
  if (ids.length === 0) return result;

  const index = indexRawTree(await api.getTree());
  for (const id of [...ids].reverse()) {
    if (!index.has(id)) {
      result.missing.push(id);
      continue;
    }
    try {
      await api.remove(id);
      result.removed.push(id);
    } catch {
      result.kept.push(id);
    }
  }
  return result;
}
