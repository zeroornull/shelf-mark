import type { BookmarksApi, BookmarkTreeNode } from './api';
import type { FlatBookmark, FolderNode, Settings } from '../types';

/**
 * 读树 / 展平 / 识别根节点 / 排除 managed。
 *
 * 只依赖 `BookmarksApi`，不 import `browser`。
 *
 * 约定：
 * - 根节点只用 `folderType`（+ `syncing`）识别，不看本地化标题，也不写死 id。
 * - `folderType === 'managed'` / `unmodifiable === 'managed'` 的整棵子树跳过。
 * - 同一 `folderType` 可能有 `syncing: true / false` 两棵（账号 / 本地双树），
 *   它们是不同的根，各自有独立 `rootId`，永远不跨树处理。
 * - `FlatBookmark.folderPath` 是根以下、到父文件夹为止的标题路径（不含根标题，
 *   根由 `rootId` 表示）：直接挂在根下的散装书签 `folderPath` 为 `[]`。
 */

export type RootFolderType = 'bookmarks-bar' | 'other' | 'mobile';

export type RootInfo = {
  id: string;
  /** 浏览器给的本地化标题，只用于显示。 */
  title: string;
  folderType: RootFolderType;
  syncing: boolean;
};

export type ReusableFolder = {
  id: string;
  title: string;
  /** 根以下到该文件夹（含自身）的标题路径。 */
  path: string[];
  rootId: string;
};

export type BookmarkTree = {
  /** 按浏览器返回顺序，已排除 managed。 */
  roots: RootInfo[];
  /** 每个根一棵 `FolderNode`（与 `roots` 一一对应），managed 子树已剔除。 */
  nodes: FolderNode[];
  /** 全部书签，DFS 顺序。 */
  bookmarks: FlatBookmark[];
};

export type Scope = Settings['scope'];

const ROOT_TYPES: ReadonlySet<string> = new Set<RootFolderType>(['bookmarks-bar', 'other', 'mobile']);
const LOOSE_ROOT_TYPES: ReadonlySet<RootFolderType> = new Set<RootFolderType>(['bookmarks-bar', 'other']);

export function isManagedNode(node: Pick<BookmarkTreeNode, 'folderType' | 'unmodifiable'>): boolean {
  return node.folderType === 'managed' || node.unmodifiable === 'managed';
}

/** 浏览器内置的、可整理的顶层文件夹（书签栏 / 其他书签 / 移动书签）。 */
export function isRootNode(node: BookmarkTreeNode): node is BookmarkTreeNode & { folderType: RootFolderType } {
  return node.folderType !== undefined && ROOT_TYPES.has(node.folderType);
}

export function isBookmarkNode(node: BookmarkTreeNode): node is BookmarkTreeNode & { url: string } {
  return typeof node.url === 'string';
}

export function isFolderNode(node: FolderNode | FlatBookmark): node is FolderNode {
  return Array.isArray((node as FolderNode).children);
}

export async function readBookmarkTree(api: BookmarksApi): Promise<BookmarkTree> {
  return buildBookmarkTree(await api.getTree());
}

/** 把 `getTree()` 的原始结果按 id 建索引（含不可见树根和 managed 节点）。 */
export function indexRawTree(rawTree: BookmarkTreeNode[]): Map<string, BookmarkTreeNode> {
  const index = new Map<string, BookmarkTreeNode>();
  const visit = (node: BookmarkTreeNode) => {
    index.set(node.id, node);
    for (const child of node.children ?? []) visit(child);
  };
  for (const top of rawTree) visit(top);
  return index;
}

/** 节点在父节点 children 中的位置：优先用 Chrome 给的 `index`，缺失时按位置计算。 */
export function positionOf(index: Map<string, BookmarkTreeNode>, node: BookmarkTreeNode): number | undefined {
  if (node.index !== undefined) return node.index;
  if (node.parentId === undefined) return undefined;
  const siblings = index.get(node.parentId)?.children ?? [];
  const position = siblings.findIndex((sibling) => sibling.id === node.id);
  return position >= 0 ? position : undefined;
}

/**
 * 沿 `parentId` 向上找到节点所属的可整理根（bookmarks-bar / other / mobile）。
 * managed 子树、孤儿节点、树根本身都返回 undefined。
 */
export function findRootOf(index: Map<string, BookmarkTreeNode>, id: string): BookmarkTreeNode | undefined {
  const visited = new Set<string>();
  let current = index.get(id);
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    if (isManagedNode(current)) return undefined;
    if (isRootNode(current)) return current;
    if (current.parentId === undefined) return undefined;
    current = index.get(current.parentId);
  }
  return undefined;
}

/**
 * 纯函数版本：把 `getTree()` 的结果整理成 `BookmarkTree`。
 *
 * Chrome 的 `getTree()` 返回 `[树根]`，树根的 children 才是各个顶层文件夹；
 * 这里同时兼容直接传入顶层文件夹数组的情况。
 */
export function buildBookmarkTree(rawTree: BookmarkTreeNode[]): BookmarkTree {
  const roots: RootInfo[] = [];
  const nodes: FolderNode[] = [];
  const bookmarks: FlatBookmark[] = [];

  for (const candidate of collectRootCandidates(rawTree)) {
    if (isManagedNode(candidate) || !isRootNode(candidate)) continue;
    const root: RootInfo = {
      id: candidate.id,
      title: candidate.title,
      folderType: candidate.folderType,
      syncing: candidate.syncing ?? false,
    };
    roots.push(root);
    nodes.push(convertFolder(candidate, root, [], bookmarks));
  }

  return { roots, nodes, bookmarks };
}

function collectRootCandidates(rawTree: BookmarkTreeNode[]): BookmarkTreeNode[] {
  const candidates: BookmarkTreeNode[] = [];
  for (const top of rawTree) {
    if (isRootNode(top) || isManagedNode(top)) candidates.push(top);
    else candidates.push(...(top.children ?? []));
  }
  return candidates;
}

function convertFolder(
  node: BookmarkTreeNode,
  root: RootInfo,
  path: string[],
  out: FlatBookmark[],
): FolderNode {
  const folder: FolderNode = { id: node.id, title: node.title, children: [] };
  if (node.folderType !== undefined) folder.folderType = node.folderType;
  if (node.unmodifiable !== undefined) folder.unmodifiable = node.unmodifiable;
  if (node.syncing !== undefined) folder.syncing = node.syncing;

  (node.children ?? []).forEach((child, position) => {
    if (isManagedNode(child)) return;
    if (isBookmarkNode(child)) {
      const bookmark: FlatBookmark = {
        id: child.id,
        title: child.title,
        url: child.url,
        parentId: node.id,
        index: child.index ?? position,
        rootId: root.id,
        folderPath: path,
        // 整棵树的 syncing 一致；节点自己没带时用根的值。
        syncing: child.syncing ?? root.syncing,
      };
      out.push(bookmark);
      folder.children.push(bookmark);
    } else {
      folder.children.push(convertFolder(child, root, [...path, child.title], out));
    }
  });

  return folder;
}

function rootById(tree: BookmarkTree): Map<string, RootInfo> {
  return new Map(tree.roots.map((root) => [root.id, root]));
}

/** 散装书签：父节点就是 bookmarks-bar 或 other 根节点，且自己是书签。 */
export function isLoose(bookmark: FlatBookmark, tree: BookmarkTree): boolean {
  if (bookmark.parentId !== bookmark.rootId) return false;
  const root = tree.roots.find((r) => r.id === bookmark.rootId);
  return root !== undefined && LOOSE_ROOT_TYPES.has(root.folderType);
}

export function listLooseBookmarks(tree: BookmarkTree): FlatBookmark[] {
  return tree.bookmarks.filter((bookmark) => isLoose(bookmark, tree));
}

/** 每个根下的散装书签数量（mobile 根按定义恒为 0）。 */
export function countLooseByRoot(tree: BookmarkTree): Array<{ root: RootInfo; count: number }> {
  const counts = new Map<string, number>(tree.roots.map((root) => [root.id, 0]));
  for (const bookmark of listLooseBookmarks(tree)) {
    counts.set(bookmark.rootId, (counts.get(bookmark.rootId) ?? 0) + 1);
  }
  return tree.roots.map((root) => ({ root, count: counts.get(root.id) ?? 0 }));
}

/**
 * 某个根下用户自己建的命名文件夹（任意深度），供 AI 复用。
 * 排除根自身、managed、以及空标题的文件夹（空标题文件夹的子文件夹仍会列出）。
 */
export function listReusableFolders(tree: BookmarkTree, rootId: string): ReusableFolder[] {
  const rootNode = tree.nodes.find((node) => node.id === rootId);
  if (!rootNode) return [];

  const out: ReusableFolder[] = [];
  const walk = (folder: FolderNode, path: string[]) => {
    for (const child of folder.children) {
      if (!isFolderNode(child) || isManagedNode(child)) continue;
      const childPath = [...path, child.title];
      if (child.title.trim() !== '') {
        out.push({ id: child.id, title: child.title, path: childPath, rootId });
      }
      walk(child, childPath);
    }
  };
  walk(rootNode, []);
  return out;
}

/**
 * 按 settings.scope 选出待整理的书签；`debugLimit` 有值（> 0）时只取前 N 条。
 * 两棵同类型的账号 / 本地树都会被选中，但各自保留自己的 `rootId`。
 */
export function selectBookmarksInScope(
  tree: BookmarkTree,
  scope: Scope,
  debugLimit?: number,
): FlatBookmark[] {
  const allowed: ReadonlySet<RootFolderType> =
    scope === 'loose-bar-and-other'
      ? new Set<RootFolderType>(['bookmarks-bar', 'other'])
      : new Set<RootFolderType>(['other']);
  const roots = rootById(tree);

  const selected = tree.bookmarks.filter((bookmark) => {
    if (bookmark.parentId !== bookmark.rootId) return false;
    const root = roots.get(bookmark.rootId);
    return root !== undefined && allowed.has(root.folderType);
  });

  if (debugLimit !== undefined && Number.isFinite(debugLimit) && debugLimit > 0) {
    return selected.slice(0, Math.floor(debugLimit));
  }
  return selected;
}
