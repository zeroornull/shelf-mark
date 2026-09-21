<script lang="ts" setup>
import { browser } from 'wxt/browser';
import { useSettings } from '@/composables/useSettings';

const { loaded, hasApiKey } = useSettings();

function openOptions(): void {
  void browser.runtime.openOptionsPage();
}
</script>

<template>
  <main class="mx-auto max-w-4xl p-6 text-sm text-gray-800">
    <h1 class="text-lg font-semibold">Shelfmark 整理</h1>
    <p v-if="loaded && !hasApiKey" class="mt-3 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-amber-800">
      未配置 Key，无法开始整理。
      <button type="button" class="underline" @click="openOptions">去设置</button>
    </p>
    <p v-else class="mt-2 text-gray-500">整理向导将在后续版本提供。</p>
  </main>
</template>
