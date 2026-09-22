<script lang="ts" setup>
import { computed, ref } from 'vue';
import { PRESET_TOPICS } from '@/lib/ai/presets';
import { normalizeTitle } from '@/lib/bookmarks/mutate';

/**
 * AI 整理的主题勾选：预设主题 + 已有文件夹 + 自定义。
 * 没勾的不会进入 seedCategories。
 */
type ExistingFolder = { title: string; path?: string[] };

const props = defineProps<{
  modelValue: string[];
  existing?: ExistingFolder[];
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();

const draft = ref('');
const selected = computed(() => new Set(props.modelValue.map(normalizeTitle)));

type Row = { title: string; hint?: string };

const rows = computed<Row[]>(() => {
  const existingByKey = new Map<string, ExistingFolder>();
  for (const folder of props.existing ?? []) {
    const key = normalizeTitle(folder.title);
    if (key !== '' && !existingByKey.has(key)) existingByKey.set(key, folder);
  }
  const presetKeys = new Set(PRESET_TOPICS.map((title) => normalizeTitle(title)));
  const out: Row[] = PRESET_TOPICS.map((title) => ({
    title,
    hint: existingByKey.has(normalizeTitle(title)) ? '已有文件夹' : undefined,
  }));
  for (const folder of existingByKey.values()) {
    if (presetKeys.has(normalizeTitle(folder.title))) continue;
    out.push({ title: folder.title, hint: folder.path?.join(' / ') || '已有文件夹' });
  }
  for (const title of props.modelValue) {
    const key = normalizeTitle(title);
    if (key === '' || out.some((row) => normalizeTitle(row.title) === key)) continue;
    out.push({ title, hint: '自定义' });
  }
  return out;
});

function isChecked(title: string): boolean {
  return selected.value.has(normalizeTitle(title));
}

function toggle(title: string, checked: boolean): void {
  const key = normalizeTitle(title);
  if (checked) {
    if (selected.value.has(key)) return;
    emit('update:modelValue', [...props.modelValue, title]);
    return;
  }
  emit(
    'update:modelValue',
    props.modelValue.filter((item) => normalizeTitle(item) !== key),
  );
}

function addCustom(): void {
  const title = draft.value.trim();
  draft.value = '';
  if (title === '' || selected.value.has(normalizeTitle(title))) return;
  emit('update:modelValue', [...props.modelValue, title]);
}
</script>

<template>
  <div class="space-y-2">
    <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-sm text-gray-800">
      <label v-for="row in rows" :key="normalizeTitle(row.title)" class="flex items-start gap-2">
        <input
          type="checkbox"
          class="mt-1"
          :checked="isChecked(row.title)"
          :disabled="disabled"
          @change="toggle(row.title, ($event.target as HTMLInputElement).checked)"
        />
        <span>
          {{ row.title }}
          <span v-if="row.hint" class="block text-xs text-gray-500">{{ row.hint }}</span>
        </span>
      </label>
    </div>
    <form class="flex gap-2" @submit.prevent="addCustom">
      <input
        v-model="draft"
        type="text"
        class="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-50"
        placeholder="自己加一个主题"
        :disabled="disabled"
      />
      <button type="submit" class="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50" :disabled="disabled">
        添加
      </button>
    </form>
  </div>
</template>
