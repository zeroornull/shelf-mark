import type { BookmarksApi } from '../bookmarks/api';
import { restoreSnapshot, type PersistSnapshot, type RestoreResult } from '../bookmarks/snapshot';
import { indexRawTree } from '../bookmarks/tree';
import type { RestoreSummary, Snapshot } from '../types';

/**
 * 撤销 / 中断回滚的共用入口（计划 §5.3「中断保护」、§8 UndoBar）。
 *
 * organize 页（通过 `Organizer.undo / rollbackInterrupted`）和 sidepanel 的 `UndoBar` 都走这里，
 * 两个入口不会各写一套。只依赖 `BookmarksApi` + 注入的持久化函数，不 import `browser`。
 */

export function summarizeRestore(result: RestoreResult, reason: RestoreSummary['reason']): RestoreSummary {
  return {
    reason,
    total: result.total,
    restored: result.restored,
    skipped: result.skipped,
    relocated: result.relocated,
    failed: result.failed,
    removedFolders: result.removedFolders.length,
    keptFolders: result.keptFolders.length,
  };
}

export const SNAPSHOT_STATUS_TEXT: Record<Snapshot['status'], string> = {
  applying: '应用中 / 被中断',
  applied: '已应用，可撤销',
  'rolled-back': '已回滚',
  undone: '已撤销',
};

/** 用户撤销：只接受 `status: 'applied'` 的 snapshot。 */
export async function undoSnapshot(api: BookmarksApi, snapshot: Snapshot, persist: PersistSnapshot): Promise<RestoreSummary> {
  if (snapshot.status !== 'applied') {
    throw new Error(`没有可撤销的整理：当前 snapshot 状态是「${SNAPSHOT_STATUS_TEXT[snapshot.status]}」`);
  }
  const result = await restoreSnapshot(api, snapshot, 'undone', persist);
  return summarizeRestore(result, 'undo');
}

/**
 * 补上 journal 窗口：move 是串行的、每条成功后才落盘，所以「move 成功但 `applied` 没写进去」的条目恰好只有一条：
 * `items[applied.length]`（`applied` 是 `items` 的前缀）。只有它当前就在 `toParentId`（且 ≠ `fromParentId`）时才视为已应用；
 * 更后面的条目即使躺在目标文件夹里也不碰——那是用户自己放进去的。
 */
export async function reconcileInterruptedJournal(api: BookmarksApi, snapshot: Snapshot): Promise<Snapshot> {
  const next = snapshot.items[snapshot.applied.length];
  if (!next || snapshot.applied.includes(next.bookmarkId) || next.toParentId === next.fromParentId) return snapshot;
  const index = indexRawTree(await api.getTree());
  if (index.get(next.bookmarkId)?.parentId !== next.toParentId) return snapshot;
  return { ...structuredClone(snapshot), applied: [...snapshot.applied, next.bookmarkId] };
}

/** 中断后回滚：只接受 `status: 'applying'`，对 `applied` 子集（含 journal 窗口补上的）恢复，状态 → 'rolled-back'。 */
export async function rollbackInterruptedSnapshot(
  api: BookmarksApi,
  snapshot: Snapshot,
  persist: PersistSnapshot,
): Promise<RestoreSummary> {
  if (snapshot.status !== 'applying') {
    throw new Error(`没有需要回滚的整理：当前 snapshot 状态是「${SNAPSHOT_STATUS_TEXT[snapshot.status]}」`);
  }
  const reconciled = await reconcileInterruptedJournal(api, snapshot);
  const result = await restoreSnapshot(api, reconciled, 'rolled-back', persist);
  return summarizeRestore(result, 'interrupted');
}

/** 恢复过程中值得告诉用户的异常（都为 0 时返回空数组）。 */
export function restoreAnomalies(summary: RestoreSummary): string[] {
  const parts: string[] = [];
  if (summary.relocated > 0) parts.push(`${summary.relocated} 条原文件夹已不存在，移到了根目录末尾`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} 条书签已被删除，跳过`);
  if (summary.failed > 0) parts.push(`${summary.failed} 条恢复失败，留在原地`);
  if (summary.keptFolders > 0) parts.push(`${summary.keptFolders} 个新建文件夹因非空而保留`);
  return parts;
}

/** 「已撤销 N/M；…」一类的文案；`head` 可覆盖开头（例如结果页统一用「已恢复」）。 */
export function describeRestoreSummary(summary: RestoreSummary, head?: string): string {
  const lead = head ?? (summary.reason === 'undo' ? '已撤销' : summary.reason === 'cancel' ? '已取消并回滚' : '已回滚');
  return [`${lead} ${summary.restored}/${summary.total}`, ...restoreAnomalies(summary)].join('；');
}
