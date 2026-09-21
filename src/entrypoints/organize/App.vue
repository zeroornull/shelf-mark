<script lang="ts" setup>
import { computed, ref, watch } from 'vue';
import { browser } from 'wxt/browser';
import DomainHistogram from '@/components/DomainHistogram.vue';
import SeedCategoriesInput from '@/components/SeedCategoriesInput.vue';
import { useBookmarkTree } from '@/composables/useBookmarkTree';
import { useSettings } from '@/composables/useSettings';
import { createChatFn, describeAiError } from '@/lib/ai/client';
import { detectLanguage, domainHistogram, findDuplicates } from '@/lib/ai/sampling';
import { proposeTaxonomy } from '@/lib/ai/taxonomy';
import { listReusableFolders, selectBookmarksInScope, type RootInfo } from '@/lib/bookmarks/tree';
import type { Category } from '@/lib/types';

const { tree, loading: treeLoading, error: treeError, reload } = useBookmarkTree();
const { settings, loaded: settingsLoaded, hasApiKey, flush } = useSettings();

/** 第 1 步：范围确认。整理范围按 settings.scope / debugLimit 选，与将来 organizer 里的选择一致。 */
const inScope = computed(() =>
  tree.value ? selectBookmarksInScope(tree.value, settings.value.scope, settings.value.debugLimit) : [],
);

const scopeRoots = computed<RootInfo[]>(() => {
  if (!tree.value) return [];
  const allowed = settings.value.scope === 'loose-bar-and-other' ? ['bookmarks-bar', 'other'] : ['other'];
  return tree.value.roots.filter((root) => allowed.includes(root.folderType));
});

const countByRoot = computed(() => {
  const counts = new Map<string, number>();
  for (const bookmark of inScope.value) counts.set(bookmark.rootId, (counts.get(bookmark.rootId) ?? 0) + 1);
  return scopeRoots.value.map((root) => ({ root, count: counts.get(root.id) ?? 0 }));
});

function rootLabel(root: RootInfo): string {
  const twins = tree.value?.roots.filter((r) => r.folderType === root.folderType) ?? [];
  const title = root.title || root.folderType;
  return twins.length > 1 ? `${title}（${root.syncing ? '账号' : '本地'}）` : title;
}

const histogram = computed(() => domainHistogram(inScope.value));
const duplicates = computed(() => findDuplicates(inScope.value));

/** 可复用文件夹（各根合并，SeedCategoriesInput 会按标题去重）。 */
const existingFolders = computed(() =>
  tree.value ? scopeRoots.value.flatMap((root) => listReusableFolders(tree.value!, root.id)) : [],
);
const seedSuggestions = computed(() => existingFolders.value.map((f) => ({ title: f.title, path: f.path })));

const seeds = ref<string[]>([]);
const hint = ref('');
watch(
  settingsLoaded,
  (loaded) => {
    if (!loaded) return;
    seeds.value = [...settings.value.seedCategories];
    hint.value = settings.value.userHint;
  },
  { immediate: true },
);

const canStart = computed(
  () => settingsLoaded.value && hasApiKey.value && !treeLoading.value && inScope.value.length > 0 && !generating.value,
);

// M3：只跑 propose，把类目列出来（归类 / 预览 / 状态机在 M4 接入）
const generating = ref(false);
const generateError = ref<string | null>(null);
const categories = ref<Category[] | null>(null);

async function startGenerate(): Promise<void> {
  if (!canStart.value || !tree.value) return;
  generating.value = true;
  generateError.value = null;
  categories.value = null;
  try {
    settings.value.seedCategories = [...seeds.value];
    settings.value.userHint = hint.value;
    await flush();

    const language =
      settings.value.language === 'auto' ? detectLanguage(inScope.value.map((b) => b.title)) : settings.value.language;
    const result = await proposeTaxonomy(
      {
        bookmarks: inScope.value,
        existingFolders: existingFolders.value,
        seedCategories: seeds.value,
        userHint: hint.value,
        maxDepth: settings.value.maxDepth,
        language,
      },
      { chat: createChatFn(settings.value.provider) },
    );
    categories.value = result.categories;
  } catch (e) {
    generateError.value = describeAiError(e);
  } finally {
    generating.value = false;
  }
}

const categoryTree = computed(() => {
  const list = categories.value ?? [];
  const children = new Map<string, Category[]>();
  for (const c of list) {
    if (c.parentId === undefined) continue;
    const bucket = children.get(c.parentId) ?? [];
    bucket.push(c);
    children.set(c.parentId, bucket);
  }
  return list.filter((c) => c.parentId === undefined).map((c) => ({ category: c, children: children.get(c.id) ?? [] }));
});

const folderTitleById = computed(() => new Map(existingFolders.value.map((f) => [f.id, f.path.join(' / ')])));

function openOptions(): void {
  void browser.runtime.openOptionsPage();
}
</script>

<template>
  <main class="mx-auto max-w-5xl space-y-6 p-6 text-sm text-gray-800">
    <header class="flex items-baseline justify-between">
      <h1 class="text-lg font-semibold">Shelfmark 整理</h1>
      <button type="button" class="text-xs text-gray-500 underline" @click="openOptions">设置</button>
    </header>

    <p v-if="settingsLoaded && !hasApiKey" class="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800">
      未配置 Key，无法开始整理。
      <button type="button" class="underline" @click="openOptions">去设置</button>
    </p>

    <section class="space-y-4 rounded border border-gray-200 p-4">
      <h2 class="font-semibold">1 · 范围确认</h2>

      <div class="text-xs text-gray-600">
        <p v-if="treeLoading">正在读取书签…</p>
        <p v-else-if="treeError" class="text-red-600">
          读取书签失败：{{ treeError }}
          <button type="button" class="ml-2 underline" @click="reload">重试</button>
        </p>
        <template v-else>
          <p>
            范围：<span class="font-medium text-gray-800">{{ settings.scope === 'loose-other' ? '「其他书签」里的散装书签' : '「其他书签」+ 书签栏的散装书签' }}</span>
            <span v-if="settings.debugLimit"> · debugLimit = {{ settings.debugLimit }}</span>
            <button type="button" class="ml-2 underline" @click="openOptions">修改</button>
          </p>
          <ul class="mt-1 space-y-0.5">
            <li v-for="{ root, count } in countByRoot" :key="root.id">
              {{ rootLabel(root) }}：将处理 <span class="font-medium text-gray-800">{{ count }}</span> 条散装书签
            </li>
          </ul>
          <p class="mt-1">
            合计 <span class="font-medium text-gray-800">{{ inScope.length }}</span> 条；重复 URL
            <span class="font-medium text-gray-800">{{ duplicates.length }}</span> 组（只展示，默认不移动）
          </p>
        </template>
      </div>

      <div v-if="!treeLoading && inScope.length > 0" class="grid gap-4 md:grid-cols-2">
        <div>
          <h3 class="mb-2 text-xs font-medium text-gray-600">域名分布（前 30）</h3>
          <DomainHistogram :entries="histogram" :limit="30" />
        </div>
        <div class="space-y-3">
          <div>
            <h3 class="mb-1 text-xs font-medium text-gray-600">预填顶层类目（seedCategories）</h3>
            <SeedCategoriesInput v-model="seeds" :suggestions="seedSuggestions" :disabled="generating" />
          </div>
          <div>
            <h3 class="mb-1 text-xs font-medium text-gray-600">一句话偏好（userHint）</h3>
            <textarea
              v-model="hint"
              rows="3"
              class="w-full rounded border border-gray-300 px-2 py-1"
              placeholder="例：不要按编程语言分；把购物类合并成一个"
              :disabled="generating"
            />
          </div>
          <button
            type="button"
            class="rounded bg-gray-900 px-3 py-1.5 text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!canStart"
            @click="startGenerate"
          >
            {{ generating ? '生成中…' : '开始生成' }}
          </button>
        </div>
      </div>
    </section>

    <section v-if="generateError || categories" class="space-y-3 rounded border border-gray-200 p-4">
      <h2 class="font-semibold">类目预览</h2>
      <p v-if="generateError" class="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">{{ generateError }}</p>
      <ul v-else class="space-y-1">
        <li v-for="{ category, children } in categoryTree" :key="category.id">
          <span class="font-medium">{{ category.title }}</span>
          <span class="ml-1 text-xs text-gray-400">{{ category.id }}</span>
          <span v-if="category.existingFolderId" class="ml-1 rounded bg-blue-50 px-1 text-xs text-blue-700" :title="folderTitleById.get(category.existingFolderId)">复用已有</span>
          <ul v-if="children.length > 0" class="ml-4 mt-0.5 space-y-0.5">
            <li v-for="child in children" :key="child.id">
              {{ child.title }}
              <span class="ml-1 text-xs text-gray-400">{{ child.id }}</span>
              <span v-if="child.existingFolderId" class="ml-1 rounded bg-blue-50 px-1 text-xs text-blue-700">复用已有</span>
            </li>
          </ul>
        </li>
      </ul>
      <p v-if="categories" class="text-xs text-gray-500">共 {{ categories.length }} 个类目。批量归类与预览编辑在下一步接入。</p>
    </section>
  </main>
</template>
