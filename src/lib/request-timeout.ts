/** 生成类目 / 归类每次请求的上限。设置项与 `chatJson` 默认值共用。ping 另算，保持 20s。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
export const MIN_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_REQUEST_TIMEOUT_MS = 600_000;

/** 缺省 / 非数字 → 180s；夹到 30s–10min。 */
export function clampRequestTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, Math.round(value)));
}
