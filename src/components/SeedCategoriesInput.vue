<script lang="ts" setup>
import { computed, ref } from 'vue';
import { normalizeTitle } from '@/lib/bookmarks/mutate';

/**
 * seedCategories 输入：chips + 自由输入（回车 / 逗号确认），可选一组建议（已有文件夹）用复选框勾选。
 * 去重按 normalizeTitle（NFKC + trim + 忽略大小写）。
 */
type SeedSuggestion = { title: string; path?: string[] };

const props = defineProps<{
  modelValue: string[];
  suggestions?: SeedSuggestion[];
  placeholder?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();

const draft = ref('');

const normalizedSet = computed(() => new Set(props.modelValue.map(normalizeTitle)));

/** 建议按 normalize 去重，保留首次出现的写法。 */
const uniqueSuggestions = computed(() => {
  const seen = new Set<string>();
  const out: SeedSuggestion[] = [];
  for (const suggestion of props.suggestions ?? []) {
    const key = normalizeTitle(suggestion.title);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(suggestion);
  }
  return out;
});

function add(raw: string): void {
  const parts = raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length === 0) return;
  const next = [...props.modelValue];
  const seen = new Set(next.map(normalizeTitle));
  for (const part of parts) {
    const key = normalizeTitle(part);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(part);
  }
  if (next.length !== props.modelValue.length) emit('update:modelValue', next);
}

function remove(title: string): void {
  const key = normalizeTitle(title);
  emit(
    'update:modelValue',
    props.modelValue.filter((t) => normalizeTitle(t) !== key),
  );
}

function commitDraft(): void {
  add(draft.value);
  draft.value = '';
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
    event.preventDefault();
    commitDraft();
  } else if (event.key === 'Backspace' && draft.value === '' && props.modelValue.length > 0) {
    remove(props.modelValue[props.modelValue.length - 1]!);
  }
}

function toggleSuggestion(suggestion: SeedSuggestion, checked: boolean): void {
  if (checked) add(suggestion.title);
  else remove(suggestion.title);
}

function isChecked(suggestion: SeedSuggestion): boolean {
  return normalizedSet.value.has(normalizeTitle(suggestion.title));
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-1 rounded border border-gray-300 px-2 py-1">
      <span
        v-for="title in modelValue"
        :key="title"
        class="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-800"
      >
        {{ title }}
        <button
          type="button"
          class="text-gray-500 hover:text-gray-900"
          :disabled="disabled"
          :aria-label="`移除 ${title}`"
          @click="remove(title)"
        >
          ×
        </button>
      </span>
      <input
        v-model="draft"
        type="text"
        class="min-w-[8rem] flex-1 border-0 px-1 py-0.5 text-sm focus:outline-none"
        :placeholder="placeholder ?? '输入类目名，回车或逗号确认'"
        :disabled="disabled"
        @keydown="onKeydown"
        @blur="commitDraft"
      />
    </div>
    <div v-if="uniqueSuggestions.length > 0" class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-700">
      <span class="text-gray-500">从已有文件夹勾选：</span>
      <label v-for="suggestion in uniqueSuggestions" :key="suggestion.title" class="inline-flex items-center gap-1">
        <input
          type="checkbox"
          :checked="isChecked(suggestion)"
          :disabled="disabled"
          @change="toggleSuggestion(suggestion, ($event.target as HTMLInputElement).checked)"
        />
        <span :title="suggestion.path?.join(' / ')">{{ suggestion.title }}</span>
      </label>
    </div>
  </div>
</template>
