import { storage } from 'wxt/utils/storage';
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
    maxDepth: 2,
    batchSize: 30,
    concurrency: 2,
    language: 'auto',
    domainOnly: false,
    autoBackup: true,
    seedCategories: [],
    userHint: '',
  },
});
