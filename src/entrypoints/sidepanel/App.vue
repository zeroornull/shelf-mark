<script lang="ts" setup>
import { computed, ref } from 'vue';
import { browser } from 'wxt/browser';
import BookmarkTree from '@/components/BookmarkTree.vue';
import UndoBar from '@/components/UndoBar.vue';
import { useBookmarkTree } from '@/composables/useBookmarkTree';
import { useHostPermission } from '@/composables/useHostPermission';
import { focusOrOpenOrganizePage } from '@/composables/useOrganizeTab';
import { useSettings } from '@/composables/useSettings';
import { countSelectedByRoot, selectBookmarksInScope, type RootInfo } from '@/lib/bookmarks/tree';

// live：书签有任何变化（整理页 apply / 撤销、用户手动改）都会防抖刷新树
const { tree, loading, error, reload, totalBookmarks } = useBookmarkTree({ live: true });
const filter = ref('');

const { settings, loaded: settingsLoaded, hasApiKey } = useSettings();
const baseUrl = computed(() => settings.value.provider.baseUrl);
const { origin, granted: originGranted } = useHostPermission(baseUrl);

/** 按域名整理不需要 Key；AI 整理在整理页里再拦。 */
const canOrganize = computed(() => settingsLoaded.value);

/** 按当前整理范围统计各根：总数 / 散装 / 文件夹内。mobile 不进范围。 */
const scopeStats = computed(() => {
  if (!tree.value || !settingsLoaded.value) return [];
  const selected = selectBookmarksInScope(tree.value, settings.value.scope, settings.value.debugLimit, settings.value.includeFoldered ?? true);
  const allowed = settings.value.scope === 'loose-bar-and-other' ? ['bookmarks-bar', 'other'] : ['other'];
  return countSelectedByRoot(tree.value, selected).filter(({ root }) => allowed.includes(root.folderType));
});

/** 同一 folderType 有账号 / 本地两棵树时，用 syncing 区分显示。 */
function rootLabel(root: RootInfo): string {
  const twins = tree.value?.roots.filter((r) => r.folderType === root.folderType) ?? [];
  const title = root.title || root.folderType;
  return twins.length > 1 ? `${title}（${root.syncing ? '账号' : '本地'}）` : title;
}

/** 已有整理页就切过去（同一时间只该有一个整理页在写书签），没有才新开。 */
function openOrganize(): void {
  void focusOrOpenOrganizePage();
}

function openOptions(): void {
  void browser.runtime.openOptionsPage();
}
</script>

<template>
  <main class="flex h-screen flex-col bg-white text-sm text-gray-800">
    <header class="flex items-center justify-between gap-2 border-b border-gray-200 px-3 py-2">
      <h1 class="text-base font-semibold">Shelfmark</h1>
      <div class="flex gap-2">
        <button
          type="button"
          class="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
          @click="openOptions"
        >
          设置
        </button>
        <button
          type="button"
          class="rounded bg-gray-900 px-2 py-1 text-xs text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!canOrganize"
          @click="openOrganize"
        >
          开始整理
        </button>
      </div>
    </header>

    <section class="border-b border-gray-200 px-3 py-2 text-xs">
      <template v-if="!settingsLoaded">
        <p class="text-gray-500">读取设置…</p>
      </template>
      <template v-else-if="!hasApiKey">
        <p class="flex items-center justify-between gap-2 text-amber-800">
          <span>未配置 Key：仍可按域名整理，AI 整理需要先填 Key。</span>
          <button type="button" class="underline hover:text-amber-950" @click="openOptions">去设置</button>
        </p>
      </template>
      <template v-else>
        <p class="flex flex-wrap items-center gap-x-2 text-gray-600">
          <span class="truncate" :title="settings.provider.baseUrl">{{ settings.provider.model || '（未填 model）' }} @ {{ origin ?? settings.provider.baseUrl }}</span>
          <span v-if="originGranted === true" class="text-green-700">已授权</span>
          <span v-else-if="originGranted === false" class="text-amber-700">未授权 origin（去设置页测试连接）</span>
        </p>
      </template>
    </section>

    <UndoBar @changed="reload" />

    <section class="border-b border-gray-200 px-3 py-2 text-xs text-gray-600">
      <p v-if="loading">正在读取书签…</p>
      <p v-else-if="error" class="text-red-600">读取书签失败：{{ error }}</p>
      <template v-else>
        <p>共 {{ totalBookmarks }} 条书签</p>
        <ul class="mt-1 space-y-0.5">
          <li v-for="{ root, total, loose, foldered } in scopeStats" :key="root.id">
            {{ rootLabel(root) }}：共 <span class="font-medium text-gray-800">{{ total }}</span> 条（散装 {{ loose }}，文件夹内 {{ foldered }}）
          </li>
        </ul>
      </template>
    </section>

    <section class="flex items-center gap-2 px-3 py-2">
      <input
        v-model="filter"
        type="search"
        placeholder="过滤标题或网址"
        class="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-xs focus:border-gray-500 focus:outline-none"
      />
      <button
        type="button"
        class="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
        :disabled="loading"
        @click="reload"
      >
        刷新
      </button>
    </section>

    <div class="min-h-0 flex-1 overflow-auto px-1 pb-3">
      <BookmarkTree v-if="tree" :nodes="tree.nodes" :filter="filter" />
    </div>
  </main>
</template>
