import { computed, ref, shallowRef } from 'vue';
import type { BookmarksApi } from '@/lib/bookmarks/api';
import { createChromeBookmarksApi } from '@/lib/bookmarks/api';
import type { BookmarkTree } from '@/lib/bookmarks/tree';
import { countLooseByRoot, readBookmarkTree } from '@/lib/bookmarks/tree';

/** 读一次书签树，暴露加载状态和各根的散装书签数量；`reload()` 重新读取。 */
export function useBookmarkTree(api: BookmarksApi = createChromeBookmarksApi()) {
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

  void reload();

  return { tree, loading, error, reload, looseByRoot, totalBookmarks };
}
