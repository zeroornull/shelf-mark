<script lang="ts" setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { browser } from 'wxt/browser';
import DomainHistogram from '@/components/DomainHistogram.vue';
import JobProgress from '@/components/JobProgress.vue';
import ProposalPreview from '@/components/ProposalPreview.vue';
import ThemeSeedPicker from '@/components/ThemeSeedPicker.vue';
import { useBookmarkTree } from '@/composables/useBookmarkTree';
import { useOrganizeJob } from '@/composables/useOrganizeJob';
import { useSettings } from '@/composables/useSettings';
import { useSnapshotRecovery } from '@/composables/useSnapshotRecovery';
import { domainHistogram, findDuplicates } from '@/lib/ai/sampling';
import { describeBookmarkError, describeSkipReason } from '@/lib/bookmarks/errors';
import { countSelectedByRoot, listReusableFolders, selectBookmarksInScope, type RootInfo } from '@/lib/bookmarks/tree';
import { ALL_DOMAINS_MIN_COUNT, isThematicFolder } from '@/lib/domain-sort';
import { RUNNING_PHASES } from '@/lib/jobs/organizer';
import { describeRestoreSummary, restoreAnomalies } from '@/lib/jobs/recovery';
import { formatFolderPath } from '@/lib/bookmarks/tree';
import { isKeepStillMove, listApplyCandidates } from '@/lib/jobs/resolve';

const { tree, loading: treeLoading, error: treeError, reload } = useBookmarkTree();
const { settings, loaded: settingsLoaded, hasApiKey, flush } = useSettings();
const organize = useOrganizeJob(settings);
const { job, bookmarks: jobBookmarks, existingFolders: jobFolders, roots: jobRoots, restoring, organizer } = organize;
// 持久化 snapshot 的响应式视图：驱动「上次整理被中断」横幅和撤销按钮的可用性。
// excludeSelf：探测「别的」organize 页——多开标签时另一个可能正在 apply，这时不能提供回滚
const recovery = useSnapshotRecovery(undefined, { trackOrganizePage: true, excludeSelf: true });

// ------------------------------------------------------------------ wizard steps

type Screen = 'scope' | 'working' | 'review' | 'result';
const phase = computed(() => job.value.phase);
const running = computed(() => RUNNING_PHASES.has(phase.value));
const applying = computed(() => phase.value === 'applying');
/** apply 阶段失败 / 取消（proposal 仍在）：留在结果页展示回滚信息，而不是回到第 1 步。 */
const applyFailed = computed(() => phase.value === 'error' && job.value.proposal !== undefined);

const screen = computed<Screen>(() => {
  if (phase.value === 'applying' || phase.value === 'done' || applyFailed.value) return 'result';
  if (phase.value === 'review') return 'review';
  if (RUNNING_PHASES.has(phase.value)) return 'working';
  return 'scope';
});

const STEPS: Array<{ id: Screen; label: string }> = [
  { id: 'scope', label: '选择方式' },
  { id: 'review', label: '核对变化' },
  { id: 'result', label: '完成' },
];
const stepIndex = computed(() => {
  if (screen.value === 'scope') return 0;
  if (screen.value === 'working' || screen.value === 'review') return 1;
  return 2;
});

const isDomainJob = computed(() => job.value.input?.mode === 'domain');
const methodLabel = computed(() => (isDomainJob.value ? '按域名整理' : 'AI 整理'));
const showCategoryEditor = ref(false);
const showDevBar = computed(() => import.meta.env.DEV || settings.value.debugLimit !== undefined);

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

/** error 阶段的文案在结果页自己展示；其余阶段附带的提示（例如备份失败回到 review）显示在这里。 */
const bannerError = computed(() => {
  if (phase.value === 'error') return screen.value === 'result' ? null : (job.value.error ?? '未知错误');
  return job.value.error ?? null;
});

function dismissError(): void {
  if (phase.value === 'error') void organize.reset();
  else organize.clearError();
}

// ------------------------------------------------------------------ step 1: scope

const includeFoldered = ref(true);
const keepThematic = ref(true);
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

const scopeLabel = computed(() =>
  settings.value.scope === 'loose-other' ? '「其他书签」' : '「其他书签」和书签栏',
);
const canStartDomain = computed(
  () => settingsLoaded.value && !treeLoading.value && inScope.value.length > 0 && !running.value && !restoring.value,
);
const canStartAi = computed(() => canStartDomain.value && hasApiKey.value);

const domainFolderCount = computed(() => histogram.value.filter((row) => row.domain.includes('.') || row.domain === 'localhost').length);
const thematicInScope = computed(() => (includeFoldered.value ? inScope.value.filter(isThematicFolder).length : 0));

async function persistScopeDefaults(): Promise<void> {
  settings.value.seedCategories = [...seeds.value];
  settings.value.userHint = hint.value;
  settings.value.includeFoldered = includeFoldered.value;
  settings.value.domainMinCount = ALL_DOMAINS_MIN_COUNT;
  await flush();
}

async function startDomain(): Promise<void> {
  if (!canStartDomain.value) return;
  await persistScopeDefaults();
  await organize.start({
    seedCategories: seeds.value,
    userHint: hint.value,
    includeFoldered: includeFoldered.value,
    mode: 'domain',
    domainMinCount: ALL_DOMAINS_MIN_COUNT,
    keepThematic: keepThematic.value,
  });
}

async function startGenerate(): Promise<void> {
  if (!canStartAi.value) return;
  await persistScopeDefaults();
  await organize.start({
    seedCategories: seeds.value,
    userHint: hint.value,
    includeFoldered: includeFoldered.value,
    mode: 'ai',
  });
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
  if (job.value.input?.mode === 'domain') {
    await organize.start({
      seedCategories: job.value.input.seedCategories,
      userHint: job.value.input.userHint,
      includeFoldered: includeFoldered.value,
      mode: 'domain',
      domainMinCount: ALL_DOMAINS_MIN_COUNT,
      keepThematic: keepThematic.value,
    });
    return;
  }
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
const bookmarkById = computed(() => new Map(jobBookmarks.value.map((b) => [b.id, b])));
const keepStillMoves = computed(() =>
  plannedMoves.value.filter((move) => isKeepStillMove(move, bookmarkById.value.get(move.bookmarkId))),
);
const movingMoves = computed(() => plannedMoves.value.filter((move) => !isKeepStillMove(move)));
const keepStillIds = computed(() => new Set(keepStillMoves.value.map((move) => move.bookmarkId)));
const keepStillSkipped = computed(() => job.value.skipped.filter((s) => s.reason === 'same-parent'));
const emptiedFolders = computed(() => job.value.emptiedFolders ?? []);
const heldBack = computed(() => job.value.heldBack ?? []);
const applyCandidates = computed(() => {
  if (phase.value !== 'review' || !job.value.proposal || !job.value.review) return [];
  const rootByFolder = new Map(jobFolders.value.map((f) => [f.id, f.rootId]));
  const folderPath = new Map(jobFolders.value.map((f) => [f.id, f.path]));
  const rootTitle = new Map(jobRoots.value.map((r) => [r.id, r.title.trim() || r.folderType]));
  return listApplyCandidates({
    proposal: job.value.proposal,
    review: job.value.review,
    bookmarks: jobBookmarks.value,
    folderRoot: (id) => rootByFolder.get(id),
    origins: job.value.origins,
    titleOf: (id) => bookmarkById.value.get(id)?.title ?? id,
    rootTitleOf: (id) => rootTitle.get(id) ?? '',
    existingPathOf: (id) => folderPath.get(id),
  });
});

const applyGroups = computed(() => {
  const grouped = new Map<string, ReturnType<typeof listApplyCandidates>>();
  for (const row of applyCandidates.value) {
    const list = grouped.get(row.destLabel) ?? [];
    list.push(row);
    grouped.set(row.destLabel, list);
  }
  return [...grouped.entries()].map(([destLabel, rows]) => {
    const byFrom = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byFrom.get(row.fromLabel) ?? [];
      list.push(row);
      byFrom.set(row.fromLabel, list);
    }
    const movable = rows.filter((row) => !row.keepStill);
    const selected = movable.filter((row) => !row.excluded);
    return {
      destLabel,
      fromGroups: [...byFrom.entries()].map(([fromLabel, items]) => ({ fromLabel, rows: items })),
      movableCount: movable.length,
      selectedCount: selected.length,
      allSelected: movable.length > 0 && selected.length === movable.length,
    };
  });
});

function setApplyRow(bookmarkId: string, included: boolean): void {
  if (included) organizer.includeBookmark(bookmarkId);
  else organizer.excludeBookmark(bookmarkId);
}

function setApplyGroup(destLabel: string, included: boolean): void {
  const group = applyGroups.value.find((row) => row.destLabel === destLabel);
  if (!group) return;
  for (const from of group.fromGroups) {
    for (const row of from.rows) {
      if (row.keepStill) continue;
      setApplyRow(row.bookmarkId, included);
    }
  }
}

const applyBusy = ref(false);
const applyNote = ref<string | null>(null);

async function apply(): Promise<void> {
  if (applyBusy.value || movingMoves.value.length === 0) return;
  const backupNote = settings.value.autoBackup ? '应用前会先下载一份 HTML 备份。' : '注意：已在设置中关闭自动备份。';
  const keepNote = keepStillMoves.value.length > 0 ? `，保持不动 ${keepStillMoves.value.length} 条` : '';
  if (!window.confirm(`将移动已勾选的 ${movingMoves.value.length} 条书签${keepNote}，未勾选的保持原位。${backupNote}\n继续？`)) return;
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
      <div>
        <h1 class="text-lg font-semibold">整理书签</h1>
        <p class="text-xs text-gray-500">两种方式：按网站域名收夹，或让 AI 按主题归类。都是先看再写入。</p>
      </div>
      <ol class="flex items-center gap-2 text-xs">
        <li v-for="(s, i) in STEPS" :key="s.id" class="flex items-center gap-2">
          <span
            class="flex h-5 w-5 items-center justify-center rounded-full"
            :class="stepIndex === i ? 'bg-gray-900 text-white' : stepIndex > i ? 'bg-gray-300 text-gray-700' : 'bg-gray-100 text-gray-400'"
          >
            {{ i + 1 }}
          </span>
          <span :class="stepIndex === i ? 'font-medium text-gray-900' : 'text-gray-500'">{{ s.label }}</span>
          <span v-if="i < STEPS.length - 1" class="text-gray-300">—</span>
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

    <p v-if="settingsLoaded && !hasApiKey && screen === 'scope'" class="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
      还没填 Key：下面「按域名整理」可以直接用。想让模型按主题归类，再
      <button type="button" class="underline" @click="openOptions">去设置填 Key</button>。
    </p>

    <p v-if="bannerError" class="flex flex-wrap items-center justify-between gap-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-red-800">
      <span>{{ phase === 'error' ? '出错：' : '' }}{{ bannerError }}</span>
      <span class="flex gap-2 text-xs">
        <button type="button" class="underline" @click="dismissError">清除</button>
      </span>
    </p>

    <!-- 选择方式 -->
    <section v-if="screen === 'scope'" class="space-y-5">
      <div class="rounded-lg border border-gray-200 p-5">
        <h2 class="text-base font-semibold">整理范围</h2>
        <p class="mt-1 text-xs text-gray-500">两种方式共用这一份范围。点下面的按钮才出方案，书签还不会动。</p>

        <div class="mt-3 text-sm text-gray-700">
          <p v-if="treeLoading || restoring">正在读取书签…</p>
          <p v-else-if="treeError" class="text-red-600">
            读取书签失败：{{ treeError }}
            <button type="button" class="ml-2 underline" @click="reload">重试</button>
          </p>
          <template v-else>
            <p>
              当前是
              <span class="font-medium text-gray-900">{{ scopeLabel }}</span>
              <button type="button" class="ml-2 text-xs text-gray-500 underline" @click="openOptions">改范围</button>
              <span v-if="settings.debugLimit" class="ml-2 text-xs text-amber-800">调试中：只看前 {{ settings.debugLimit }} 条</span>
            </p>
            <label class="mt-3 flex items-start gap-2 text-sm">
              <input v-model="includeFoldered" type="checkbox" class="mt-1" :disabled="running" />
              <span>
                连已经放进文件夹的也算上
                <span class="block text-xs text-gray-500">关掉就只收拾根目录下还没归类的散装书签</span>
              </span>
            </label>
            <ul class="mt-3 space-y-0.5 text-xs text-gray-600">
              <li v-for="{ root, total, loose, foldered } in countByRoot" :key="root.id">
                {{ rootLabel(root) }}：共 <span class="font-medium text-gray-800">{{ total }}</span> 条（散装 {{ loose }}，文件夹里 {{ foldered }}）
              </li>
            </ul>
            <p class="mt-1 text-xs text-gray-600">
              合计 <span class="font-medium text-gray-800">{{ inScope.length }}</span> 条
              <template v-if="duplicates.length > 0">
                ；重复网址 {{ duplicates.length }} 组，按域名时默认会一起归夹
              </template>
            </p>
          </template>
        </div>
        <p v-if="!treeLoading && !treeError && inScope.length === 0" class="mt-3 text-sm text-gray-600">
          这个范围内没有书签。换个范围，或勾上「连已经放进文件夹的也算上」。
        </p>
      </div>

      <div v-if="!treeLoading && inScope.length > 0" class="grid gap-4 md:grid-cols-2">
        <section class="flex flex-col rounded-lg border border-gray-200 p-5">
          <h2 class="text-base font-semibold">按域名整理</h2>
          <p class="mt-1 text-sm text-gray-600">
            同一个网站的书签全部收进该网站的文件夹。一条也建夹，不调用模型。
          </p>
          <p class="mt-2 text-xs text-gray-500">
            范围内大约
            <span class="font-medium text-gray-800">{{ domainFolderCount }}</span>
            个网站会各有一个夹。解析不了的链接不移动。
          </p>
          <label v-if="includeFoldered" class="mt-3 flex items-start gap-2 text-sm">
            <input v-model="keepThematic" type="checkbox" class="mt-1" :disabled="running" />
            <span>
              已经按主题分好的，先别拆开
              <span class="block text-xs text-gray-500">
                夹名对得上网站的保持不动。
                <template v-if="thematicInScope > 0">现在有 {{ thematicInScope }} 条会跳过。</template>
              </span>
            </span>
          </label>
          <div class="mt-4 min-h-0 flex-1">
            <h3 class="mb-2 text-xs font-medium text-gray-500">这些网站出现得最多</h3>
            <DomainHistogram :entries="histogram" :limit="12" />
          </div>
          <button
            type="button"
            class="mt-4 rounded-md bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!canStartDomain"
            @click="startDomain"
          >
            按域名看会怎么整理
          </button>
        </section>

        <section class="flex flex-col rounded-lg border border-gray-200 p-5">
          <h2 class="text-base font-semibold">AI 整理</h2>
          <p class="mt-1 text-sm text-gray-600">按主题归类，不是按网站切。需要 Key。</p>
          <div class="mt-4 space-y-3">
            <div>
              <h3 class="mb-1 text-xs font-medium text-gray-600">用哪些主题</h3>
              <p class="mb-2 text-xs text-gray-500">默认都不勾。勾上的会保留，模型只能在它们下面再分一层。没勾的不会出现，也不会建空文件夹。对不上的留在未分类。</p>
              <ThemeSeedPicker v-model="seeds" :existing="seedSuggestions" :disabled="running || !hasApiKey" />
            </div>
            <div>
              <h3 class="mb-1 text-xs font-medium text-gray-600">一句话偏好</h3>
              <textarea
                v-model="hint"
                rows="3"
                class="w-full rounded border border-gray-300 px-2 py-1 disabled:bg-gray-50"
                placeholder="例：不要按编程语言分；把购物类合并成一个"
                :disabled="running || !hasApiKey"
              />
            </div>
          </div>
          <p v-if="!hasApiKey" class="mt-3 text-xs text-amber-800">
            还没填 Key，
            <button type="button" class="underline" @click="openOptions">去设置</button>
            之后才能用这种方式。
          </p>
          <p v-else class="mt-3 text-xs text-gray-500">只发打码后的标题和网址。类目和偏好会记成下次的默认值。</p>
          <button
            type="button"
            class="mt-4 rounded-md border border-gray-900 px-4 py-2 text-sm hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!canStartAi"
            :title="hasApiKey ? '' : 'AI 整理需要先在设置里填 Key'"
            @click="startGenerate"
          >
            用 AI 生成方案
          </button>
        </section>
      </div>
    </section>

    <!-- 生成中 -->
    <section v-else-if="screen === 'working'" class="space-y-4 rounded-lg border border-gray-200 p-5">
      <h2 class="text-base font-semibold">正在生成{{ methodLabel }}方案</h2>
      <JobProgress :phase="phase" :done="job.done" :total="job.total" :cancelling="cancelling" @cancel="cancel" />
      <p class="text-xs text-gray-500">
        <template v-if="isDomainJob">按网站域名归堆，不调用模型，书签还没动。</template>
        <template v-else-if="(job.input?.seedCategories.length ?? 0) > 0">
          只使用你勾选的主题，并可以在下面再分一层。对不上的留在未分类。取消不会改书签。
        </template>
        <template v-else>
          还没勾选主题，模型会自己提出类目，再分批归类（每批 {{ settings.batchSize }} 条）。取消不会改书签。
        </template>
      </p>
    </section>

    <!-- 核对变化：从哪到哪 + 应用 -->
    <section v-else-if="screen === 'review' && job.proposal && job.review" class="space-y-4 rounded-lg border border-gray-200 p-5">
      <div class="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 class="text-base font-semibold">{{ methodLabel }}：将这样移动</h2>
          <p class="mt-1 text-sm text-gray-600">
            取消勾选就不会动。将移动
            <span class="font-medium text-gray-900">{{ movingMoves.length }}</span>
            条
            <template v-if="keepStillMoves.length > 0">，已在目标夹 {{ keepStillMoves.length }} 条</template>
            <template v-if="excludedCount > 0">，已取消 {{ excludedCount }} 条</template>
            。
          </p>
        </div>
        <p class="text-xs text-gray-500">
          {{ job.proposal.categories.length }} 个文件夹
          <span v-if="job.skipped.length > 0" class="text-amber-700" :title="skippedRows.map((r) => `${r.title}：${r.text}`).join('\n')">
            · {{ job.skipped.length }} 条已跳过
          </span>
        </p>
      </div>

      <div v-if="applyGroups.length > 0" class="max-h-[28rem] space-y-3 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-3">
        <section v-for="group in applyGroups" :key="group.destLabel" class="space-y-1 rounded-md bg-white p-3">
          <label class="flex items-center gap-2 text-sm font-medium text-gray-800">
            <input
              type="checkbox"
              class="mt-0.5"
              :checked="group.allSelected"
              :disabled="group.movableCount === 0 || applyBusy"
              @change="setApplyGroup(group.destLabel, ($event.target as HTMLInputElement).checked)"
            />
            <span>→ {{ group.destLabel }}</span>
            <span class="font-normal text-gray-500">{{ group.selectedCount }}/{{ group.movableCount }} 将移动</span>
          </label>
          <div v-for="from in group.fromGroups" :key="from.fromLabel" class="pl-6">
            <p class="text-xs text-gray-500">从 {{ from.fromLabel }}</p>
            <ul class="mt-0.5 space-y-0.5">
              <li v-for="row in from.rows" :key="row.bookmarkId" class="flex items-center gap-2 text-sm text-gray-700">
                <input
                  v-if="!row.keepStill"
                  type="checkbox"
                  :checked="!row.excluded"
                  :disabled="applyBusy"
                  @change="setApplyRow(row.bookmarkId, ($event.target as HTMLInputElement).checked)"
                />
                <span v-else class="w-4 text-center text-gray-400">·</span>
                <span class="min-w-0 truncate" :title="row.title">{{ row.title }}</span>
                <span v-if="row.keepStill" class="shrink-0 text-xs text-gray-400">已在此夹</span>
                <span v-else-if="row.excluded" class="shrink-0 text-xs text-gray-400">不移动</span>
              </li>
            </ul>
          </div>
        </section>
      </div>
      <p v-else class="text-sm text-gray-600">没有要移动的书签。下面可以改分类，或放弃这次方案。</p>

      <p class="text-xs text-gray-500">
        <template v-if="settings.autoBackup">确定后会先下载一份 HTML 备份，再移动勾选的书签。</template>
        <template v-else><span class="text-amber-700">已在设置中关闭自动备份。</span></template>
        移动时请不要关这个页。
      </p>
      <p v-if="applyNote" class="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">{{ applyNote }}</p>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap gap-2">
          <button type="button" class="rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50" @click="discard">放弃</button>
          <button type="button" class="text-xs text-gray-500 underline" @click="showCategoryEditor = !showCategoryEditor">
            {{ showCategoryEditor ? '收起分类编辑' : '改某条的分类' }}
          </button>
        </div>
        <button
          type="button"
          class="rounded-md bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="movingMoves.length === 0 || applyBusy"
          @click="apply"
        >
          {{ applyBusy ? '正在移动…' : `移动这 ${movingMoves.length} 条` }}
        </button>
      </div>

      <div v-if="showCategoryEditor" class="space-y-3 border-t border-gray-200 pt-4">
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
        <template v-if="isDomainJob">
          <button type="button" class="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50" @click="regenerate">按当前范围重算</button>
        </template>
        <template v-else>
          <label class="text-xs text-gray-600" for="regenerate-hint">带提示重新生成（会丢掉你刚改的分类）</label>
          <div class="flex gap-2">
            <input
              id="regenerate-hint"
              v-model="regenerateHint"
              type="text"
              class="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1"
              placeholder="例：把购物和生活合并"
              @keydown.enter.prevent="regenerate"
            />
            <button type="button" class="rounded border border-gray-300 px-3 py-1 hover:bg-gray-50" @click="regenerate">重新生成</button>
          </div>
        </template>
      </div>
    </section>

    <!-- 完成 / 写入中 -->
    <section v-else-if="screen === 'result'" class="space-y-4 rounded-lg border border-gray-200 p-5">
      <template v-if="phase === 'applying'">
        <h2 class="text-base font-semibold">正在移动书签</h2>
        <JobProgress :phase="phase" :done="job.done" :total="job.total" :cancelling="cancelling" @cancel="cancelApply" />
        <p class="text-xs text-gray-600">
          <template v-if="job.backupFileName">已下载备份：<span class="font-mono">{{ job.backupFileName }}</span>。</template>
          一条一条挪，请不要关这个页。取消会停在下一条之前，并把已经挪过的移回去。
        </p>
      </template>

      <template v-else-if="phase === 'done'">
        <h2 class="text-base font-semibold">整理完成</h2>
        <div class="space-y-1 text-sm text-gray-700">
          <p>
            已移动 <span class="font-medium">{{ job.done }}</span> 条
            <span v-if="keepStillSkipped.length > 0">，保持不动 {{ keepStillSkipped.length }} 条</span>
            <span v-if="skippedRows.length > 0">，跳过 {{ skippedRows.length }} 条</span>。
          </p>
          <p class="text-xs text-gray-500">
            <template v-if="job.backupFileName">备份：<span class="font-mono">{{ job.backupFileName }}</span></template>
            <template v-else-if="settings.autoBackup">未备份</template>
            <template v-else>未备份（已在设置中关闭）</template>
          </p>
        </div>

        <details v-if="heldBack.length > 0" class="text-xs">
          <summary class="cursor-pointer text-gray-600">未勾选、未移动 {{ heldBack.length }} 条</summary>
          <ul class="mt-1 space-y-0.5 text-gray-600">
            <li v-for="row in heldBack" :key="row.bookmarkId">
              <span class="text-gray-800">{{ row.title }}</span> — 本可进入 {{ row.destLabel }}
            </li>
          </ul>
        </details>

        <p v-if="emptiedFolders.length > 0" class="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {{ emptiedFolders.length }} 个原有文件夹已空，可手动删除：{{ emptiedFolders.map((f) => formatFolderPath(f.path)).join('、') }}
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
          找不到这次整理的记录（可能已被新的整理覆盖），无法在这里撤销。
        </p>
        <p v-if="undoNote" class="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">{{ undoNote }}</p>

        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="rounded-md border border-red-300 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!canUndo"
            @click="undo"
          >
            {{ undoBusy ? '撤销中…' : '撤销这次整理' }}
          </button>
          <button type="button" class="rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50" @click="startOver">再整理一次</button>
          <button type="button" class="rounded-md bg-gray-900 px-3 py-2 text-sm text-white hover:bg-gray-700" @click="finish">完成</button>
        </div>
      </template>

      <template v-else-if="applyFailed">
        <h2 class="text-base font-semibold">没有写完</h2>
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
          <button type="button" class="rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50" @click="backToReview">回到核对</button>
          <button type="button" class="rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50" @click="startOver">重新开始</button>
        </div>
      </template>
    </section>

    <section v-else class="rounded-lg border border-gray-200 p-5 text-xs text-gray-500">正在恢复上次的方案…</section>

    <aside
      v-if="showDevBar"
      class="fixed bottom-3 right-3 z-20 max-w-xs rounded-lg bg-gray-900 px-3 py-2 font-mono text-[11px] leading-relaxed text-gray-100 shadow-lg"
    >
      <p>{{ phase }} · 范围内 {{ inScope.length }} · 将移动 {{ movingMoves.length }}</p>
      <p v-if="settings.debugLimit" class="text-amber-200">只处理前 {{ settings.debugLimit }} 条</p>
      <p class="text-gray-400">pnpm dev：改页面会热更新。这条警告不用管——WSL 里请手动加载 chrome-mv3-dev。</p>
    </aside>
  </main>
</template>
