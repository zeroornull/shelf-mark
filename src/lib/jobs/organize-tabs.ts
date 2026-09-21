/**
 * organize 页多开 / 存活判断的纯逻辑（浏览器 API 的调用在 `composables/useOrganizeTab.ts`）。
 *
 * 背景：snapshot 处于 `applying` 时，可能是「某个 organize 页正在写」也可能是「页面死了」。
 * 判断依据是 `runtime.getContexts` 里有没有 organize 页的 TAB context；organize 页自己判断时要排除自身。
 * 判断不了（API 不可用 / 抛错）一律按「可能开着」处理，宁可少给一个回滚按钮。
 */

export type OrganizeContextLike = { tabId?: number; documentId?: string };
export type OrganizePresence = 'open' | 'closed' | 'unknown';

export function isSameContext(a: OrganizeContextLike, self: OrganizeContextLike): boolean {
  if (self.documentId !== undefined && a.documentId !== undefined) return a.documentId === self.documentId;
  if (self.tabId !== undefined && a.tabId !== undefined) return a.tabId === self.tabId;
  return false;
}

/** `contexts` 为 null 表示查不到（API 不可用）→ 'unknown'。 */
export function presenceOf(contexts: OrganizeContextLike[] | null, self?: OrganizeContextLike): OrganizePresence {
  if (contexts === null) return 'unknown';
  const others = self ? contexts.filter((c) => !isSameContext(c, self)) : contexts;
  return others.length > 0 ? 'open' : 'closed';
}

/** 从 `tabs.query` 结果里挑一个可聚焦的 organize 标签（第一个有 id 的）。 */
export function pickOrganizeTab(tabs: ReadonlyArray<{ id?: number; windowId?: number }>): { id: number; windowId?: number } | null {
  for (const tab of tabs) {
    if (tab.id !== undefined) return tab.windowId !== undefined ? { id: tab.id, windowId: tab.windowId } : { id: tab.id };
  }
  return null;
}
