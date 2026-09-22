import { computed, onScopeDispose, ref, toRaw, watch } from 'vue';
import { clampDomainMinCount } from '@/lib/domain-sort';
import { toPlain } from '@/lib/plain';
import { clampRequestTimeoutMs } from '@/lib/request-timeout';
import { persistSettings, settingsStorage } from '@/lib/settings';
import type { Settings } from '@/lib/types';

/**
 * 响应式设置：加载 `settingsStorage`、监听其他页面的修改、本地改动自动（防抖）写回。
 *
 * 回写与监听会互相触发：用「上次同步的 JSON」去重，storage 回显的同一份值不会再写一次。
 */
export function useSettings(options: { debounceMs?: number } = {}) {
  const debounceMs = options.debounceMs ?? 250;
  const settings = ref<Settings>(structuredClone(settingsStorage.fallback));
  const loaded = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);

  let lastSynced = JSON.stringify(settings.value);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function applyRemote(value: Settings | null): void {
    const next = value ?? structuredClone(settingsStorage.fallback);
    if (next.includeFoldered === undefined) next.includeFoldered = true;
    next.domainMinCount = clampDomainMinCount(next.domainMinCount);
    next.requestTimeoutMs = clampRequestTimeoutMs(next.requestTimeoutMs);
    const json = JSON.stringify(next);
    if (json === lastSynced) return;
    lastSynced = json;
    settings.value = next;
  }

  async function load(): Promise<void> {
    try {
      applyRemote(await settingsStorage.getValue());
      error.value = null;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loaded.value = true;
    }
  }

  async function flush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const value = toPlain(toRaw(settings.value));
    const json = JSON.stringify(value);
    if (json === lastSynced) return;
    lastSynced = json;
    saving.value = true;
    try {
      await persistSettings(value);
      error.value = null;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      saving.value = false;
    }
  }

  watch(
    settings,
    () => {
      if (!loaded.value) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => void flush(), debounceMs);
    },
    { deep: true },
  );

  const unwatch = settingsStorage.watch((value) => applyRemote(value));
  onScopeDispose(() => {
    unwatch();
    if (timer !== undefined) clearTimeout(timer);
  });

  const hasApiKey = computed(() => settings.value.provider.apiKey.trim() !== '');

  void load();

  return { settings, loaded, saving, error, hasApiKey, reload: load, flush };
}

/** baseUrl 的 origin（`https://api.openai.com`）；非法 URL 返回 null。 */
export function originOf(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}
