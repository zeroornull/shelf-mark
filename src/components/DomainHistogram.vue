<script lang="ts" setup>
import { computed } from 'vue';
import type { DomainStat } from '@/lib/ai/prompts';

/** 域名直方图：横向条形，默认只画前 30 个域名（输入已按 count 降序）。 */
const props = defineProps<{ entries: DomainStat[]; limit?: number }>();

const rows = computed(() => props.entries.slice(0, props.limit ?? 30));
const max = computed(() => rows.value[0]?.count ?? 1);
const rest = computed(() => {
  const shown = rows.value.reduce((sum, row) => sum + row.count, 0);
  const total = props.entries.reduce((sum, row) => sum + row.count, 0);
  return { domains: props.entries.length - rows.value.length, bookmarks: total - shown };
});
</script>

<template>
  <div class="space-y-1 text-xs">
    <div v-for="row in rows" :key="row.domain" class="grid grid-cols-[minmax(0,12rem)_1fr_3rem] items-center gap-2">
      <span class="truncate font-mono text-gray-700" :title="row.sampleTitles.join(' / ')">{{ row.domain }}</span>
      <div class="h-3 rounded bg-gray-100">
        <div class="h-3 rounded bg-gray-700" :style="{ width: `${Math.max(2, (row.count / max) * 100)}%` }" />
      </div>
      <span class="text-right tabular-nums text-gray-500">{{ row.count }}</span>
    </div>
    <p v-if="rows.length === 0" class="text-gray-400">没有书签</p>
    <p v-else-if="rest.domains > 0" class="pt-1 text-gray-400">其余 {{ rest.domains }} 个域名共 {{ rest.bookmarks }} 条</p>
  </div>
</template>
