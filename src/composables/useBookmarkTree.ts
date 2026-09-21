import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import { browser } from 'wxt/browser';
import type { BookmarksApi } from '@/lib/bookmarks/api';
import { createChromeBookmarksApi } from '@/lib/bookmarks/api';
import type { BookmarkTree } from '@/lib/bookmarks/tree';
import { countLooseByRoot, readBookmarkTree } from '@/lib/bookmarks/tree';

export type UseBookmarkTreeOptions = {
  /** true → 监听 `bookmarks.onCreated / onRemoved / onMoved / onChanged`，防抖后自动 `reload()`（sidepanel 用）。 */
  live?: boolean;
  /** 防抖间隔，默认 300ms。 */
  debounceMs?: number;
};

/** 读一次书签树，暴露加载状态和各根的散装书签数量；`reload()` 重新读取。 */
export function useBookmarkTree(options: UseBookmarkTreeOptions = {}, api: BookmarksApi = createChromeBookmarksApi()) {
  // 树可能有几千个节点，用 shallowRef 避免深层响应式开销；每次整棵替换。
  const tree = shallowRef<BookmarkTree | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function reload(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      tree.value = await readBookmarkTree(api);
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  const looseByRoot = computed(() => (tree.value ? countLooseByRoot(tree.value) : []));
  const totalBookmarks = computed(() => tree.value?.bookmarks.length ?? 0);

  if (options.live) {
    const debounceMs = options.debounceMs ?? 300;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void reload();
      }, debounceMs);
    };
    const events = [browser.bookmarks.onCreated, browser.bookmarks.onRemoved, browser.bookmarks.onMoved, browser.bookmarks.onChanged];
    for (const event of events) event.addListener(schedule);
    onScopeDispose(() => {
      for (const event of events) event.removeListener(schedule);
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  void reload();

  return { tree, loading, error, reload, looseByRoot, totalBookmarks };
}
