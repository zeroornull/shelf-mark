import { computed, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { createChatFn, type ChatFn } from '@/lib/ai/client';
import { createChromeBookmarksApi } from '@/lib/bookmarks/api';
import { Organizer, type OrganizerState } from '@/lib/jobs/organizer';
import { jobStorage, persistJobToStorage } from '@/lib/jobs/store';
import type { JobInput, Settings } from '@/lib/types';

/**
 * 把 `Organizer` 接到真实环境：Chrome 书签 API、真实 `chatJson`、`local:job`、当前设置。
 * 页面加载时从 `local:job` 恢复（review 阶段不重打模型）。
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

  const organizer = new Organizer({
    bookmarksApi: createChromeBookmarksApi(),
    chat: (args) => chat(args),
    persistJob: persistJobToStorage,
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
  };
}
