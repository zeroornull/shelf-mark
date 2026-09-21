import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { createChatFn, type ChatFn } from '@/lib/ai/client';
import { createChromeBookmarksApi, type BookmarkTreeNode } from '@/lib/bookmarks/api';
import { backupFileName, downloadBackup, renderNetscapeHtml } from '@/lib/bookmarks/backup';
import { Organizer, type OrganizerState } from '@/lib/jobs/organizer';
import { jobStorage, loadSnapshotFromStorage, persistJobToStorage, persistSnapshotToStorage } from '@/lib/jobs/store';
import type { JobInput, Settings, Snapshot } from '@/lib/types';

/**
 * 把 `Organizer` 接到真实环境：Chrome 书签 API、真实 `chatJson`、`local:job` / `local:snapshot`、
 * 真实 HTML 备份（渲染 + `<a download>`）、当前设置。页面加载时从 `local:job` 恢复（review 阶段不重打模型）。
 */
export function useOrganizeJob(settings: Ref<Settings>) {
  // provider 变了就换一个 client（quirks 是按 provider 记的）
  let chat: ChatFn = createChatFn(settings.value.provider);
  watch(
    () => JSON.stringify(settings.value.provider),
    () => {
      chat = createChatFn(settings.value.provider);
    },
  );

  /** §5.3 第 0 步 / §5.4：渲染 Netscape HTML 并触发下载，返回文件名。 */
  const backup = async (tree: BookmarkTreeNode[]): Promise<string> => {
    const fileName = backupFileName();
    downloadBackup(renderNetscapeHtml(tree), fileName);
    return fileName;
  };

  const organizer = new Organizer({
    bookmarksApi: createChromeBookmarksApi(),
    chat: (args) => chat(args),
    persistJob: persistJobToStorage,
    persistSnapshot: persistSnapshotToStorage,
    loadSnapshot: loadSnapshotFromStorage,
    backup,
    settings: () => settings.value,
  });

  const state = shallowRef<OrganizerState>(organizer.state);
  const unsubscribe = organizer.subscribe((next) => {
    state.value = next;
  });
  onScopeDispose(unsubscribe);

  const job = computed(() => state.value.job);
  const bookmarks = computed(() => state.value.bookmarks);
  const existingFolders = computed(() => state.value.existingFolders);
  const isRunning = computed(() => organizer.isRunning);

  const restoring = ref(true);
  const restoredFromStorage = ref(false);
  void (async () => {
    try {
      restoredFromStorage.value = await organizer.restore(await jobStorage.getValue());
    } catch (e) {
      console.debug('[shelfmark] restore failed', e instanceof Error ? e.message : String(e));
    } finally {
      restoring.value = false;
    }
  })();

  return {
    organizer,
    state,
    job,
    bookmarks,
    existingFolders,
    isRunning,
    restoring,
    restoredFromStorage,
    start: (input?: Partial<JobInput>) => organizer.start(input),
    regenerate: (userHint: string) => organizer.regenerate(userHint),
    cancel: () => organizer.cancel(),
    reset: () => organizer.reset(),
    plannedMoves: () => organizer.plannedMoves(),
    apply: () => organizer.apply(),
    undo: (snapshot?: Snapshot) => organizer.undo(snapshot),
    rollbackInterrupted: (snapshot: Snapshot) => organizer.rollbackInterrupted(snapshot),
    backToReview: () => organizer.backToReview(),
    clearError: () => organizer.clearError(),
  };
}
