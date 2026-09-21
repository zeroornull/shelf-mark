<script lang="ts" setup>
import { computed, ref } from 'vue';
import ProviderForm from '@/components/ProviderForm.vue';
import SeedCategoriesInput from '@/components/SeedCategoriesInput.vue';
import { useHostPermission } from '@/composables/useHostPermission';
import { useSettings } from '@/composables/useSettings';
import { describeAiError, pingProvider } from '@/lib/ai/client';
import { NOT_REQUESTABLE_HINT, isRequestableOrigin } from '@/lib/origins';
import type { Settings } from '@/lib/types';

const { settings, loaded, saving, error: saveError, hasApiKey, flush } = useSettings();

const baseUrl = computed(() => settings.value.provider.baseUrl);
const { origin, granted: originGranted, request: requestPermission, check: checkPermission } = useHostPermission(baseUrl);

const PERMISSION_REFUSED_HINT = '未授权该地址，将依赖服务商的 CORS；本地模型 / 中转站可能失败';

type TestResult = { ok: boolean; text: string };
const testing = ref(false);
const testResult = ref<TestResult | null>(null);
const permissionNote = ref<string | null>(null);

const canTest = computed(() => !testing.value && origin.value !== null && settings.value.provider.model.trim() !== '');

/**
 * 「测试连接」：`permissions.request` 需要用户手势，所以它是 click handler 里第一个 await；
 * 之后再落盘表单、ping。拒绝授权时照常 ping（依赖服务商 CORS），并给出提示。
 */
async function testConnection(): Promise<void> {
  if (!canTest.value) return;
  testing.value = true;
  testResult.value = null;
  permissionNote.value = null;

  const asked = await requestPermission();
  if (!asked.granted) {
    if (origin.value !== null && !isRequestableOrigin(origin.value)) permissionNote.value = NOT_REQUESTABLE_HINT;
    else permissionNote.value = asked.error ? `${PERMISSION_REFUSED_HINT}（${asked.error}）` : PERMISSION_REFUSED_HINT;
  }

  // 把表单里的最新值先落盘，再用同一份值去 ping
  await flush();
  const provider = { ...settings.value.provider };

  try {
    const result = await pingProvider(provider);
    const reply = result.content.replace(/\s+/g, ' ').trim().slice(0, 60);
    testResult.value = { ok: true, text: `连接成功（HTTP ${result.status}）${reply ? `，模型回复：${reply}` : ''}` };
  } catch (e) {
    const keyHint = provider.apiKey.trim() === '' ? '（apiKey 为空；本地模型可随便填一个占位值）' : '';
    testResult.value = { ok: false, text: `${describeAiError(e)}${keyHint}` };
  } finally {
    testing.value = false;
    void checkPermission();
  }
}

const debugLimitText = computed({
  get: () => (settings.value.debugLimit === undefined ? '' : String(settings.value.debugLimit)),
  set: (value: string) => {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n) && n > 0) settings.value.debugLimit = n;
    else delete settings.value.debugLimit;
  },
});

function setNumber(key: 'batchSize', value: string, min: number, max: number): void {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return;
  settings.value[key] = Math.min(max, Math.max(min, n));
}

function setConcurrency(value: string): void {
  const n = Number(value);
  if (n === 1 || n === 2 || n === 3) settings.value.concurrency = n;
}

function setMaxDepth(value: string): void {
  const n = Number(value);
  if (n === 1 || n === 2) settings.value.maxDepth = n;
}

function setScope(value: string): void {
  if (value === 'loose-other' || value === 'loose-bar-and-other') settings.value.scope = value;
}

function setLanguage(value: string): void {
  if (value === 'zh' || value === 'en' || value === 'auto') settings.value.language = value as Settings['language'];
}
</script>

<template>
  <main class="mx-auto max-w-2xl space-y-8 p-6 text-sm text-gray-800">
    <header class="flex items-baseline justify-between">
      <h1 class="text-lg font-semibold">Shelfmark 设置</h1>
      <span class="text-xs text-gray-500">
        <template v-if="!loaded">加载中…</template>
        <template v-else-if="saving">保存中…</template>
        <span v-else-if="saveError" class="text-red-600">保存失败：{{ saveError }}</span>
        <template v-else>修改自动保存</template>
      </span>
    </header>

    <section class="space-y-3">
      <h2 class="font-semibold">Provider（OpenAI-compatible）</h2>
      <ProviderForm v-model="settings.provider" :disabled="!loaded" />

      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="rounded bg-gray-900 px-3 py-1.5 text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!canTest"
          @click="testConnection"
        >
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <span class="text-xs text-gray-600">
          <template v-if="origin === null">baseUrl 不是合法的 http(s) 地址</template>
          <template v-else-if="originGranted === true">
            <span class="text-green-700">已授权</span> {{ origin }}
          </template>
          <template v-else-if="originGranted === false">
            <span class="text-amber-700">未授权</span> {{ origin }}（点「测试连接」会请求授权）
          </template>
          <template v-else>授权状态未知</template>
        </span>
      </div>
      <p v-if="!hasApiKey" class="text-xs text-amber-700">未配置 Key：整理功能不可用，先填 apiKey 并测试连接。</p>
      <p v-if="permissionNote" class="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">{{ permissionNote }}</p>
      <p
        v-if="testResult"
        class="rounded border px-3 py-2 text-xs"
        :class="testResult.ok ? 'border-green-300 bg-green-50 text-green-800' : 'border-red-300 bg-red-50 text-red-800'"
      >
        {{ testResult.text }}
      </p>
    </section>

    <section class="space-y-3">
      <h2 class="font-semibold">整理范围与策略</h2>
      <div class="grid grid-cols-[8rem_1fr] items-center gap-x-2 gap-y-3">
        <label class="text-gray-600" for="scope">整理范围</label>
        <select id="scope" class="rounded border border-gray-300 px-2 py-1" :value="settings.scope" @change="setScope(($event.target as HTMLSelectElement).value)">
          <option value="loose-other">只整理「其他书签」</option>
          <option value="loose-bar-and-other">「其他书签」+ 书签栏</option>
        </select>

        <span class="text-gray-600">已有文件夹</span>
        <div class="space-y-1">
          <label class="flex items-center gap-2">
            <input v-model="settings.includeFoldered" type="checkbox" />
            <span>包含已在文件夹中的书签</span>
          </label>
          <p class="text-xs text-gray-500">关闭时只整理根目录下的散装书签</p>
        </div>

        <label class="text-gray-600" for="max-depth">文件夹层数</label>
        <select id="max-depth" class="rounded border border-gray-300 px-2 py-1" :value="settings.maxDepth" @change="setMaxDepth(($event.target as HTMLSelectElement).value)">
          <option :value="1">1 层（全部平铺）</option>
          <option :value="2">2 层（书签只进叶子类目）</option>
        </select>

        <label class="text-gray-600" for="language">类目语言</label>
        <select id="language" class="rounded border border-gray-300 px-2 py-1" :value="settings.language" @change="setLanguage(($event.target as HTMLSelectElement).value)">
          <option value="auto">自动（按标题 CJK 比例）</option>
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>

        <label class="text-gray-600" for="batch-size">每批条数</label>
        <input
          id="batch-size"
          type="number"
          min="5"
          max="100"
          class="w-28 rounded border border-gray-300 px-2 py-1"
          :value="settings.batchSize"
          @change="setNumber('batchSize', ($event.target as HTMLInputElement).value, 5, 100)"
        />

        <label class="text-gray-600" for="concurrency">并发批次</label>
        <select id="concurrency" class="w-28 rounded border border-gray-300 px-2 py-1" :value="settings.concurrency" @change="setConcurrency(($event.target as HTMLSelectElement).value)">
          <option :value="1">1</option>
          <option :value="2">2</option>
          <option :value="3">3</option>
        </select>

        <label class="text-gray-600" for="debug-limit">debugLimit</label>
        <div class="flex items-center gap-2">
          <input
            id="debug-limit"
            v-model.lazy="debugLimitText"
            type="number"
            min="1"
            class="w-28 rounded border border-gray-300 px-2 py-1"
            placeholder="留空 = 全量"
          />
          <span class="text-xs text-gray-500">只处理前 N 条，打通流程用；建议先用 20</span>
        </div>

        <span class="text-gray-600">隐私 / 安全</span>
        <div class="space-y-1">
          <label class="flex items-center gap-2">
            <input v-model="settings.domainOnly" type="checkbox" />
            <span>仅域名模式：url 字段只发 hostname（不发路径）</span>
          </label>
          <label class="flex items-center gap-2">
            <input v-model="settings.autoBackup" type="checkbox" />
            <span>应用前自动下载 HTML 备份</span>
          </label>
        </div>
      </div>
    </section>

    <section class="space-y-3">
      <h2 class="font-semibold">默认类目与偏好</h2>
      <div class="space-y-1">
        <label class="text-gray-600">预填顶层类目（seedCategories）</label>
        <SeedCategoriesInput v-model="settings.seedCategories" :disabled="!loaded" />
        <p class="text-xs text-gray-500">整理页第 1 步还可以再改，也能从已有文件夹里勾选。</p>
      </div>
      <div class="space-y-1">
        <label class="text-gray-600" for="user-hint">一句话偏好（userHint）</label>
        <textarea
          id="user-hint"
          v-model="settings.userHint"
          rows="2"
          class="w-full rounded border border-gray-300 px-2 py-1"
          placeholder="例：不要按编程语言分；把购物类合并成一个"
        />
      </div>
    </section>
  </main>
</template>
