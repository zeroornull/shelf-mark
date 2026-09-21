<script lang="ts" setup>
import { computed, ref, watch } from 'vue';
import { UNCATEGORIZED } from '@/lib/ai/taxonomy';
import type { ReusableFolder } from '@/lib/bookmarks/tree';
import { canMergeInto, countByCategory } from '@/lib/jobs/review';
import type { Assignment, Category, FlatBookmark, Proposal, ReviewState } from '@/lib/types';

/**
 * 预览（计划 §8 第 3 步 / §9）：左侧类目（含父子嵌套、条数、已有文件夹标记），右侧所选类目的书签。
 * `uncategorized` 与重复 URL 单独成栏，默认不移动；可筛低置信度；可改类目 / 合并 / 重命名 / 剔除。
 * 组件本身无状态修改：所有编辑通过事件交给 organizer。
 */
const props = defineProps<{
  proposal: Proposal;
  bookmarks: FlatBookmark[];
  review: ReviewState;
  existingFolders?: ReusableFolder[];
  keepStillIds?: ReadonlySet<string>;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  setCategory: [bookmarkId: string, categoryId: string];
  merge: [fromId: string, intoId: string];
  rename: [categoryId: string, title: string];
  exclude: [bookmarkId: string];
  include: [bookmarkId: string];
  includeUncategorized: [value: boolean];
  includeDuplicates: [value: boolean];
}>();

const DUPLICATES = '__duplicates__';

type CategoryRow = { category: Category; depth: number; count: number; hasChildren: boolean };

const counts = computed(() => countByCategory(props.proposal));
const byId = computed(() => new Map(props.proposal.categories.map((c) => [c.id, c])));
const bookmarkById = computed(() => new Map(props.bookmarks.map((b) => [b.id, b])));
const excluded = computed(() => new Set(props.review.excluded));
const duplicateIds = computed(() => new Set(props.proposal.duplicates.flatMap((d) => d.bookmarkIds)));
const folderPathById = computed(() => new Map((props.existingFolders ?? []).map((f) => [f.id, f.path.join(' / ')])));

/** 顶层 → 子类目 的顺序展开。 */
const rows = computed<CategoryRow[]>(() => {
  const children = new Map<string, Category[]>();
  for (const c of props.proposal.categories) {
    if (c.parentId === undefined) continue;
    const bucket = children.get(c.parentId) ?? [];
    bucket.push(c);
    children.set(c.parentId, bucket);
  }
  const out: CategoryRow[] = [];
  for (const c of props.proposal.categories) {
    if (c.parentId !== undefined && byId.value.has(c.parentId)) continue;
    const kids = children.get(c.id) ?? [];
    out.push({ category: c, depth: 0, count: counts.value.get(c.id) ?? 0, hasChildren: kids.length > 0 });
    for (const kid of kids) out.push({ category: kid, depth: 1, count: counts.value.get(kid.id) ?? 0, hasChildren: false });
  }
  return out;
});

const uncategorizedCount = computed(() => counts.value.get(UNCATEGORIZED) ?? 0);

const selectedId = ref<string>(rows.value[0]?.category.id ?? UNCATEGORIZED);
watch(rows, (next) => {
  if (selectedId.value === UNCATEGORIZED || selectedId.value === DUPLICATES) return;
  if (!next.some((r) => r.category.id === selectedId.value)) selectedId.value = next[0]?.category.id ?? UNCATEGORIZED;
});

const selectedCategory = computed(() => byId.value.get(selectedId.value));
const selectedTitle = computed(() => {
  if (selectedId.value === UNCATEGORIZED) return '未分类';
  if (selectedId.value === DUPLICATES) return '重复 URL';
  return selectedCategory.value?.title ?? '';
});

const lowOnly = ref(false);

type Row = { assignment: Assignment; bookmark: FlatBookmark; excluded: boolean; duplicate: boolean };

function toRow(assignment: Assignment): Row | null {
  const bookmark = bookmarkById.value.get(assignment.bookmarkId);
  if (!bookmark) return null;
  return {
    assignment,
    bookmark,
    excluded: excluded.value.has(bookmark.id),
    duplicate: duplicateIds.value.has(bookmark.id),
  };
}

const listRows = computed<Row[]>(() => {
  if (selectedId.value === DUPLICATES) return [];
  return props.proposal.assignments
    .filter((a) => a.categoryId === selectedId.value)
    .filter((a) => !lowOnly.value || a.confidence === 'low')
    .map(toRow)
    .filter((r): r is Row => r !== null);
});

const assignmentById = computed(() => new Map(props.proposal.assignments.map((a) => [a.bookmarkId, a])));

const duplicateGroups = computed(() =>
  props.proposal.duplicates.map((group) => ({
    url: group.url,
    rows: group.bookmarkIds
      .map((id) => {
        const assignment = assignmentById.value.get(id);
        return assignment ? toRow(assignment) : null;
      })
      .filter((r): r is Row => r !== null),
  })),
);

/** 书签下拉可选：只有叶子类目 + 未分类。有子类目的父类目是纯结构（§0），不能直接放书签。 */
const categoryOptions = computed(() =>
  rows.value
    .filter((r) => !r.hasChildren)
    .map((r) => ({ id: r.category.id, label: `${r.depth > 0 ? '　' : ''}${r.category.title}` }))
    .concat([{ id: UNCATEGORIZED, label: '未分类' }]),
);

/** 合并目标：不能是自己，也不能是（除自己以外还）有子类目的父类目。 */
const mergeTargets = computed(() =>
  rows.value
    .filter((r) => selectedCategory.value !== undefined && r.category.id !== selectedCategory.value.id)
    .map((r) => ({
      id: r.category.id,
      label: `${r.depth > 0 ? '　' : ''}${r.category.title}`,
      disabled: selectedCategory.value === undefined || !canMergeInto(props.proposal, selectedCategory.value.id, r.category.id),
    })),
);

const mergeTarget = ref('');
const renameDraft = ref('');
watch(
  selectedCategory,
  (c) => {
    renameDraft.value = c?.title ?? '';
    mergeTarget.value = '';
  },
  { immediate: true },
);

function commitRename(): void {
  if (!selectedCategory.value) return;
  const title = renameDraft.value.trim();
  if (title !== '' && title !== selectedCategory.value.title) emit('rename', selectedCategory.value.id, title);
}

function commitMerge(): void {
  if (!selectedCategory.value || mergeTarget.value === '') return;
  const from = selectedCategory.value.id;
  const into = mergeTarget.value;
  if (!canMergeInto(props.proposal, from, into)) {
    window.alert(`「${byId.value.get(into)?.title ?? into}」是父类目（纯结构），不能直接收书签；请合并进它的某个子类目。`);
    return;
  }
  if (window.confirm(`把「${selectedCategory.value.title}」合并进「${byId.value.get(into)?.title ?? into}」？其下书签会全部改到目标类目。`)) {
    emit('merge', from, into);
    selectedId.value = into;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

const CONFIDENCE_CLASS: Record<Assignment['confidence'], string> = {
  high: 'bg-green-50 text-green-700',
  medium: 'bg-amber-50 text-amber-700',
  low: 'bg-red-50 text-red-700',
};
const CONFIDENCE_LABEL: Record<Assignment['confidence'], string> = { high: '高', medium: '中', low: '低' };
</script>

<template>
  <div class="grid gap-4 md:grid-cols-[minmax(14rem,18rem)_1fr]">
    <!-- 左：类目 -->
    <aside class="space-y-3 text-sm">
      <ul class="space-y-0.5">
        <li v-for="row in rows" :key="row.category.id">
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-gray-50"
            :class="selectedId === row.category.id ? 'bg-gray-100 font-medium' : ''"
            :style="{ paddingLeft: `${row.depth * 16 + 8}px` }"
            @click="selectedId = row.category.id"
          >
            <span class="min-w-0 flex-1 truncate">{{ row.category.title }}</span>
            <span
              v-if="row.category.existingFolderId"
              class="shrink-0 rounded bg-blue-50 px-1 text-xs text-blue-700"
              :title="folderPathById.get(row.category.existingFolderId) ?? '已有文件夹'"
            >
              已有
            </span>
            <span v-if="row.hasChildren" class="shrink-0 text-xs text-gray-400">父</span>
            <span class="shrink-0 tabular-nums text-xs text-gray-500">{{ row.count }}</span>
          </button>
        </li>
      </ul>

      <div class="space-y-1 border-t border-gray-200 pt-2">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-gray-50"
          :class="selectedId === UNCATEGORIZED ? 'bg-gray-100 font-medium' : ''"
          @click="selectedId = UNCATEGORIZED"
        >
          <span class="flex-1">未分类</span>
          <span class="tabular-nums text-xs text-gray-500">{{ uncategorizedCount }}</span>
        </button>
        <label class="flex items-center gap-2 px-2 text-xs text-gray-600">
          <input
            type="checkbox"
            :checked="review.includeUncategorized"
            :disabled="disabled"
            @change="emit('includeUncategorized', ($event.target as HTMLInputElement).checked)"
          />
          <span>移入「未分类」文件夹（默认不动）</span>
        </label>

        <button
          type="button"
          class="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-gray-50"
          :class="selectedId === DUPLICATES ? 'bg-gray-100 font-medium' : ''"
          @click="selectedId = DUPLICATES"
        >
          <span class="flex-1">重复 URL</span>
          <span class="tabular-nums text-xs text-gray-500">{{ proposal.duplicates.length }} 组</span>
        </button>
        <label class="flex items-center gap-2 px-2 text-xs text-gray-600">
          <input
            type="checkbox"
            :checked="review.includeDuplicates"
            :disabled="disabled"
            @change="emit('includeDuplicates', ($event.target as HTMLInputElement).checked)"
          />
          <span>重复项也按类目移动（默认不动）</span>
        </label>
      </div>

      <div v-if="selectedCategory" class="space-y-2 border-t border-gray-200 pt-2 text-xs">
        <div class="flex gap-1">
          <input
            v-model="renameDraft"
            type="text"
            class="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1"
            :disabled="disabled"
            aria-label="重命名类目"
            @keydown.enter.prevent="commitRename"
          />
          <button type="button" class="rounded border border-gray-300 px-2 py-1 hover:bg-gray-50" :disabled="disabled" @click="commitRename">重命名</button>
        </div>
        <div class="flex gap-1">
          <select v-model="mergeTarget" class="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1" :disabled="disabled" aria-label="合并到">
            <option value="">合并到…</option>
            <option v-for="target in mergeTargets" :key="target.id" :value="target.id" :disabled="target.disabled">
              {{ target.label }}{{ target.disabled ? '（父类目，不可合并进）' : '' }}
            </option>
          </select>
          <button type="button" class="rounded border border-gray-300 px-2 py-1 hover:bg-gray-50" :disabled="disabled || mergeTarget === ''" @click="commitMerge">合并</button>
        </div>
      </div>
    </aside>

    <!-- 右：书签 -->
    <section class="min-w-0 space-y-2 text-sm">
      <header class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="font-medium">
          {{ selectedTitle }}
          <span v-if="selectedId !== DUPLICATES" class="ml-1 text-xs text-gray-500">{{ listRows.length }} 条</span>
        </h3>
        <label v-if="selectedId !== DUPLICATES" class="flex items-center gap-1 text-xs text-gray-600">
          <input v-model="lowOnly" type="checkbox" />
          只看低置信度
        </label>
      </header>

      <template v-if="selectedId === DUPLICATES">
        <p v-if="duplicateGroups.length === 0" class="text-xs text-gray-400">没有重复 URL</p>
        <div v-for="group in duplicateGroups" :key="group.url" class="rounded border border-gray-200 p-2">
          <p class="truncate font-mono text-xs text-gray-500" :title="group.url">{{ group.url }}</p>
          <ul class="mt-1 space-y-1">
            <li v-for="row in group.rows" :key="row.bookmark.id" class="flex items-center gap-2 text-xs">
              <span class="min-w-0 flex-1 truncate" :class="row.excluded ? 'line-through text-gray-400' : ''">{{ row.bookmark.title || row.bookmark.url }}</span>
              <span class="text-gray-500">→ {{ byId.get(row.assignment.categoryId)?.title ?? '未分类' }}</span>
              <button type="button" class="underline" :disabled="disabled" @click="row.excluded ? emit('include', row.bookmark.id) : emit('exclude', row.bookmark.id)">
                {{ row.excluded ? '恢复' : '剔除' }}
              </button>
            </li>
          </ul>
        </div>
      </template>

      <template v-else>
        <p v-if="listRows.length === 0" class="text-xs text-gray-400">{{ lowOnly ? '没有低置信度的条目' : '这个类目下没有书签' }}</p>
        <ul v-else class="divide-y divide-gray-100">
          <li v-for="row in listRows" :key="row.bookmark.id" class="flex items-center gap-2 py-1">
            <div class="min-w-0 flex-1">
              <p class="truncate" :class="row.excluded ? 'line-through text-gray-400' : ''" :title="row.bookmark.url">
                {{ row.bookmark.title || row.bookmark.url }}
              </p>
              <p class="truncate text-xs text-gray-400">
                {{ hostOf(row.bookmark.url) }}
                <span v-if="row.duplicate" class="ml-1 rounded bg-gray-100 px-1 text-gray-600">重复</span>
                <span v-if="keepStillIds?.has(row.bookmark.id)" class="ml-1 rounded bg-slate-100 px-1 text-slate-600">保持不动</span>
              </p>
            </div>
            <span class="shrink-0 rounded px-1.5 text-xs" :class="CONFIDENCE_CLASS[row.assignment.confidence]">{{ CONFIDENCE_LABEL[row.assignment.confidence] }}</span>
            <select
              class="w-32 shrink-0 rounded border border-gray-300 px-1 py-0.5 text-xs"
              :value="row.assignment.categoryId"
              :disabled="disabled || row.excluded"
              :aria-label="`${row.bookmark.title} 的类目`"
              @change="emit('setCategory', row.bookmark.id, ($event.target as HTMLSelectElement).value)"
            >
              <option v-for="option in categoryOptions" :key="option.id" :value="option.id">{{ option.label }}</option>
            </select>
            <button
              type="button"
              class="shrink-0 rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50"
              :disabled="disabled"
              @click="row.excluded ? emit('include', row.bookmark.id) : emit('exclude', row.bookmark.id)"
            >
              {{ row.excluded ? '恢复' : '剔除' }}
            </button>
          </li>
        </ul>
      </template>
    </section>
  </div>
</template>
