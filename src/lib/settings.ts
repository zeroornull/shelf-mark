import { storage } from 'wxt/utils/storage';
import { toPlain } from './plain';
import { clampRequestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS } from './request-timeout';
import type { Settings } from './types';

// API Key 只进 storage.local，绝不 sync。
export const settingsStorage = storage.defineItem<Settings>('local:settings', {
  fallback: {
    provider: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
    },
    scope: 'loose-other',
    includeFoldered: true,
    maxDepth: 2,
    batchSize: 30,
    concurrency: 2,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    language: 'auto',
    domainOnly: false,
    autoBackup: true,
    seedCategories: [],
    userHint: '',
  },
});

/** 落盘前压成纯 JSON，避免 Vue Proxy 让 `setValue` 内部的 `structuredClone` 抛错。 */
export async function persistSettings(value: Settings): Promise<void> {
  await settingsStorage.setValue(
    toPlain({ ...value, requestTimeoutMs: clampRequestTimeoutMs(value.requestTimeoutMs) }),
  );
}
