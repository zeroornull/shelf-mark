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
  /** 例 `['工作', '前端']`；空数组表示根本身（或 `baseParentId` 本身）。 */
  toPath: string[];
  /**
   * 路径的起点：默认是书签所属的根。父类目复用了已有文件夹时填该文件夹 id，子类目就建在它下面
   * （§0「优先复用已有文件夹」）。不在书签同一根下 / 已不存在 → 退回从根开始。
   */
  baseParentId?: string;
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
  /**
   * 每条 move 之前询问一次（§7「applying：停止后续 move」）：返回 true → 不再 move，
   * 对 `applied` 子集走与失败相同的回滚路径，结果 `ok: false, stopped: true`。绝不打断正在进行的 move。
   */
  shouldStop?: () => boolean;
  /** 进度：snapshot 落盘后（done = 0）和每成功一条 move 后各调用一次；total = 本次实际要移动的条数。 */
  onProgress?: (done: number, total: number) => void;
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
  /** true：全部 move 成功，status 'applied'；false：中途失败 / 被 `shouldStop` 停止并已回滚，status 'rolled-back'。 */
  ok: boolean;
  snapshot: Snapshot;
  /** 应用前校验被剔除的条目（含 same-parent 这种无需移动的）。 */
  skipped: SkippedMove[];
  /** ok 为 false 且不是 stopped 时的原始错误。 */
  error?: unknown;
  /** ok 为 false 且回滚成功时的回滚结果。 */
  rollback?: RestoreResult;
  /** ok 为 false 且回滚本身也失败：snapshot 保持 'applying'（journal 是真实的），交给中断横幅再试。 */
  rollbackError?: unknown;
  /** true：因 `shouldStop` 返回 true 而停止（不是失败）。 */
  stopped?: boolean;
  /** true：校验后没有任何可移动的条目；**没有落盘**（不覆盖上一份可撤销的 snapshot），返回的 snapshot 只是占位。 */
  nothingToDo?: boolean;
};

/**
 * `applySnapshot` 唯一会抛出的错误类型。`stage: 'prepare'`：还没 move 任何书签（校验 / 建文件夹 / 首次落盘失败，
 * 新建的空文件夹已收回）。move 开始之后的问题一律通过 `ApplyResult` 返回，不抛。
 */
export class ApplySnapshotError extends Error {
  readonly stage: 'prepare';

  constructor(stage: 'prepare', cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ApplySnapshotError';
    this.stage = stage;
  }
}

/** 通过校验、待解析目标的条目。 */
type Pending =
  | { bookmarkId: string; rootId: string; kind: 'folder'; toParentId: string }
  | { bookmarkId: string; rootId: string; kind: 'path'; toPath: string[]; baseParentId?: string };

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
      // baseParentId 必须是同一根下仍存在的文件夹，否则退回从根开始建路径
      let baseParentId: string | undefined;
      if (move.baseParentId !== undefined) {
        const base = index.get(move.baseParentId);
        if (base && base.url === undefined && findRootOf(index, base.id)?.id === root.id) baseParentId = base.id;
      }
      pending.push({ bookmarkId, rootId: root.id, kind: 'path', toPath: move.toPath, ...(baseParentId !== undefined ? { baseParentId } : {}) });
    }
  }

  // 3. 建目标文件夹（追加末尾）。同一 apply 内相同 (parent, normalize(title)) 只 ensure 一次。
  const createdFolderIds: string[] = [];
  const folderCache = new Map<string, string>();
  /** 收回本次新建的空文件夹；自身失败不遮盖原始错误。 */
  const cleanupCreated = async (): Promise<string[]> => {
    try {
      return (await removeEmptyCreatedFolders(api, createdFolderIds)).kept;
    } catch {
      return [...createdFolderIds];
    }
  };
  const resolveTarget = async (item: Pending): Promise<string> => {
    if (item.kind === 'folder') return item.toParentId;
    let parentId = item.baseParentId ?? item.rootId;
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
    await cleanupCreated();
    throw new ApplySnapshotError('prepare', error);
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
    // 没有可移动的条目：收回刚建的空文件夹；**不落盘**，否则会覆盖上一份还能撤销的 snapshot
    snapshot.createdFolderIds = await cleanupCreated();
    snapshot.status = 'applied';
    return { ok: true, snapshot, skipped, nothingToDo: true };
  }

  // 5. 先落盘。失败 → 还没 move，收回空文件夹再抛
  try {
    await persist(cloneSnapshot(snapshot));
  } catch (error) {
    await cleanupCreated();
    throw new ApplySnapshotError('prepare', error);
  }

  // 进度回调只是通知，绝不能让它的异常变成「写入失败」
  const progress = (done: number) => {
    try {
      options.onProgress?.(done, items.length);
    } catch {
      // ignore
    }
  };
  progress(0);

  // 8. 对 applied 子集回滚；回滚自己也失败时 snapshot 保持 'applying'，留给中断横幅再试
  const rollBack = async (error: unknown, stopped: boolean): Promise<ApplyResult> => {
    const base = stopped ? { ok: false as const, skipped, stopped } : { ok: false as const, skipped, error };
    try {
      const rollback = await restoreSnapshot(api, snapshot, 'rolled-back', persist);
      return { ...base, snapshot: rollback.snapshot, rollback };
    } catch (rollbackError) {
      return { ...base, snapshot: cloneSnapshot(snapshot), rollbackError };
    }
  };

  // 6. 串行 move，不传 index；move 与 journal 落盘在同一个 try 里：落盘失败时 move 已经成功，必须先计入 applied 再回滚
  for (const item of items) {
    if (options.shouldStop?.()) return rollBack(undefined, true);
    try {
      await api.move(item.bookmarkId, { parentId: item.toParentId });
      snapshot.applied.push(item.bookmarkId);
      await persist(cloneSnapshot(snapshot));
    } catch (error) {
      return rollBack(error, false);
    }
    progress(snapshot.applied.length);
  }

  // 7. 全部成功
  snapshot.status = 'applied';
  try {
    await persist(cloneSnapshot(snapshot));
  } catch (error) {
    // 书签都已到位，只是最终状态没写进去：按失败回滚，让状态与存储一致
    snapshot.status = 'applying';
    return rollBack(error, false);
  }
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
