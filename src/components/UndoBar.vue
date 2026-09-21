<script lang="ts" setup>
import { useSnapshotRecovery } from '@/composables/useSnapshotRecovery';
import { describeRestoreSummary } from '@/lib/jobs/recovery';

/**
 * sidepanel 的撤销 / 回滚栏（§8）：
 * - snapshot `applied` → 「撤销最近一次整理（N 条）」
 * - snapshot `applying` 且 organize 页没开着 → 「上次整理被中断，已移动 N/M」+「回滚」
 * - snapshot `applying` 且 organize 页还开着 → 只显示进度，不给按钮（正在应用中）
 * 危险操作都有二次确认（§9）；实际恢复走 `lib/jobs/recovery.ts`，与 organize 页共用。
 */
const emit = defineEmits<{ changed: [] }>();

const { loaded, busy, error, lastSummary, canUndo, interrupted, appliedCount, totalCount, organizeOpen, undo, rollback } = useSnapshotRecovery();

async function onUndo(): Promise<void> {
  if (!window.confirm(`撤销最近一次整理，把 ${appliedCount.value} 条书签移回原位置？\n新建的空文件夹会被删除，里面有你手动添加内容的会保留。`)) return;
  if (await undo()) emit('changed');
}

async function onRollback(): Promise<void> {
  if (!window.confirm(`回滚被中断的整理，把已移动的 ${appliedCount.value} 条书签移回原位置？`)) return;
  if (await rollback()) emit('changed');
}
</script>

<template>
  <section v-if="loaded && (canUndo || interrupted || lastSummary || error)" class="border-b border-gray-200 px-3 py-2 text-xs">
    <div v-if="interrupted" class="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-amber-800">
      <p v-if="organizeOpen === null">检查整理页状态…</p>
      <p v-else-if="organizeOpen">
        整理正在进行中：已移动 <span class="tabular-nums">{{ appliedCount }}/{{ totalCount }}</span>。如果整理页其实已经关闭，请重新打开它使用回滚横幅。
      </p>
      <p v-else class="flex items-center justify-between gap-2">
        <span>上次整理被中断，已移动 {{ appliedCount }}/{{ totalCount }}</span>
        <button
          type="button"
          class="shrink-0 rounded border border-amber-400 bg-white px-2 py-0.5 hover:bg-amber-100 disabled:opacity-50"
          :disabled="busy"
          @click="onRollback"
        >
          {{ busy ? '回滚中…' : '回滚' }}
        </button>
      </p>
    </div>

    <p v-else-if="canUndo" class="flex items-center justify-between gap-2 text-gray-700">
      <span>最近一次整理移动了 {{ appliedCount }} 条书签</span>
      <button
        type="button"
        class="shrink-0 rounded border border-gray-300 px-2 py-0.5 hover:bg-gray-50 disabled:opacity-50"
        :disabled="busy"
        @click="onUndo"
      >
        {{ busy ? '撤销中…' : `撤销最近一次整理（${appliedCount} 条）` }}
      </button>
    </p>

    <p v-if="lastSummary" class="mt-1 text-green-700">{{ describeRestoreSummary(lastSummary) }}</p>
    <p v-if="error" class="mt-1 text-red-600">{{ error }}</p>
  </section>
</template>
