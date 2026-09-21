import { browser } from 'wxt/browser';
import { pickOrganizeTab, presenceOf, type OrganizeContextLike, type OrganizePresence } from '@/lib/jobs/organize-tabs';

/**
 * organize 页的打开 / 聚焦 / 探测。都不需要 `tabs` 权限：
 * - `tabs.query({ url })` 对扩展自己的页面 URL 总是可见
 * - `tabs.getCurrent` / `tabs.update` / `windows.update` 不读 url / title
 * - `runtime.getContexts` 是 Chrome 116+ 的 runtime API
 */

export const ORGANIZE_PATH = '/organize.html';

export function organizeUrl(): string {
  return browser.runtime.getURL(ORGANIZE_PATH);
}

/** 已打开的 organize 页 context 列表；API 不可用 / 抛错 → null（调用方按「可能开着」处理）。 */
export async function listOrganizeContexts(): Promise<OrganizeContextLike[] | null> {
  try {
    if (typeof browser.runtime.getContexts !== 'function') return null;
    const contexts = await browser.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [organizeUrl()] });
    return contexts.map((c) => ({ tabId: c.tabId, documentId: c.documentId }));
  } catch {
    return null;
  }
}

/** 从 sidepanel / options 看：有没有 organize 页开着。 */
export async function detectOrganizePage(): Promise<OrganizePresence> {
  return presenceOf(await listOrganizeContexts());
}

/** 从 organize 页自己看：有没有**别的** organize 页开着（多开标签时另一个可能正在 apply）。 */
export async function detectOtherOrganizePage(): Promise<OrganizePresence> {
  const contexts = await listOrganizeContexts();
  if (contexts === null) return 'unknown';
  let self: OrganizeContextLike | undefined;
  try {
    const tab = await browser.tabs.getCurrent();
    if (tab?.id !== undefined) self = { tabId: tab.id };
  } catch {
    // 拿不到自己的 tab：无法排除自身，只能按 unknown
  }
  if (!self) return 'unknown';
  return presenceOf(contexts, self);
}

/** 已有 organize 页就切过去（并聚焦其窗口），没有才新开。全程不需要 `tabs` 权限。 */
export async function focusOrOpenOrganizePage(): Promise<void> {
  const url = organizeUrl();
  try {
    const existing = pickOrganizeTab(await browser.tabs.query({ url }));
    if (existing) {
      await browser.tabs.update(existing.id, { active: true });
      if (existing.windowId !== undefined) await browser.windows.update(existing.windowId, { focused: true }).catch(() => {});
      return;
    }
  } catch {
    // query / update 失败就退回新开
  }
  await browser.tabs.create({ url });
}
