<script lang="ts" setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { browser } from 'wxt/browser';
import DomainHistogram from '@/components/DomainHistogram.vue';
import JobProgress from '@/components/JobProgress.vue';
import ProposalPreview from '@/components/ProposalPreview.vue';
import SeedCategoriesInput from '@/components/SeedCategoriesInput.vue';
import { useBookmarkTree } from '@/composables/useBookmarkTree';
import { useOrganizeJob } from '@/composables/useOrganizeJob';
import { useSettings } from '@/composables/useSettings';
import { useSnapshotRecovery } from '@/composables/useSnapshotRecovery';
import { domainHistogram, findDuplicates } from '@/lib/ai/sampling';
import { describeBookmarkError, describeSkipReason } from '@/lib/bookmarks/errors';
import { countSelectedByRoot, listReusableFolders, selectBookmarksInScope, type RootInfo } from '@/lib/bookmarks/tree';
import { RUNNING_PHASES } from '@/lib/jobs/organizer';
import { describeRestoreSummary, restoreAnomalies } from '@/lib/jobs/recovery';
import { isKeepStillMove } from '@/lib/jobs/resolve';

const { tree, loading: treeLoading, error: treeError, reload } = useBookmarkTree();
const { settings, loaded: settingsLoaded, hasApiKey, flush } = useSettings();
const organize = useOrganizeJob(settings);
const { job, bookmarks: jobBookmarks, existingFolders: jobFolders, restoring, organizer } = organize;
// 持久化 snapshot 的响应式视图：驱动「上次整理被中断」横幅和撤销按钮的可用性。
// excludeSelf：探测「别的」organize 页——多开标签时另一个可能正在 apply，这时不能提供回滚
const recovery = useSnapshotRecovery(undefined, { trackOrganizePage: true, excludeSelf: true });

// ------------------------------------------------------------------ wizard steps

type Step = 1 | 2 | 3 | 4;
const step = ref<Step>(1);
const phase = computed(() => job.value.phase);
const running = computed(() => RUNNING_PHASES.has(phase.value));
const applying = computed(() => phase.value === 'applying');
/** apply 阶段失败 / 取消（proposal 仍在）：留在结果页展示回滚信息，而不是回到第 1 步。 */
const applyFailed = computed(() => phase.value === 'error' && job.value.proposal !== undefined);

watch(
  phase,
  (next) => {
    if (next === 'applying' || next === 'done' || applyFailed.value) step.value = 4;
    else if (RUNNING_PHASES.has(next)) step.value = 2;
    else if (next === 'review') step.value = 3;
    else step.value = 1;
  },
  { immediate: true },
);

const STEPS: Array<{ n: Step; label: string }> = [
  { n: 1, label: '范围确认' },
  { n: 2, label: '生成中' },
  { n: 3, label: '预览' },
  { n: 4, label: '应用与结果' },
];

// ------------------------------------------------------------------ §5.3 中断保护：applying 期间挂 beforeunload

function onBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = '';
}
watch(
  applying,
  (active) => {
    if (active) window.addEventListener('beforeunload', onBeforeUnload);
    else window.removeEventListener('beforeunload', onBeforeUnload);
  },
  { immediate: true },
);
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));

// ------------------------------------------------------------------ 中断横幅：上次 apply 没跑完（snapshot 仍是 applying）

const showInterrupted = computed(() => recovery.interrupted.value && !applying.value && !restoring.value);
/** 确认没有别的 organize 页在写，才能回滚；'open' / 'unknown' / 未查完 → 只显示中性提示。 */
const canRollbackHere = computed(() => showInterrupted.value && recovery.canRollback.value);
const otherOrganizeNote = computed(() => {
  if (!showInterrupted.value || canRollbackHere.value) return null;
  const counts = `已移动 ${recovery.appliedCount.value}/${recovery.totalCount.value}`;
  if (recovery.organizePresence.value === 'open') return `另一个整理页正在处理这次整理（${counts}）。请在那个页面继续或回滚，不要在这里重复操作。`;
  if (recovery.organizePresence.value === 'unknown') return `无法确认是否有其他整理页在处理（${counts}）。请先关闭其他整理页，再刷新本页回滚。`;
  return `正在检查是否有其他整理页在处理（${counts}）…`;
});
const rollbackBusy = ref(false);
const rollbackNote = ref<{ ok: boolean; text: string } | null>(null);

async function rollbackInterrupted(): Promise<void> {
  const snapshot = recovery.snapshot.value;
  if (!snapshot || rollbackBusy.value || !canRollbackHere.value) return;
  if (!window.confirm(`回滚被中断的整理，把已移动的 ${snapshot.applied.length} 条书签移回原位置？`)) return;
  rollbackBusy.value = true;
  rollbackNote.value = null;
  try {
    const summary = await organize.rollbackInterrupted(snapshot);
    rollbackNote.value = { ok: true, text: `上次整理已回滚，${describeRestoreSummary(summary, '恢复')}` };
    void reload();
  } catch (e) {
    rollbackNote.value = { ok: false, text: describeBookmarkError(e) };
  } finally {
    rollbackBusy.value = false;
  }
}

// ------------------------------------------------------------------ 顶部错误条

/** error 阶段的文案在第 4 步自己展示；其余阶段附带的提示（例如备份失败回到 review）显示在这里。 */
const bannerError = computed(() => {
  if (phase.value === 'error') return step.value === 4 ? null : (job.value.error ?? '未知错误');
  return job.value.error ?? null;
});

function dismissError(): void {
  if (phase.value === 'error') void organize.reset();
  else organize.clearError();
}

// ------------------------------------------------------------------ step 1: scope

const includeFoldered = ref(true);
watch(
  [settingsLoaded, () => settings.value.includeFoldered],
  ([loaded]) => {
    if (!loaded) return;
    includeFoldered.value = settings.value.includeFoldered ?? true;
  },
  { immediate: true },
);

const inScope = computed(() =>
  tree.value ? selectBookmarksInScope(tree.value, settings.value.scope, settings.value.debugLimit, includeFoldered.value) : [],
);

const scopeRoots = computed<RootInfo[]>(() => {
  if (!tree.value) return [];
  const allowed = settings.value.scope === 'loose-bar-and-other' ? ['bookmarks-bar', 'other'] : ['other'];
  return tree.value.roots.filter((root) => allowed.includes(root.folderType));
});

const countByRoot = computed(() => {
  if (!tree.value) return [];
  const byId = new Map(countSelectedByRoot(tree.value, inScope.value).map((row) => [row.root.id, row]));
  return scopeRoots.value.map((root) => byId.get(root.id) ?? { root, total: 0, loose: 0, foldered: 0 });
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
  settings.value.includeFoldered = includeFoldered.value;
  await flush();
  await organize.start({ seedCategories: seeds.value, userHint: hint.value, includeFoldered: includeFoldered.value });
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

// ------------------------------------------------------------------ step 4: apply

// 读一下 proposal / review，编辑后才会重新计算（organizer 内部状态本身不是响应式的）
const plannedMoves = computed(() => (phase.value === 'review' && job.value.proposal && job.value.review ? organize.plannedMoves() : []));
const keepStillMoves = computed(() => plannedMoves.value.filter(isKeepStillMove));
const movingMoves = computed(() => plannedMoves.value.filter((move) => !isKeepStillMove(move)));
const keepStillIds = computed(() => new Set(keepStillMoves.value.map((move) => move.bookmarkId)));
const keepStillSkipped = computed(() => job.value.skipped.filter((s) => s.reason === 'same-parent'));
const emptiedFolders = computed(() => job.value.emptiedFolders ?? []);
const plannedFolders = computed(() => {
  const folderPath = new Map(jobFolders.value.map((f) => [f.id, f.path]));
  const paths = new Set<string>();
  for (const move of plannedMoves.value) {
    if (!('toPath' in move)) continue;
    // 以已有文件夹为起点的子类目：显示完整路径「已有 / 子类目」
    const base = move.baseParentId !== undefined ? (folderPath.get(move.baseParentId) ?? []) : [];
    paths.add([...base, ...move.toPath].join(' / '));
  }
  return [...paths];
});
const applyBusy = ref(false);
const applyNote = ref<string | null>(null);

async function apply(): Promise<void> {
  if (applyBusy.value || movingMoves.value.length === 0) return;
  const backupNote = settings.value.autoBackup ? '应用前会先下载一份 HTML 备份。' : '注意：已在设置中关闭自动备份。';
  const keepNote = keepStillMoves.value.length > 0 ? `，保持不动 ${keepStillMoves.value.length} 条` : '';
  if (!window.confirm(`将移动 ${movingMoves.value.length} 条书签${keepNote}、新建最多 ${plannedFolders.value.length} 个文件夹。${backupNote}\n继续？`)) return;
  applyBusy.value = true;
  applyNote.value = null;
  try {
    await organize.apply();
  } catch (e) {
    applyNote.value = describeBookmarkError(e);
  } finally {
    applyBusy.value = false;
  }
}

/** applying 阶段的取消 = 停止后续 move 并回滚已移动的（§7），本身就是危险操作，也要确认。 */
async function cancelApply(): Promise<void> {
  if (cancelling.value) return;
  if (!window.confirm(`停止应用，并把已移动的 ${job.value.done} 条书签移回原位置？`)) return;
  cancelling.value = true;
  try {
    await organize.cancel();
  } finally {
    cancelling.value = false;
  }
}

// ------------------------------------------------------------------ step 4: result / undo

const skippedRows = computed(() => {
  const titles = new Map(jobBookmarks.value.map((b) => [b.id, b.title]));
  return job.value.skipped
    .filter((s) => s.reason !== 'same-parent')
    .map((s) => ({ ...s, title: titles.get(s.bookmarkId) ?? s.bookmarkId, text: describeSkipReason(s.reason) }));
});

/** 当前持久化的 snapshot 是否就是本次 apply 产生的那份。 */
const snapshotMatches = computed(() => job.value.snapshotId !== undefined && recovery.snapshot.value?.id === job.value.snapshotId);
const snapshotStatus = computed(() => (snapshotMatches.value ? recovery.snapshot.value?.status : undefined));
const undoBusy = ref(false);
const undoNote = ref<string | null>(null);
const canUndo = computed(() => phase.value === 'done' && snapshotStatus.value === 'applied' && !undoBusy.value && !job.value.restore);

async function undo(): Promise<void> {
  if (!canUndo.value) return;
  if (!window.confirm(`撤销这次整理，把 ${job.value.done} 条书签移回原位置？\n新建的空文件夹会被删除，里面有你手动添加内容的会保留。`)) return;
  undoBusy.value = true;
  undoNote.value = null;
  try {
    await organize.undo();
    void reload();
  } catch (e) {
    undoNote.value = describeBookmarkError(e);
  } finally {
    undoBusy.value = false;
  }
}

async function backToReview(): Promise<void> {
  try {
    await organize.backToReview();
  } catch (e) {
    applyNote.value = describeBookmarkError(e);
  }
}

/** 再次整理：清掉 job（snapshot 保留，仍可在 sidepanel 撤销），回到第 1 步并重读树。 */
async function startOver(): Promise<void> {
  await organize.reset();
  applyNote.value = null;
  undoNote.value = null;
  void reload();
}

async function finish(): Promise<void> {
  await organize.reset();
  window.close();
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

    <!-- snapshot 仍是 applying，但另一个整理页可能正在写：只提示，不给回滚 -->
    <p v-if="otherOrganizeNote" class="rounded border border-gray-300 bg-gray-50 px-3 py-2 text-gray-700">{{ otherOrganizeNote }}</p>

    <!-- 上次整理被中断（snapshot 仍是 applying，且没有别的整理页开着）：先回滚 -->
    <section v-else-if="canRollbackHere && recovery.snapshot.value" class="space-y-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
      <p class="flex flex-wrap items-center justify-between gap-2">
        <span>
          上次整理被中断，已移动 <span class="font-medium tabular-nums">{{ recovery.appliedCount.value }}/{{ recovery.totalCount.value }}</span>
          条书签。建议先回滚到整理前的状态，再开始新的整理。
        </span>
        <button
          type="button"
          class="rounded border border-amber-400 bg-white px-3 py-1 hover:bg-amber-100 disabled:opacity-50"
          :disabled="rollbackBusy"
          @click="rollbackInterrupted"
        >
          {{ rollbackBusy ? '回滚中…' : '回滚' }}
        </button>
      </p>
      <p v-if="rollbackNote && !rollbackNote.ok" class="text-xs text-red-700">{{ rollbackNote.text }}</p>
    </section>
    <p v-else-if="rollbackNote?.ok" class="flex items-center justify-between gap-2 rounded border border-green-300 bg-green-50 px-3 py-2 text-green-800">
      <span>{{ rollbackNote.text }}</span>
      <button type="button" class="text-xs underline" @click="rollbackNote = null">关闭</button>
    </p>

    <p v-if="settingsLoaded && !hasApiKey" class="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800">
      未配置 Key，无法开始整理。
      <button type="button" class="underline" @click="openOptions">去设置</button>
    </p>

    <p v-if="bannerError" class="flex flex-wrap items-center justify-between gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-red-800">
      <span>{{ phase === 'error' ? '出错：' : '' }}{{ bannerError }}</span>
      <span class="flex gap-2 text-xs">
        <button type="button" class="underline" @click="dismissError">清除</button>
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
            范围：<span class="font-medium text-gray-800">{{ settings.scope === 'loose-other' ? '「其他书签」' : '「其他书签」+ 书签栏' }}</span>
            <span v-if="settings.debugLimit"> · debugLimit = {{ settings.debugLimit }}</span>
            <button type="button" class="ml-2 underline" @click="openOptions">修改根范围</button>
          </p>
          <label class="mt-2 flex items-start gap-2">
            <input v-model="includeFoldered" type="checkbox" class="mt-0.5" :disabled="running" />
            <span>
              包含已在文件夹中的书签
              <span class="block text-gray-500">关闭时只整理根目录下的散装书签</span>
            </span>
          </label>
          <ul class="mt-1 space-y-0.5">
            <li v-for="{ root, total, loose, foldered } in countByRoot" :key="root.id">
              {{ rootLabel(root) }}：共 <span class="font-medium text-gray-800">{{ total }}</span> 条（散装 {{ loose }}，文件夹内 {{ foldered }}）
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
          <p class="text-xs text-gray-500">生成阶段只读书签、只发脱敏后的标题与网址；预览确认后才会移动任何书签。这里改的类目 / 偏好会保存为默认值。</p>
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
          <span v-if="keepStillMoves.length > 0"> · 保持不动 {{ keepStillMoves.length }}</span>
          <span v-if="job.proposal.warnings.unknownCategory + job.proposal.warnings.missingIndex > 0" class="text-amber-700">
            · 模型输出兜底 {{ job.proposal.warnings.unknownCategory + job.proposal.warnings.missingIndex }} 条
          </span>
          <span v-if="job.skipped.length > 0" class="text-amber-700" :title="skippedRows.map((r) => `${r.title}：${r.text}`).join('\n')">
            · {{ job.skipped.length }} 条已跳过（已删除 / 已被归档）
          </span>
        </p>
      </div>

      <ProposalPreview
        :proposal="job.proposal"
        :bookmarks="jobBookmarks"
        :review="job.review"
        :existing-folders="jobFolders"
        :keep-still-ids="keepStillIds"
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

    <!-- 4 · 应用与结果 -->
    <section v-else-if="step === 4" class="space-y-4 rounded border border-gray-200 p-4">
      <h2 class="font-semibold">4 · 应用与结果</h2>

      <!-- 4a · 应用前确认 -->
      <template v-if="phase === 'review'">
        <div class="text-xs text-gray-600">
          <p>
            将移动 <span class="font-medium text-gray-800">{{ movingMoves.length }}</span> 条书签
            <template v-if="keepStillMoves.length > 0">，保持不动 {{ keepStillMoves.length }} 条</template>
            ；按路径新建 / 复用文件夹 {{ plannedFolders.length }} 个：
          </p>
          <ul class="mt-1 flex flex-wrap gap-1">
            <li v-for="path in plannedFolders" :key="path" class="rounded bg-gray-100 px-2 py-0.5">{{ path }}</li>
          </ul>
          <p class="mt-2">
            <template v-if="settings.autoBackup">应用前会自动下载 HTML 备份（可在 Chrome 书签管理器里导入）。</template>
            <template v-else><span class="text-amber-700">已在设置中关闭自动备份。</span></template>
            应用过程中请不要关闭此页；应用完成后可一键撤销。
          </p>
        </div>
        <p v-if="applyNote" class="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">{{ applyNote }}</p>
        <div class="flex gap-2">
          <button type="button" class="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50" :disabled="applyBusy" @click="step = 3">返回预览</button>
          <button
            type="button"
            class="rounded bg-gray-900 px-3 py-1.5 text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="movingMoves.length === 0 || applyBusy"
            @click="apply"
          >
            {{ applyBusy ? '应用中…' : '应用' }}
          </button>
        </div>
      </template>

      <!-- 4b · 应用中 -->
      <template v-else-if="phase === 'applying'">
        <JobProgress :phase="phase" :done="job.done" :total="job.total" :cancelling="cancelling" @cancel="cancelApply" />
        <p class="text-xs text-gray-600">
          <template v-if="job.backupFileName">已下载备份：<span class="font-mono">{{ job.backupFileName }}</span>。</template>
          正在串行移动书签，每移动一条都会记入日志；请不要关闭此页。取消会停在下一条之前，并把已移动的书签移回原位置。
        </p>
      </template>

      <!-- 4c · 完成 -->
      <template v-else-if="phase === 'done'">
        <div class="space-y-1 text-xs text-gray-700">
          <p class="text-sm text-gray-900">
            已移动 <span class="font-medium">{{ job.done }}</span> 条书签
            <span v-if="keepStillSkipped.length > 0">，保持不动 {{ keepStillSkipped.length }} 条</span>
            <span v-if="skippedRows.length > 0">，跳过 {{ skippedRows.length }} 条</span>。
          </p>
          <p>
            <template v-if="job.backupFileName">已下载备份：<span class="font-mono">{{ job.backupFileName }}</span></template>
            <template v-else-if="settings.autoBackup">未备份</template>
            <template v-else>未备份（已在设置中关闭）</template>
          </p>
        </div>

        <p v-if="emptiedFolders.length > 0" class="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {{ emptiedFolders.length }} 个原有文件夹已空，可手动删除：{{ emptiedFolders.map((f) => f.path.join('/')).join('、') }}
        </p>

        <details v-if="skippedRows.length > 0" class="text-xs">
          <summary class="cursor-pointer text-gray-600">跳过的 {{ skippedRows.length }} 条（未移动）</summary>
          <ul class="mt-1 space-y-0.5 text-gray-600">
            <li v-for="row in skippedRows" :key="row.bookmarkId">
              <span class="text-gray-800">{{ row.title }}</span> — {{ row.text }}
            </li>
          </ul>
        </details>

        <p v-if="job.restore" class="rounded border border-green-300 bg-green-50 px-3 py-2 text-xs text-green-800">
          {{ describeRestoreSummary(job.restore, '已恢复') }}
        </p>
        <p v-else-if="snapshotStatus === 'undone'" class="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          这次整理已在其他页面撤销。
        </p>
        <p v-else-if="snapshotStatus === undefined && recovery.loaded.value" class="rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
          找不到这次整理的 snapshot（可能已被新的整理覆盖），无法在这里撤销。
        </p>
        <p v-if="undoNote" class="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">{{ undoNote }}</p>

        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded border border-red-300 px-3 py-1.5 text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!canUndo"
            @click="undo"
          >
            {{ undoBusy ? '撤销中…' : '撤销' }}
          </button>
          <button type="button" class="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50" @click="startOver">再次整理</button>
          <button type="button" class="rounded bg-gray-900 px-3 py-1.5 text-white hover:bg-gray-700" @click="finish">完成</button>
        </div>
      </template>

      <!-- 4d · 失败 / 取消（已回滚） -->
      <template v-else-if="applyFailed">
        <p class="rounded border border-red-300 bg-red-50 px-3 py-2 text-red-800">{{ job.error }}</p>
        <div class="space-y-1 text-xs text-gray-700">
          <p v-if="job.restore">
            尚未移动的 {{ job.total - job.done }} 条书签保持原状<template v-for="text in restoreAnomalies(job.restore)" :key="text">；{{ text }}</template>。
          </p>
          <p v-if="job.backupFileName">已下载备份：<span class="font-mono">{{ job.backupFileName }}</span></p>
        </div>
        <details v-if="skippedRows.length > 0" class="text-xs">
          <summary class="cursor-pointer text-gray-600">校验时跳过的 {{ skippedRows.length }} 条</summary>
          <ul class="mt-1 space-y-0.5 text-gray-600">
            <li v-for="row in skippedRows" :key="row.bookmarkId">
              <span class="text-gray-800">{{ row.title }}</span> — {{ row.text }}
            </li>
          </ul>
        </details>
        <p v-if="applyNote" class="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">{{ applyNote }}</p>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50" @click="backToReview">返回预览</button>
          <button type="button" class="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-50" @click="startOver">再次整理</button>
        </div>
      </template>
    </section>

    <section v-else class="rounded border border-gray-200 p-4 text-xs text-gray-500">正在恢复上次的预览…</section>
  </main>
</template>
