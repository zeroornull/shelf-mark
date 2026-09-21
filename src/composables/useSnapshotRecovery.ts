import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import { browser } from 'wxt/browser';
import { createChromeBookmarksApi, type BookmarksApi } from '@/lib/bookmarks/api';
import { describeBookmarkError } from '@/lib/bookmarks/errors';
import { rollbackInterruptedSnapshot, undoSnapshot } from '@/lib/jobs/recovery';
import { persistSnapshotToStorage, snapshotStorage } from '@/lib/jobs/store';
import type { RestoreSummary, Snapshot } from '@/lib/types';

/**
 * 当前持久化的 snapshot（`local:snapshot`）的响应式视图 + 撤销 / 中断回滚（§5.3 中断保护、§8 UndoBar）。
 *
 * - 加载时读一次，之后跟 `storage.onChanged`（WXT `watch`）：organize 页 apply 时 sidepanel 能实时看到状态变化
 * - `undo()` / `rollback()` 走 `lib/jobs/recovery.ts` 的共用入口，与 organize 页用的是同一段代码
 * - `organizeOpen`：是否有 organize 页打开着（null = 还没查）。snapshot 处于 `applying` 而 organize 页还开着，多半是
 *   「正在应用」而不是「被中断」，这时不提供回滚按钮，避免与正在进行的 apply 互相打架；处于 `applying` 期间每隔几秒复查，
 *   organize 页被关掉后横幅会自动切到「可回滚」
 */
export function useSnapshotRecovery(
  api: BookmarksApi = createChromeBookmarksApi(),
  options: { recheckMs?: number; /** false → 不探测 organize 页是否打开（organize 页自己用）。 */ trackOrganizePage?: boolean } = {},
) {
  const snapshot = shallowRef<Snapshot | null>(null);
  const loaded = ref(false);
  const busy = ref(false);
  const error = ref<string | null>(null);
  const lastSummary = ref<RestoreSummary | null>(null);
  const organizeOpen = ref<boolean | null>(null);

  async function reload(): Promise<void> {
    try {
      snapshot.value = await snapshotStorage.getValue();
    } catch (e) {
      error.value = describeBookmarkError(e);
    } finally {
      loaded.value = true;
    }
  }

  async function checkOrganizeOpen(): Promise<void> {
    organizeOpen.value = await isOrganizePageOpen();
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

  // applying 期间：先查一次 organize 页是否还开着，之后定时复查
  let recheck: ReturnType<typeof setInterval> | undefined;
  watch(
    interrupted,
    (active) => {
      if (recheck !== undefined) clearInterval(recheck);
      recheck = undefined;
      organizeOpen.value = null;
      if (!active || options.trackOrganizePage === false) return;
      void checkOrganizeOpen();
      recheck = setInterval(() => void checkOrganizeOpen(), options.recheckMs ?? 3000);
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
  /** 回滚被中断的整理（要求 `status: 'applying'`）。 */
  const rollback = () => run((current) => rollbackInterruptedSnapshot(api, current, persistSnapshotToStorage));

  void reload();

  return { snapshot, loaded, busy, error, lastSummary, canUndo, interrupted, appliedCount, totalCount, organizeOpen, reload, undo, rollback, checkOrganizeOpen };
}

/** 是否有 organize 页（tab）打开着；`runtime.getContexts` 不可用时当作没有（宁可多给一个回滚按钮）。 */
export async function isOrganizePageOpen(): Promise<boolean> {
  try {
    if (typeof browser.runtime.getContexts !== 'function') return false;
    const contexts = await browser.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [browser.runtime.getURL('/organize.html')] });
    return contexts.length > 0;
  } catch {
    return false;
  }
}
