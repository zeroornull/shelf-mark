import { computed, ref, watch, type Ref } from 'vue';
import { browser } from 'wxt/browser';
import { originOf } from './useSettings';

/**
 * 当前 baseUrl 的 origin 是否已获 host 权限。
 *
 * - `check()`：`permissions.contains`，页面加载和 baseUrl 变化时自动调用
 * - `request()`：`permissions.request`，**必须在用户手势（click handler）里调用**，不要在加载时调
 */
export function useHostPermission(baseUrl: Ref<string>) {
  const origin = computed(() => originOf(baseUrl.value));
  const pattern = computed(() => (origin.value ? `${origin.value}/*` : null));
  /** null = 未知（origin 非法或 API 不可用）。 */
  const granted = ref<boolean | null>(null);
  const checking = ref(false);

  async function check(): Promise<boolean | null> {
    if (!pattern.value) {
      granted.value = null;
      return null;
    }
    checking.value = true;
    try {
      granted.value = await browser.permissions.contains({ origins: [pattern.value] });
    } catch {
      granted.value = null;
    } finally {
      checking.value = false;
    }
    return granted.value;
  }

  /** 返回 `{ granted, error }`；origin 不在 optional_host_permissions 内时 Chrome 会抛错，这里转成 error 文本。 */
  async function request(): Promise<{ granted: boolean; error?: string }> {
    if (!pattern.value) return { granted: false, error: 'baseUrl 不是合法的 http(s) 地址' };
    try {
      const result = await browser.permissions.request({ origins: [pattern.value] });
      granted.value = result;
      return { granted: result };
    } catch (e) {
      granted.value = false;
      return { granted: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  watch(pattern, () => void check(), { immediate: true });

  return { origin, pattern, granted, checking, check, request };
}
