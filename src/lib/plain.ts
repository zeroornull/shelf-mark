import { toRaw } from 'vue';

/**
 * Deep JSON-serializable clone for `storage.local` / `structuredClone`.
 * Vue reactive Proxies, functions, and Error instances cannot be cloned by
 * `browser.storage` / WXT `setValue`; this strips them at the storage boundary.
 */
export function toPlain<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(toRaw(value), replaceNonPlain)) as T;
}

function replaceNonPlain(_key: string, value: unknown): unknown {
  if (value instanceof Error) return value.message;
  return value;
}
