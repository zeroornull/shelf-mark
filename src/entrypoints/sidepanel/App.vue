<script lang="ts" setup>
import { computed, ref } from 'vue';
import { browser } from 'wxt/browser';
import BookmarkTree from '@/components/BookmarkTree.vue';
import { useBookmarkTree } from '@/composables/useBookmarkTree';
import { useHostPermission } from '@/composables/useHostPermission';
import { useSettings } from '@/composables/useSettings';
import type { RootInfo } from '@/lib/bookmarks/tree';

const { tree, loading, error, reload, looseByRoot, totalBookmarks } = useBookmarkTree();
const filter = ref('');

const { settings, loaded: settingsLoaded, hasApiKey } = useSettings();
const baseUrl = computed(() => settings.value.provider.baseUrl);
const { origin, granted: originGranted } = useHostPermission(baseUrl);

/** 未配 Key 时不能开始整理（§13 第一条）。 */
const canOrganize = computed(() => settingsLoaded.value && hasApiKey.value);

/** 只展示会产生散装书签的根；mobile 根按定义没有散装书签。 */
const looseStats = computed(() => looseByRoot.value.filter(({ root }) => root.folderType !== 'mobile'));

/** 同一 folderType 有账号 / 本地两棵树时，用 syncing 区分显示。 */
function rootLabel(root: RootInfo): string {
  const twins = tree.value?.roots.filter((r) => r.folderType === root.folderType) ?? [];
  const title = root.title || root.folderType;
  return twins.length > 1 ? `${title}（${root.syncing ? '账号' : '本地'}）` : title;
}

function openOrganize(): void {
  void browser.tabs.create({ url: browser.runtime.getURL('/organize.html') });
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
          :title="canOrganize ? '' : '先在设置里填 apiKey'"
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
          <span>未配置 Key，无法开始整理。</span>
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

    <section class="border-b border-gray-200 px-3 py-2 text-xs text-gray-600">
      <p v-if="loading">正在读取书签…</p>
      <p v-else-if="error" class="text-red-600">读取书签失败：{{ error }}</p>
      <template v-else>
        <p>共 {{ totalBookmarks }} 条书签</p>
        <ul class="mt-1 space-y-0.5">
          <li v-for="{ root, count } in looseStats" :key="root.id">
            {{ rootLabel(root) }}：<span class="font-medium text-gray-800">{{ count }}</span> 条散装书签
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
