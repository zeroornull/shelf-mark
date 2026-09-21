<script lang="ts" setup>
import { computed, ref } from 'vue';
import type { ProviderConfig } from '@/lib/types';

/**
 * Provider 表单：baseUrl / apiKey / model。
 * 预设只填 baseUrl（模型名还是用户自己填）；`v-model` 绑定整个 `ProviderConfig`。
 */
const props = defineProps<{ modelValue: ProviderConfig; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: ProviderConfig] }>();

type BaseUrlPreset = { id: string; label: string; baseUrl: string; modelHint: string };

const PRESETS: BaseUrlPreset[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', modelHint: 'gpt-4o-mini' },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', modelHint: 'deepseek-chat' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', modelHint: 'openai/gpt-4o-mini' },
  { id: 'dashscope', label: '通义（兼容模式）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelHint: 'qwen-plus' },
  { id: 'ollama', label: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', modelHint: 'qwen2.5:7b' },
];

const showKey = ref(false);

const selectedPreset = computed(() => PRESETS.find((p) => p.baseUrl === props.modelValue.baseUrl.trim())?.id ?? '');
const modelPlaceholder = computed(() => PRESETS.find((p) => p.id === selectedPreset.value)?.modelHint ?? 'gpt-4o-mini');

function update(patch: Partial<ProviderConfig>): void {
  emit('update:modelValue', { ...props.modelValue, ...patch });
}

function applyPreset(event: Event): void {
  const id = (event.target as HTMLSelectElement).value;
  const preset = PRESETS.find((p) => p.id === id);
  if (preset) update({ baseUrl: preset.baseUrl });
}
</script>

<template>
  <fieldset class="space-y-3" :disabled="disabled">
    <div class="grid grid-cols-[6rem_1fr] items-center gap-2">
      <label class="text-gray-600" for="provider-preset">预设</label>
      <select
        id="provider-preset"
        class="rounded border border-gray-300 px-2 py-1"
        :value="selectedPreset"
        @change="applyPreset"
      >
        <option value="">自定义 / 选择一个预设只填 baseUrl</option>
        <option v-for="preset in PRESETS" :key="preset.id" :value="preset.id">
          {{ preset.label }} — {{ preset.baseUrl }}
        </option>
      </select>

      <label class="text-gray-600" for="provider-base-url">baseUrl</label>
      <input
        id="provider-base-url"
        type="url"
        class="rounded border border-gray-300 px-2 py-1 font-mono"
        placeholder="https://api.openai.com/v1"
        :value="modelValue.baseUrl"
        autocomplete="off"
        spellcheck="false"
        @input="update({ baseUrl: ($event.target as HTMLInputElement).value })"
      />

      <label class="text-gray-600" for="provider-api-key">apiKey</label>
      <div class="flex gap-2">
        <input
          id="provider-api-key"
          :type="showKey ? 'text' : 'password'"
          class="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 font-mono"
          placeholder="sk-…"
          :value="modelValue.apiKey"
          autocomplete="off"
          spellcheck="false"
          @input="update({ apiKey: ($event.target as HTMLInputElement).value })"
        />
        <button
          type="button"
          class="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
          :aria-pressed="showKey"
          @click="showKey = !showKey"
        >
          {{ showKey ? '隐藏' : '显示' }}
        </button>
      </div>

      <label class="text-gray-600" for="provider-model">model</label>
      <input
        id="provider-model"
        type="text"
        class="rounded border border-gray-300 px-2 py-1 font-mono"
        :placeholder="modelPlaceholder"
        :value="modelValue.model"
        autocomplete="off"
        spellcheck="false"
        @input="update({ model: ($event.target as HTMLInputElement).value })"
      />
    </div>
    <p class="text-xs text-gray-500">Key 只保存在本机 `storage.local`，不同步、不上传；请求直接从浏览器发到 baseUrl。</p>
  </fieldset>
</template>
