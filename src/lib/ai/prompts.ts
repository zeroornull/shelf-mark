/**
 * 计划 §12 的三段 system prompt（原文照搬）+ §6.3 / §6.4 / §6.5 的 user payload 构造。
 *
 * payload 里永远没有真实 id：书签用批次内 `i`，已有文件夹用 `f*`，类目用本地重编号后的 `c*`。
 */

export const PROPOSE_SYSTEM = `你是书签分类助手。根据书签的域名分布和样例标题，生成稳定、互斥、可复用的文件夹类目。
规则：
- seedCategories 是用户指定的顶层类目，必须全部保留，可在其下补充二级类目
- 遵守 userHint
- 优先复用 existingFolders：类目与某个已有文件夹语义相同时，把它的 ref（如 "f3"）填到 existingFolderRef
- 类目总数 4–12 个，中文短名，最多两层（parentId 指向同一输出里的父类目 id）
- 不要为单一网站建一个类目，除非站点本身就是一个产品线
- 类目要能覆盖绝大多数域名，避免出现只能归入「其他」的大块空白
- 只输出 JSON，shape: { "categories": [{ "id", "title", "parentId?", "existingFolderRef?" }] }`;

export const REFINE_SYSTEM = `已有类目列表如下，但仍有一批书签无法归入。根据这批书签的域名分布，补充最多 6 个新类目（可以是已有类目的子类目，parentId 填已有类目 id）。
规则：
- 不要重复已有类目
- 遵守 seedCategories 和 userHint
- 只输出 JSON，shape 与生成类目时相同`;

export const ASSIGN_SYSTEM = `你把书签分到已给定的类目中。
规则：
- 只依据 title 和 url
- categoryId 只能是给定列表中的 id（如 "c3"）或 "uncategorized"
- 只返回 { "items": [{ "i", "categoryId", "confidence" }] }
- items 必须覆盖输入的每一个 i
- 无法判断时 categoryId = "uncategorized"
- 不要输出解释，不要复述 url`;

export type DomainStat = { domain: string; count: number; sampleTitles: string[] };
export type ExistingFolderRef = { ref: string; path: string[] };
export type PromptLanguage = 'zh' | 'en';

export type ProposePayload = {
  seedCategories: string[];
  userHint: string;
  existingFolders: ExistingFolderRef[];
  domains: DomainStat[];
  totalBookmarks: number;
  maxDepth: 1 | 2;
  language: PromptLanguage;
};

export function buildProposeUser(payload: ProposePayload): string {
  return JSON.stringify(payload);
}

export type RefineCategory = { id: string; title: string; parentId?: string };

export type RefinePayload = {
  existingCategories: RefineCategory[];
  seedCategories: string[];
  userHint: string;
  existingFolders: ExistingFolderRef[];
  /** 这批未能归入的书签的域名直方图。 */
  domains: DomainStat[];
  uncategorizedCount: number;
  maxDepth: 1 | 2;
  language: PromptLanguage;
};

export function buildRefineUser(payload: RefinePayload): string {
  return JSON.stringify(payload);
}

export type AssignCategory = { id: string; title: string; path: string[] };
export type AssignBookmark = { i: number; title: string; url: string };

export type AssignPayload = {
  categories: AssignCategory[];
  bookmarks: AssignBookmark[];
};

export function buildAssignUser(payload: AssignPayload): string {
  return JSON.stringify(payload);
}
