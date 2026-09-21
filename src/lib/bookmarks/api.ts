import { browser } from 'wxt/browser';

/**
 * 书签层唯一允许 import `browser` 的文件。
 *
 * `tree.ts` / `mutate.ts` / `snapshot.ts` / `fake.ts` 只能 `import type` 本文件里的类型，
 * 这样 vitest 在 node 里跑时不会加载到 `wxt/browser`。
 */

/** Chrome 134+ 的 `folderType`。 */
export type BookmarkFolderType = 'bookmarks-bar' | 'other' | 'mobile' | 'managed';

/**
 * 自己声明的 `chrome.bookmarks.BookmarkTreeNode`。
 *
 * 包含 Chrome 134+ 才有的 `folderType` / `syncing`，以及 `unmodifiable`。
 * 这里全部声明为可选：fake 树、旧版类型定义、以及低于 134 的浏览器都可能缺字段。
 * 真实实现里 Chrome 返回的节点结构兼容本类型，直接断言即可。
 */
export type BookmarkTreeNode = {
  id: string;
  /** 根节点（不可见的 tree root）没有 parentId。 */
  parentId?: string;
  /** 在父节点 children 中的位置。 */
  index?: number;
  title: string;
  /** 书签有 url，文件夹没有。 */
  url?: string;
  /** 文件夹有 children（可能为空数组），书签没有。 */
  children?: BookmarkTreeNode[];
  dateAdded?: number;
  dateGroupModified?: number;
  dateLastUsed?: number;
  /** Chrome 134+：浏览器内置的顶层文件夹类型；普通文件夹为 undefined。 */
  folderType?: BookmarkFolderType;
  /** Chrome 134+：是否同步到账号；用于区分同一 folderType 的账号 / 本地双树。 */
  syncing?: boolean;
  /** 企业策略书签整棵子树都带 'managed'，不可修改。 */
  unmodifiable?: 'managed';
};

export type CreateDetails = {
  parentId: string;
  title: string;
  url?: string;
  /** 省略 → 追加到末尾。 */
  index?: number;
};

export type MoveDestination = {
  parentId: string;
  /** 省略 → 追加到末尾。 */
  index?: number;
};

export interface BookmarksApi {
  getTree(): Promise<BookmarkTreeNode[]>;
  create(details: CreateDetails): Promise<BookmarkTreeNode>;
  move(id: string, dest: MoveDestination): Promise<BookmarkTreeNode>;
  remove(id: string): Promise<void>;
}

/**
 * 真实实现：薄包一层 `browser.bookmarks.*`。
 *
 * 所有属性访问都放在方法体内（延迟），这样在没有扩展 API 的环境里创建对象不会抛错。
 */
export function createChromeBookmarksApi(): BookmarksApi {
  return {
    async getTree() {
      return (await browser.bookmarks.getTree()) as BookmarkTreeNode[];
    },
    async create(details) {
      return (await browser.bookmarks.create(details)) as BookmarkTreeNode;
    },
    async move(id, dest) {
      return (await browser.bookmarks.move(id, dest)) as BookmarkTreeNode;
    },
    async remove(id) {
      await browser.bookmarks.remove(id);
    },
  };
}
