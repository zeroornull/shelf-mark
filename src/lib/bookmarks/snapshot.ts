import type { ResolvedMove, Snapshot, SnapshotItem } from '../types';
import type { BookmarksApi } from './api';
import { ensureFolder, normalizeTitle, removeEmptyCreatedFolders } from './mutate';
import { findRootOf, indexRawTree, isBookmarkNode, positionOf } from './tree';

/**
 * Snapshot：应用（带 journal）与撤销 / 回滚。只依赖 `BookmarksApi` + 注入的持久化钩子。
 *
 * 不变量（对照计划 §5.3 / §11）：
 * - 新文件夹一律追加到末尾（`ensureFolder` 不传 index）
 * - `fromParentId / fromIndex` 在建完文件夹、开始 move 之前一次读好
 * - snapshot 以 `status: 'applying'` 先落盘，然后才 move
 * - 串行 move，不传 index；每成功一条追加 `applied` 并落盘
 * - 撤销 / 回滚按 `fromParentId` 分组、组内 `fromIndex` 升序、index clamp 到 children.length
 * - 只 `remove()` 空的新建文件夹，绝不 `removeTree`
 */

/** 目标文件夹用「根以下的标题路径」表示，apply 时按书签自己的根 `ensureFolder`。 */
export type PathMove = {
  bookmarkId: string;
  /** 例 `['工作', '前端']`；空数组表示根本身。 */
  toPath: string[];
};

/**
 * apply 的输入：目标文件夹要么是已解析的真实 id（`ResolvedMove`），要么是路径（`PathMove`）。
 * `expectedParentId` 是制定计划时看到的 parentId；给了就校验「parentId 未变」，变了的跳过。
 */
export type PlannedMove = (ResolvedMove | PathMove) & { expectedParentId?: string };

export type SkipReason =
  | 'duplicate'
  | 'missing'
  | 'not-a-bookmark'
  | 'managed'
  | 'no-root'
  | 'parent-changed'
  | 'target-missing'
  | 'cross-root'
  | 'same-parent';

export type SkippedMove = { bookmarkId: string; reason: SkipReason };

export type PersistSnapshot = (snapshot: Snapshot) => Promise<void>;

export type ApplyOptions = {
  /** 每次 journal 变化都会收到一份深拷贝；实现方写 storage.local。 */
  persist: PersistSnapshot;
  /** 指定 snapshot id（测试用）；默认生成。 */
  id?: string;
  /** 时间源（测试用）。 */
  now?: () => number;
};

export type RestoreResult = {
  /** 本次尝试恢复的条目数（= applied 子集大小）。 */
  total: number;
  /** 回到原文件夹的条目。 */
  restored: number;
  /** 书签已被用户删除而跳过的条目。 */
  skipped: number;
  /** 原文件夹已不存在、改为移到对应根节点末尾的条目。 */
  relocated: number;
  /** move 意外失败、留在原地的条目。 */
  failed: number;
  removedFolders: string[];
  keptFolders: string[];
  /** 状态已更新为 finalStatus 的 snapshot（不修改传入对象）。 */
  snapshot: Snapshot;
};

export type ApplyResult = {
  /** true：全部 move 成功，status 'applied'；false：中途失败并已回滚，status 'rolled-back'。 */
  ok: boolean;
  snapshot: Snapshot;
  /** 应用前校验被剔除的条目（含 same-parent 这种无需移动的）。 */
  skipped: SkippedMove[];
  /** ok 为 false 时的原始错误。 */
  error?: unknown;
  /** ok 为 false 时的回滚结果。 */
  rollback?: RestoreResult;
};

/** 通过校验、待解析目标的条目。 */
type Pending =
  | { bookmarkId: string; rootId: string; kind: 'folder'; toParentId: string }
  | { bookmarkId: string; rootId: string; kind: 'path'; toPath: string[] };

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return structuredClone(snapshot);
}

function generateSnapshotId(now: number): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `snap-${now}-${random}`;
}

/**
 * 应用一组移动（计划 §5.3 第 1、3–8 步；第 0 步备份和第 2 步 assignments 解析由调用方完成）。
 *
 * 1. 重新读树，剔除：重复、已消失、不是书签、managed、parentId 已变、目标不存在、跨根、同 parent
 * 3. 路径目标逐级 `ensureFolder`（追加末尾），记录 `createdFolderIds`
 * 4. 再读一次树，取每条书签当前 `parentId / index` 组成 `SnapshotItem`
 * 5. snapshot 以 `'applying'` 落盘
 * 6. 串行 move（不传 index），每成功一条追加 `applied` 并落盘
 * 7. 全部成功 → `'applied'`
 * 8. 中途失败 → 对 `applied` 子集 `restoreSnapshot(..., 'rolled-back')`，错误放进 `result.error`
 */
export async function applySnapshot(
  api: BookmarksApi,
  moves: PlannedMove[],
  options: ApplyOptions,
): Promise<ApplyResult> {
  const { persist } = options;
  const now = options.now ?? Date.now;
  const skipped: SkippedMove[] = [];
  const skip = (bookmarkId: string, reason: SkipReason) => skipped.push({ bookmarkId, reason });

  // 1. 校验
  let index = indexRawTree(await api.getTree());
  const seen = new Set<string>();
  const pending: Pending[] = [];
  for (const move of moves) {
    const { bookmarkId } = move;
    if (seen.has(bookmarkId)) {
      skip(bookmarkId, 'duplicate');
      continue;
    }
    seen.add(bookmarkId);

    const node = index.get(bookmarkId);
    if (!node) {
      skip(bookmarkId, 'missing');
      continue;
    }
    if (!isBookmarkNode(node) || node.parentId === undefined) {
      skip(bookmarkId, 'not-a-bookmark');
      continue;
    }
    if (node.unmodifiable === 'managed') {
      skip(bookmarkId, 'managed');
      continue;
    }
    if (move.expectedParentId !== undefined && node.parentId !== move.expectedParentId) {
      skip(bookmarkId, 'parent-changed');
      continue;
    }
    const root = findRootOf(index, bookmarkId);
    if (!root) {
      skip(bookmarkId, 'no-root');
      continue;
    }

    if ('toParentId' in move) {
      const target = index.get(move.toParentId);
      if (!target || target.url !== undefined) {
        skip(bookmarkId, 'target-missing');
        continue;
      }
      if (findRootOf(index, target.id)?.id !== root.id) {
        skip(bookmarkId, 'cross-root');
        continue;
      }
      if (move.toParentId === node.parentId) {
        skip(bookmarkId, 'same-parent');
        continue;
      }
      pending.push({ bookmarkId, rootId: root.id, kind: 'folder', toParentId: move.toParentId });
    } else {
      pending.push({ bookmarkId, rootId: root.id, kind: 'path', toPath: move.toPath });
    }
  }

  // 3. 建目标文件夹（追加末尾）。同一 apply 内相同 (parent, normalize(title)) 只 ensure 一次。
  const createdFolderIds: string[] = [];
  const folderCache = new Map<string, string>();
  const resolveTarget = async (item: Pending): Promise<string> => {
    if (item.kind === 'folder') return item.toParentId;
    let parentId = item.rootId;
    for (const title of item.toPath) {
      const key = `${parentId}\u0000${normalizeTitle(title)}`;
      let id = folderCache.get(key);
      if (id === undefined) {
        const result = await ensureFolder(api, parentId, title);
        if (result.created) createdFolderIds.push(result.id);
        id = result.id;
        folderCache.set(key, id);
      }
      parentId = id;
    }
    return parentId;
  };

  const items: SnapshotItem[] = [];
  try {
    const resolved: Array<{ bookmarkId: string; toParentId: string }> = [];
    for (const item of pending) {
      resolved.push({ bookmarkId: item.bookmarkId, toParentId: await resolveTarget(item) });
    }

    // 4. 文件夹已建好、尚未 move：现在读的 parentId / index 就是移动前的真实值
    index = indexRawTree(await api.getTree());
    for (const { bookmarkId, toParentId } of resolved) {
      const node = index.get(bookmarkId);
      const fromIndex = node ? positionOf(index, node) : undefined;
      if (!node || !isBookmarkNode(node) || node.parentId === undefined || fromIndex === undefined) {
        skip(bookmarkId, 'missing');
        continue;
      }
      if (node.parentId === toParentId) {
        skip(bookmarkId, 'same-parent');
        continue;
      }
      items.push({
        bookmarkId,
        toParentId,
        fromParentId: node.parentId,
        fromIndex,
        title: node.title,
        url: node.url,
      });
    }
  } catch (error) {
    // 还没 move 任何东西，也还没落盘：把刚建的空文件夹收回去，然后把错误抛给调用方
    await removeEmptyCreatedFolders(api, createdFolderIds);
    throw error;
  }

  const createdAt = now();
  const snapshot: Snapshot = {
    id: options.id ?? generateSnapshotId(createdAt),
    createdAt,
    items,
    createdFolderIds,
    applied: [],
    status: 'applying',
  };

  if (items.length === 0) {
    // 没有可移动的条目：新建的文件夹全是空的，直接收回，不留 'applying' 状态
    const cleanup = await removeEmptyCreatedFolders(api, createdFolderIds);
    snapshot.createdFolderIds = cleanup.kept;
    snapshot.status = 'applied';
    await persist(cloneSnapshot(snapshot));
    return { ok: true, snapshot, skipped };
  }

  // 5. 先落盘
  await persist(cloneSnapshot(snapshot));

  // 6. 串行 move，不传 index
  for (const item of items) {
    try {
      await api.move(item.bookmarkId, { parentId: item.toParentId });
    } catch (error) {
      // 8. 对 applied 子集回滚
      const rollback = await restoreSnapshot(api, snapshot, 'rolled-back', persist);
      return { ok: false, snapshot: rollback.snapshot, skipped, error, rollback };
    }
    snapshot.applied.push(item.bookmarkId);
    await persist(cloneSnapshot(snapshot));
  }

  // 7. 全部成功
  snapshot.status = 'applied';
  await persist(cloneSnapshot(snapshot));
  return { ok: true, snapshot, skipped };
}

/**
 * 撤销（'undone'）/ 回滚（'rolled-back'）共用：只处理 `items` 中 `bookmarkId ∈ applied` 的子集。
 *
 * 1. 按 `fromParentId` 分组，组内按 `fromIndex` 升序
 * 2. 逐条 `move(id, { parentId: fromParentId, index: Math.min(fromIndex, children.length) })`
 * 3. 书签已被删除 → 跳过并计数；原文件夹已不存在 → 移到对应根节点末尾并计数
 * 4. `remove()` `createdFolderIds` 中已空的文件夹（非空保留）
 * 5. status → finalStatus，落盘
 *
 * 为什么升序：其他书签 `[b0,b1,b2,b3]` 全移入新建的 F 后变成 `[F]`；升序 b0→0、b1→1、b2→2、b3→3
 * 得到 `[b0,b1,b2,b3,F]`；降序第一步 b3→3 时 children.length 只有 1，Chrome 直接抛 index 越界。
 */
export async function restoreSnapshot(
  api: BookmarksApi,
  snapshot: Snapshot,
  finalStatus: 'undone' | 'rolled-back',
  persist?: PersistSnapshot,
): Promise<RestoreResult> {
  const appliedSet = new Set(snapshot.applied);
  const targets = snapshot.items.filter((item) => appliedSet.has(item.bookmarkId));

  // 1. 分组（按首次出现顺序），组内升序
  const groups = new Map<string, SnapshotItem[]>();
  for (const item of targets) {
    const group = groups.get(item.fromParentId);
    if (group) group.push(item);
    else groups.set(item.fromParentId, [item]);
  }
  const ordered = [...groups.values()].flatMap((group) => [...group].sort((a, b) => a.fromIndex - b.fromIndex));

  // 读一次树，之后本地维护「各文件夹子节点数」和「各书签当前 parent」，不用每条都重读
  const index = indexRawTree(await api.getTree());
  const childCount = new Map<string, number>();
  const currentParent = new Map<string, string>();
  for (const node of index.values()) {
    if (node.children !== undefined) childCount.set(node.id, node.children.length);
    if (node.parentId !== undefined) currentParent.set(node.id, node.parentId);
  }

  const trackedMove = async (id: string, parentId: string, position?: number) => {
    await api.move(id, position === undefined ? { parentId } : { parentId, index: position });
    const previous = currentParent.get(id);
    if (previous !== undefined) childCount.set(previous, Math.max(0, (childCount.get(previous) ?? 1) - 1));
    childCount.set(parentId, (childCount.get(parentId) ?? 0) + 1);
    currentParent.set(id, parentId);
  };

  const result: RestoreResult = {
    total: ordered.length,
    restored: 0,
    skipped: 0,
    relocated: 0,
    failed: 0,
    removedFolders: [],
    keptFolders: [],
    snapshot: { ...cloneSnapshot(snapshot), status: finalStatus },
  };

  // 2 / 3. 逐条移回
  for (const item of ordered) {
    const node = index.get(item.bookmarkId);
    if (!node) {
      result.skipped += 1;
      continue;
    }
    const parentNow = currentParent.get(item.bookmarkId);
    const source = index.get(item.fromParentId);

    if (source !== undefined && source.url === undefined) {
      if (parentNow === item.fromParentId) {
        // 用户已手动移回：不做同 parent move
        result.restored += 1;
        continue;
      }
      const position = Math.min(item.fromIndex, childCount.get(item.fromParentId) ?? 0);
      try {
        await trackedMove(item.bookmarkId, item.fromParentId, position);
        result.restored += 1;
      } catch {
        result.failed += 1;
      }
      continue;
    }

    // 原文件夹已不存在 → 移到书签当前所属根节点的末尾
    const root = findRootOf(index, item.bookmarkId);
    if (!root) {
      result.failed += 1;
      continue;
    }
    if (parentNow === root.id) {
      result.relocated += 1;
      continue;
    }
    try {
      await trackedMove(item.bookmarkId, root.id);
      result.relocated += 1;
    } catch {
      result.failed += 1;
    }
  }

  // 4. 清理空的新建文件夹
  const cleanup = await removeEmptyCreatedFolders(api, snapshot.createdFolderIds);
  result.removedFolders = cleanup.removed;
  result.keptFolders = cleanup.kept;

  // 5. 状态落盘
  if (persist) await persist(cloneSnapshot(result.snapshot));
  return result;
}
