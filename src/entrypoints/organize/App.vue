<script lang="ts" setup>
import { computed, ref, watch } from 'vue';
import { browser } from 'wxt/browser';
import DomainHistogram from '@/components/DomainHistogram.vue';
import JobProgress from '@/components/JobProgress.vue';
import ProposalPreview from '@/components/ProposalPreview.vue';
import SeedCategoriesInput from '@/components/SeedCategoriesInput.vue';
import { useBookmarkTree } from '@/composables/useBookmarkTree';
import { useOrganizeJob } from '@/composables/useOrganizeJob';
import { useSettings } from '@/composables/useSettings';
import { domainHistogram, findDuplicates } from '@/lib/ai/sampling';
import { RUNNING_PHASES } from '@/lib/jobs/organizer';
import { listReusableFolders, selectBookmarksInScope, type RootInfo } from '@/lib/bookmarks/tree';

const { tree, loading: treeLoading, error: treeError, reload } = useBookmarkTree();
const { settings, loaded: settingsLoaded, hasApiKey, flush } = useSettings();
const organize = useOrganizeJob(settings);
const { job, bookmarks: jobBookmarks, existingFolders: jobFolders, restoring, organizer } = organize;

// ------------------------------------------------------------------ wizard steps

type Step = 1 | 2 | 3 | 4;
const step = ref<Step>(1);
const phase = computed(() => job.value.phase);
const running = computed(() => RUNNING_PHASES.has(phase.value));

watch(
  phase,
  (next) => {
    if (RUNNING_PHASES.has(next)) step.value = 2;
    else if (next === 'review') step.value = 3;
    else if (next === 'applying' || next === 'done') step.value = 4;
    else step.value = 1;
  },
  { immediate: true },
);

const STEPS: Array<{ n: Step; label: string }> = [
  { n: 1, label: '范围确认' },
  { n: 2, label: '生成中' },
  { n: 3, label: '预览' },
  { n: 4, label: '结果' },
];

// ------------------------------------------------------------------ step 1: scope

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

const seedSuggestions = computed(() =>
  tree.value
    ? scopeRoots.value.flatMap((root) => listReusableFolders(tree.value!, root.id)).map((f) => ({ title: f.title, path: f.path }))
    : [],
);

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
  () => settingsLoaded.value && hasApiKey.value && !treeLoading.value && inScope.value.length > 0 && !running.value && !restoring.value,
);

async function startGenerate(): Promise<void> {
  if (!canStart.value) return;
  // 记住这次的 seeds / hint，下次打开还是这些
  settings.value.seedCategories = [...seeds.value];
  settings.value.userHint = hint.value;
  await flush();
  await organize.start({ seedCategories: seeds.value, userHint: hint.value });
}

// ------------------------------------------------------------------ step 2: progress

const cancelling = ref(false);
async function cancel(): Promise<void> {
  cancelling.value = true;
  try {
    await organize.cancel();
  } finally {
    cancelling.value = false;
  }
}

// ------------------------------------------------------------------ step 3: review

const regenerateHint = ref('');
watch(
  () => job.value.input?.userHint,
  (value) => {
    regenerateHint.value = value ?? '';
  },
  { immediate: true },
);

async function regenerate(): Promise<void> {
  if (running.value) return;
  await organize.regenerate(regenerateHint.value.trim());
}

async function discard(): Promise<void> {
  if (!window.confirm('放弃这次生成的结果？（不会改动任何书签）')) return;
  await organize.reset();
  void reload();
}

const excludedCount = computed(() => job.value.review?.excluded.length ?? 0);

// ------------------------------------------------------------------ step 4: result (round 3)

// 读一下 proposal / review，编辑后才会重新计算（organizer 内部状态本身不是响应式的）
const plannedMoves = computed(() => (job.value.phase === 'review' && job.value.proposal && job.value.review ? organize.plannedMoves() : []));
const plannedFolders = computed(() => {
  const paths = new Set<string>();
  for (const move of plannedMoves.value) if ('toPath' in move) paths.add(move.toPath.join(' / '));
  return [...paths];
});
const applyNote = ref<string | null>(null);

async function apply(): Promise<void> {
  if (!window.confirm(`将移动 ${plannedMoves.value.length} 条书签、新建最多 ${plannedFolders.value.length} 个文件夹。继续？`)) return;
  try {
    await organizer.apply();
  } catch (e) {
    applyNote.value = e instanceof Error ? e.message : String(e);
  }
}

function openOptions(): void {
  void browser.runtime.openOptionsPage();
}
</script>

<template>
  <main class="mx-auto max-w-6xl space-y-5 p-6 text-sm text-gray-800">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-lg font-semibold">Shelfmark 整理</h1>
      <ol class="flex items-center gap-2 text-xs">
        <li v-for="s in STEPS" :key="s.n" class="flex items-center gap-2">
          <span
            class="flex h-5 w-5 items-center justify-center rounded-full"
            :class="step === s.n ? 'bg-gray-900 text-white' : step > s.n ? 'bg-gray-300 text-gray-700' : 'bg-gray-100 text-gray-400'"
          >
            {{ s.n }}
          </span>
          <span :class="step === s.n ? 'font-medium text-gray-900' : 'text-gray-500'">{{ s.label }}</span>
          <span v-if="s.n < 4" class="text-gray-300">—</span>
        </li>
      </ol>
      <button type="button" class="text-xs text-gray-500 underline" @click="openOptions">设置</button>
    </header>

    <p v-if="settingsLoaded && !hasApiKey" class="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800">
      未配置 Key，无法开始整理。
      <button type="button" class="underline" @click="openOptions">去设置</button>
    </p>

    <p v-if="phase === 'error'" class="flex flex-wrap items-center justify-between gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-red-800">
      <span>出错：{{ job.error }}</span>
      <span class="flex gap-2 text-xs">
        <button type="button" class="underline" @click="organize.reset()">清除</button>
      </span>
    </p>

    <!-- 1 · 范围确认 -->
    <section v-if="step === 1" class="space-y-4 rounded border border-gray-200 p-4">
      <h2 class="font-semibold">1 · 范围确认</h2>

      <div class="text-xs text-gray-600">
        <p v-if="treeLoading || restoring">正在读取书签…</p>
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
            <SeedCategoriesInput v-model="seeds" :suggestions="seedSuggestions" :disabled="running" />
          </div>
          <div>
            <h3 class="mb-1 text-xs font-medium text-gray-600">一句话偏好（userHint）</h3>
            <textarea
              v-model="hint"
              rows="3"
              class="w-full rounded border border-gray-300 px-2 py-1"
              placeholder="例：不要按编程语言分；把购物类合并成一个"
              :disabled="running"
            />
          </div>
          <button
            type="button"
            class="rounded bg-gray-900 px-3 py-1.5 text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!canStart"
            @click="startGenerate"
          >
            开始生成
          </button>
          <p class="text-xs text-gray-500">生成阶段只读书签、只发脱敏后的标题与网址；预览确认后才会移动任何书签。</p>
        </div>
      </div>
    </section>

    <!-- 2 · 生成中 -->
    <section v-else-if="step === 2" class="space-y-4 rounded border border-gray-200 p-4">
      <h2 class="font-semibold">2 · 生成中</h2>
      <JobProgress :phase="phase" :done="job.done" :total="job.total" :cancelling="cancelling" @cancel="cancel" />
      <p class="text-xs text-gray-500">
        propose → 分批 assign（每批 {{ settings.batchSize }} 条，{{ settings.concurrency }} 路并发）→ 未分类过多时补一轮类目。取消会丢弃未完成的批次，不写书签。
      </p>
    </section>

    <!-- 3 · 预览 -->
    <section v-else-if="step === 3 && job.proposal && job.review" class="space-y-4 rounded border border-gray-200 p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="font-semibold">3 · 预览</h2>
        <p class="text-xs text-gray-500">
          {{ job.proposal.categories.length }} 个类目 · {{ jobBookmarks.length }} 条书签
          <span v-if="excludedCount > 0"> · 已剔除 {{ excludedCount }}</span>
          <span v-if="job.proposal.warnings.unknownCategory + job.proposal.warnings.missingIndex > 0" class="text-amber-700">
            · 模型输出兜底 {{ job.proposal.warnings.unknownCategory + job.proposal.warnings.missingIndex }} 条
          </span>
          <span v-if="job.skipped.length > 0" class="text-amber-700"> · {{ job.skipped.length }} 条书签已不存在</span>
        </p>
      </div>

      <ProposalPreview
        :proposal="job.proposal"
        :bookmarks="jobBookmarks"
        :review="job.review"
        :existing-folders="jobFolders"
        @set-category="(id, c) => organizer.setCategory(id, c)"
        @merge="(from, into) => organizer.mergeCategories(from, into)"
        @rename="(id, title) => organizer.renameCategory(id, title)"
        @exclude="(id) => organizer.excludeBookmark(id)"
        @include="(id) => organizer.includeBookmark(id)"
        @include-uncategorized="(v) => organizer.setIncludeUncategorized(v)"
        @include-duplicates="(v) => organizer.setIncludeDuplicates(v)"
      />

      <div class="flex flex-wrap items-end justify-between gap-3 border-t border-gray-200 pt-3">
        <div class="min-w-[16rem] flex-1 space-y-1">
          <label class="text-xs text-gray-600" for="regenerate-hint">带提示重新生成（会丢掉当前预览的手动修改）</label>
          <div class="flex gap-2">
            <input
              id="regenerate-hint"
              v-model="regenerateHint"
              type="text"
              class="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1"
              placeholder="例：把购物和生活合并；不要按编程语言分"
              @keydown.enter.prevent="regenerate"
            />
            <button type="button" class="rounded border border-gray-300 px-3 py-1 hover:bg-gray-50" @click="regenerate">重新生成</button>
          </div>
        </div>
        <div class="flex gap-2">
          <button type="button" class="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50" @click="discard">放弃</button>
          <button type="button" class="rounded bg-gray-900 px-3 py-1.5 text-white hover:bg-gray-700" @click="step = 4">下一步：应用</button>
        </div>
      </div>
    </section>

    <!-- 4 · 结果（第 3 轮接 applySnapshot） -->
    <section v-else-if="step === 4" class="space-y-4 rounded border border-gray-200 p-4">
      <h2 class="font-semibold">4 · 应用与结果</h2>
      <div class="text-xs text-gray-600">
        <p>将移动 <span class="font-medium text-gray-800">{{ plannedMoves.length }}</span> 条书签；按路径新建 / 复用文件夹 {{ plannedFolders.length }} 个：</p>
        <ul class="mt-1 flex flex-wrap gap-1">
          <li v-for="path in plannedFolders" :key="path" class="rounded bg-gray-100 px-2 py-0.5">{{ path }}</li>
        </ul>
        <p v-if="settings.autoBackup" class="mt-2">应用前会自动下载 HTML 备份。</p>
      </div>
      <p class="rounded border border-dashed border-gray-300 px-3 py-2 text-xs text-gray-500">
        写入（备份 → snapshot 落盘 → 串行移动 → 撤销栏）在第 3 轮接入；这一步目前只做确认，不会改动书签。
      </p>
      <p v-if="applyNote" class="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">{{ applyNote }}</p>
      <div class="flex gap-2">
        <button type="button" class="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50" @click="step = 3">返回预览</button>
        <button
          type="button"
          class="rounded bg-gray-900 px-3 py-1.5 text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="plannedMoves.length === 0"
          @click="apply"
        >
          应用（第 3 轮）
        </button>
      </div>
    </section>

    <section v-else class="rounded border border-gray-200 p-4 text-xs text-gray-500">正在恢复上次的预览…</section>
  </main>
</template>
