import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { createChromeBookmarksApi, type BookmarksApi } from '@/lib/bookmarks/api';
import { describeBookmarkError } from '@/lib/bookmarks/errors';
import type { OrganizePresence } from '@/lib/jobs/organize-tabs';
import { rollbackInterruptedSnapshot, undoSnapshot } from '@/lib/jobs/recovery';
import { persistSnapshotToStorage, snapshotStorage } from '@/lib/jobs/store';
import type { RestoreSummary, Snapshot } from '@/lib/types';
import { detectOrganizePage, detectOtherOrganizePage } from './useOrganizeTab';

/**
 * 当前持久化的 snapshot（`local:snapshot`）的响应式视图 + 撤销 / 中断回滚（§5.3 中断保护、§8 UndoBar）。
 *
 * - 加载时读一次，之后跟 `storage.onChanged`（WXT `watch`）：organize 页 apply 时 sidepanel 能实时看到状态变化
 * - `undo()` / `rollback()` 走 `lib/jobs/recovery.ts` 的共用入口，与 organize 页用的是同一段代码
 * - `organizePresence`：snapshot 处于 `applying` 期间探测有没有 organize 页开着（organize 页自己用 `excludeSelf`
 *   排除自身）。'open' → 多半是「正在应用」而不是「被中断」，不给回滚按钮；'unknown'（API 不可用）也不给——
 *   判断不了就按开着处理；只有 'closed' 才提供回滚。applying 期间每隔几秒复查，organize 页被关掉后横幅会自动切到「可回滚」
 */
export type SnapshotRecoveryOptions = {
  recheckMs?: number;
  /** false → 不探测 organize 页（默认探测）。 */
  trackOrganizePage?: boolean;
  /** true → 排除当前标签自身（organize 页用）。 */
  excludeSelf?: boolean;
};

export function useSnapshotRecovery(api: BookmarksApi = createChromeBookmarksApi(), options: SnapshotRecoveryOptions = {}) {
  const snapshot = shallowRef<Snapshot | null>(null);
  const loaded = ref(false);
  const busy = ref(false);
  const error = ref<string | null>(null);
  const lastSummary = ref<RestoreSummary | null>(null);
  /** null = 还没查。 */
  const organizePresence = ref<OrganizePresence | null>(null);

  async function reload(): Promise<void> {
    try {
      snapshot.value = await snapshotStorage.getValue();
    } catch (e) {
      error.value = describeBookmarkError(e);
    } finally {
      loaded.value = true;
    }
  }

  async function checkOrganizePage(): Promise<void> {
    organizePresence.value = options.excludeSelf ? await detectOtherOrganizePage() : await detectOrganizePage();
  }

  const unwatch = snapshotStorage.watch((value) => {
    if (value?.id !== snapshot.value?.id) {
      // 换了一份 snapshot（新的整理）：上一轮的结果 / 错误不再相关
      lastSummary.value = null;
      error.value = null;
    }
    snapshot.value = value;
  });
  onScopeDispose(unwatch);

  const canUndo = computed(() => snapshot.value?.status === 'applied' && snapshot.value.applied.length > 0);
  const interrupted = computed(() => snapshot.value?.status === 'applying');
  /** 中断且确认没有 organize 页在处理：可以回滚。 */
  const canRollback = computed(() => interrupted.value && (options.trackOrganizePage === false || organizePresence.value === 'closed'));

  // applying 期间：先查一次 organize 页是否还开着，之后定时复查
  let recheck: ReturnType<typeof setInterval> | undefined;
  watch(
    interrupted,
    (active) => {
      if (recheck !== undefined) clearInterval(recheck);
      recheck = undefined;
      organizePresence.value = null;
      if (!active || options.trackOrganizePage === false) return;
      void checkOrganizePage();
      recheck = setInterval(() => void checkOrganizePage(), options.recheckMs ?? 3000);
    },
    { immediate: true },
  );
  onScopeDispose(() => {
    if (recheck !== undefined) clearInterval(recheck);
  });
  const appliedCount = computed(() => snapshot.value?.applied.length ?? 0);
  const totalCount = computed(() => snapshot.value?.items.length ?? 0);

  async function run(action: (current: Snapshot) => Promise<RestoreSummary>): Promise<RestoreSummary | null> {
    const current = snapshot.value;
    if (!current || busy.value) return null;
    busy.value = true;
    error.value = null;
    try {
      const summary = await action(current);
      lastSummary.value = summary;
      return summary;
    } catch (e) {
      error.value = describeBookmarkError(e);
      return null;
    } finally {
      busy.value = false;
    }
  }

  /** 撤销最近一次整理（要求 `status: 'applied'`）。 */
  const undo = () => run((current) => undoSnapshot(api, current, persistSnapshotToStorage));
  /** 回滚被中断的整理（要求 `status: 'applying'`，且 `canRollback`）。 */
  const rollback = () => {
    if (!canRollback.value) return Promise.resolve(null);
    return run((current) => rollbackInterruptedSnapshot(api, current, persistSnapshotToStorage));
  };

  void reload();

  return {
    snapshot,
    loaded,
    busy,
    error,
    lastSummary,
    canUndo,
    interrupted,
    canRollback,
    appliedCount,
    totalCount,
    organizePresence,
    reload,
    undo,
    rollback,
    checkOrganizePage,
  };
}
