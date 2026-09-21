import type { BookmarksApi, BookmarkTreeNode, CreateDetails, MoveDestination } from './api';

/**
 * 内存实现的 `BookmarksApi`，测试注入用。index 语义复刻 Chrome：
 *
 * - `create` / `move` 省略 `index` → 追加到末尾；`index > children.length`（或 < 0）→ 抛错
 * - `move` 到同一个 parent → 直接抛错（我们不做同 parent 移动，用 fake 抓误用）
 * - `remove` 非空文件夹、根节点、managed 节点 → 抛错
 * - `getTree` 返回深拷贝，`index` 按当前位置重算
 *
 * 结构和 Chrome 一样：一个不可见的树根（id `'0'`，标题为空），children 是各顶层文件夹。
 */

export type SeedNode = {
  /** 省略则自动分配数字字符串 id。 */
  id?: string;
  title: string;
  /** 有 url 是书签，否则是文件夹。 */
  url?: string;
  children?: SeedNode[];
  folderType?: BookmarkTreeNode['folderType'];
  syncing?: boolean;
  unmodifiable?: 'managed';
  dateAdded?: number;
};

/** 可用于深比较的结构：只含 id / parentId / title / url / 有序 children。 */
export type DumpNode = {
  id: string;
  parentId: string;
  title: string;
  url?: string;
  children?: DumpNode[];
};

export interface FakeBookmarksApi extends BookmarksApi {
  /** 顶层文件夹列表（不含不可见树根），深拷贝。 */
  dump(): DumpNode[];
  /** 单个节点的快照（含 index、children），不存在时返回 undefined。 */
  getNode(id: string): BookmarkTreeNode | undefined;
  /** 某文件夹的有序子节点 id；不存在或不是文件夹时返回 []。 */
  getChildrenIds(id: string): string[];
  /** 各方法的调用次数。 */
  readonly calls: { getTree: number; create: number; move: number; remove: number };
}

type InternalNode = {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
  /** 文件夹才有；有序子节点 id。 */
  children?: string[];
  folderType?: BookmarkTreeNode['folderType'];
  syncing?: boolean;
  unmodifiable?: 'managed';
  dateAdded: number;
};

const TREE_ROOT_ID = '0';

export function createFakeBookmarksApi(seed: SeedNode[]): FakeBookmarksApi {
  const nodes = new Map<string, InternalNode>();
  let nextId = 1;
  let clock = 1_700_000_000_000;

  const isFolder = (node: InternalNode) => node.children !== undefined;
  const isTreeRoot = (node: InternalNode) => node.id === TREE_ROOT_ID;
  const isPermanentRoot = (node: InternalNode) => node.parentId === TREE_ROOT_ID;
  const isManaged = (node: InternalNode) =>
    node.folderType === 'managed' || node.unmodifiable === 'managed';

  const allocateId = (): string => {
    while (nodes.has(String(nextId))) nextId += 1;
    const id = String(nextId);
    nextId += 1;
    return id;
  };

  const getExisting = (id: string, what: string): InternalNode => {
    const node = nodes.get(id);
    if (!node) throw new Error(`Can't find ${what} for id ${id}.`);
    return node;
  };

  const getFolder = (id: string, what: string): InternalNode => {
    const node = getExisting(id, what);
    if (!isFolder(node)) throw new Error(`${what} ${id} is not a folder.`);
    return node;
  };

  const assertIndex = (index: number | undefined, length: number): void => {
    if (index === undefined) return;
    if (!Number.isInteger(index) || index < 0 || index > length) {
      throw new Error(`Index out of bounds: ${index} (children.length = ${length}).`);
    }
  };

  const insertSeed = (seedNode: SeedNode, parentId: string): void => {
    if (seedNode.id === TREE_ROOT_ID) throw new Error(`Seed id '${TREE_ROOT_ID}' is reserved for the tree root.`);
    if (seedNode.id !== undefined && nodes.has(seedNode.id)) throw new Error(`Duplicate seed id ${seedNode.id}.`);
    if (seedNode.url !== undefined && seedNode.children !== undefined) {
      throw new Error(`Seed node ${seedNode.title} has both url and children.`);
    }
    const id = seedNode.id ?? allocateId();
    const parent = nodes.get(parentId)!;
    const node: InternalNode = {
      id,
      parentId,
      title: seedNode.title,
      dateAdded: seedNode.dateAdded ?? clock++,
    };
    if (seedNode.url !== undefined) node.url = seedNode.url;
    else node.children = [];
    if (seedNode.folderType !== undefined) node.folderType = seedNode.folderType;
    // Chrome 里整棵树的 syncing 一致：子节点未指定时继承父节点。
    const syncing = seedNode.syncing ?? parent.syncing;
    if (syncing !== undefined) node.syncing = syncing;
    if (seedNode.unmodifiable !== undefined) node.unmodifiable = seedNode.unmodifiable;
    nodes.set(id, node);
    parent.children!.push(id);
    for (const child of seedNode.children ?? []) insertSeed(child, id);
  };

  nodes.set(TREE_ROOT_ID, { id: TREE_ROOT_ID, title: '', children: [], dateAdded: 0 });
  // 先登记所有显式 id，避免自动分配的 id 与之后出现的显式 id 冲突。
  const reserve = (list: SeedNode[]) => {
    for (const s of list) {
      if (s.id !== undefined && /^\d+$/.test(s.id)) nextId = Math.max(nextId, Number(s.id) + 1);
      if (s.children) reserve(s.children);
    }
  };
  reserve(seed);
  for (const top of seed) insertSeed(top, TREE_ROOT_ID);

  const snapshot = (node: InternalNode, index: number | undefined, deep: boolean): BookmarkTreeNode => {
    const copy: BookmarkTreeNode = { id: node.id, title: node.title, dateAdded: node.dateAdded };
    if (node.parentId !== undefined) copy.parentId = node.parentId;
    if (index !== undefined) copy.index = index;
    if (node.url !== undefined) copy.url = node.url;
    if (node.folderType !== undefined) copy.folderType = node.folderType;
    if (node.syncing !== undefined) copy.syncing = node.syncing;
    if (node.unmodifiable !== undefined) copy.unmodifiable = node.unmodifiable;
    if (node.children !== undefined) {
      copy.children = deep
        ? node.children.map((childId, i) => snapshot(nodes.get(childId)!, i, true))
        : [];
    }
    return copy;
  };

  const indexOf = (node: InternalNode): number | undefined => {
    if (node.parentId === undefined) return undefined;
    return nodes.get(node.parentId)!.children!.indexOf(node.id);
  };

  const isDescendantOf = (candidateId: string, ancestorId: string): boolean => {
    let current = nodes.get(candidateId);
    while (current?.parentId !== undefined) {
      if (current.parentId === ancestorId) return true;
      current = nodes.get(current.parentId);
    }
    return false;
  };

  const dumpNode = (node: InternalNode): DumpNode => {
    const out: DumpNode = { id: node.id, parentId: node.parentId!, title: node.title };
    if (node.url !== undefined) out.url = node.url;
    if (node.children !== undefined) out.children = node.children.map((id) => dumpNode(nodes.get(id)!));
    return out;
  };

  const calls = { getTree: 0, create: 0, move: 0, remove: 0 };

  return {
    calls,

    async getTree(): Promise<BookmarkTreeNode[]> {
      calls.getTree += 1;
      return [snapshot(nodes.get(TREE_ROOT_ID)!, undefined, true)];
    },

    async create(details: CreateDetails): Promise<BookmarkTreeNode> {
      calls.create += 1;
      const parent = getFolder(details.parentId, 'parent bookmark');
      if (isTreeRoot(parent)) throw new Error("Can't modify the root bookmark folders.");
      if (isManaged(parent)) throw new Error("Can't modify managed bookmarks.");
      assertIndex(details.index, parent.children!.length);

      const node: InternalNode = {
        id: allocateId(),
        parentId: parent.id,
        title: details.title,
        dateAdded: clock++,
      };
      if (details.url !== undefined) node.url = details.url;
      else node.children = [];
      if (parent.syncing !== undefined) node.syncing = parent.syncing;

      nodes.set(node.id, node);
      const index = details.index ?? parent.children!.length;
      parent.children!.splice(index, 0, node.id);
      return snapshot(node, index, true);
    },

    async move(id: string, dest: MoveDestination): Promise<BookmarkTreeNode> {
      calls.move += 1;
      const node = getExisting(id, 'bookmark');
      if (isTreeRoot(node) || isPermanentRoot(node)) throw new Error("Can't modify the root bookmark folders.");
      if (isManaged(node)) throw new Error("Can't modify managed bookmarks.");

      const target = getFolder(dest.parentId, 'parent bookmark');
      if (isTreeRoot(target)) throw new Error("Can't modify the root bookmark folders.");
      if (isManaged(target)) throw new Error("Can't modify managed bookmarks.");
      if (target.id === node.parentId) {
        throw new Error(
          `Fake refuses to move ${id} within its current parent ${target.id}: same-parent moves have Chrome-specific index semantics and are not used by Shelfmark.`,
        );
      }
      if (isFolder(node) && (target.id === node.id || isDescendantOf(target.id, node.id))) {
        throw new Error("Can't move a folder to itself or its descendant.");
      }
      assertIndex(dest.index, target.children!.length);

      const oldParent = nodes.get(node.parentId!)!;
      oldParent.children!.splice(oldParent.children!.indexOf(node.id), 1);
      const index = dest.index ?? target.children!.length;
      target.children!.splice(index, 0, node.id);
      node.parentId = target.id;
      // 跨账号 / 本地树移动时 Chrome 会改写 syncing；Shelfmark 不跨树，这里只同步被移动的节点本身。
      if (target.syncing !== undefined) node.syncing = target.syncing;
      return snapshot(node, index, true);
    },

    async remove(id: string): Promise<void> {
      calls.remove += 1;
      const node = getExisting(id, 'bookmark');
      if (isTreeRoot(node) || isPermanentRoot(node)) throw new Error("Can't modify the root bookmark folders.");
      if (isManaged(node)) throw new Error("Can't modify managed bookmarks.");
      if (isFolder(node) && node.children!.length > 0) {
        throw new Error("Can't remove non-empty folder (use recursive to force).");
      }
      const parent = nodes.get(node.parentId!)!;
      parent.children!.splice(parent.children!.indexOf(node.id), 1);
      nodes.delete(node.id);
    },

    dump(): DumpNode[] {
      return nodes.get(TREE_ROOT_ID)!.children!.map((id) => dumpNode(nodes.get(id)!));
    },

    getNode(id: string): BookmarkTreeNode | undefined {
      const node = nodes.get(id);
      return node ? snapshot(node, indexOf(node), true) : undefined;
    },

    getChildrenIds(id: string): string[] {
      return [...(nodes.get(id)?.children ?? [])];
    },
  };
}
