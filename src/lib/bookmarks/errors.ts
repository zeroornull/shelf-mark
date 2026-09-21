import type { SkipReason } from './snapshot';

/**
 * 书签层面向用户的中文文案（与 `ai/client.ts` 的 `describeAiError` 对应）。
 * 匹配的是 Chrome `bookmarks.*` 抛出的英文错误原文（`bookmarks_api_constants.cc`），fake 实现用同样的措辞。
 */

const PATTERNS: Array<[RegExp, string]> = [
  [/can't find bookmark/i, '书签或文件夹不存在（可能已被删除）'],
  [/managed bookmarks/i, '企业策略书签不可修改'],
  [/root bookmark folders/i, '不能修改书签根节点'],
  [/index out of bounds/i, '目标位置越界'],
  [/editing is disabled|not editable/i, '浏览器策略禁止编辑书签'],
  [/non-empty folder/i, '文件夹非空，未删除'],
  [/invalid url/i, '网址无效'],
  [/to itself or its descendant/i, '不能把文件夹移到自己或子文件夹里'],
];

export function describeBookmarkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  for (const [pattern, text] of PATTERNS) {
    if (pattern.test(message)) return `${text}（${message}）`;
  }
  return message;
}

const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  duplicate: '计划里出现了两次，只按第一次处理',
  missing: '书签已不存在（预览后被删除）',
  'not-a-bookmark': '不是书签（文件夹不移动）',
  managed: '企业策略书签，不可修改',
  'no-root': '不在书签栏 / 其他书签 / 移动书签下',
  'parent-changed': '预览后被移到了别的文件夹，已按现状保留',
  'target-missing': '目标文件夹已不存在',
  'cross-root': '目标文件夹在另一个根下，不跨根移动',
  'same-parent': '已经在目标文件夹里，无需移动',
};

/** `job.skipped[].reason` → 中文；未知原因原样返回。 */
export function describeSkipReason(reason: string): string {
  return (SKIP_REASON_TEXT as Record<string, string>)[reason] ?? reason;
}
