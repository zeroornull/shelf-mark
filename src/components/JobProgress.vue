<script lang="ts" setup>
import { computed } from 'vue';
import type { JobPhase } from '@/lib/types';

/** 确定进度：done / total + 阶段文案。 */
const props = defineProps<{ phase: JobPhase; done: number; total: number; cancelling?: boolean }>();
const emit = defineEmits<{ cancel: [] }>();

const LABELS: Record<JobPhase, string> = {
  idle: '空闲',
  'loading-tree': '读取书签树…',
  proposing: '生成类目…',
  assigning: '批量归类',
  refining: '补充类目并重新归类',
  review: '预览',
  applying: '应用中',
  done: '完成',
  error: '出错',
};

const label = computed(() => LABELS[props.phase]);
/** proposing 等没有可数进度的阶段显示为「不确定」条。 */
const indeterminate = computed(() => props.total === 0 || props.phase === 'proposing' || props.phase === 'loading-tree');
const percent = computed(() => (props.total > 0 ? Math.min(100, Math.round((props.done / props.total) * 100)) : 0));
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between text-xs text-gray-600">
      <span>
        {{ label }}
        <span v-if="!indeterminate" class="ml-2 tabular-nums text-gray-800">{{ done }} / {{ total }}</span>
        <span v-else-if="phase === 'refining' || phase === 'assigning'" class="ml-2 text-gray-400">准备中…</span>
      </span>
      <button
        type="button"
        class="rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-50"
        :disabled="cancelling"
        @click="emit('cancel')"
      >
        {{ cancelling ? '取消中…' : '取消' }}
      </button>
    </div>
    <div class="h-2 overflow-hidden rounded bg-gray-100" role="progressbar" :aria-valuenow="indeterminate ? undefined : percent" aria-valuemin="0" aria-valuemax="100">
      <div v-if="indeterminate" class="h-2 w-1/3 animate-pulse rounded bg-gray-500" />
      <div v-else class="h-2 rounded bg-gray-800 transition-[width]" :style="{ width: `${percent}%` }" />
    </div>
  </div>
</template>
