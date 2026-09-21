import { normalizeTitle } from '../bookmarks/mutate';
import type { Category, FlatBookmark } from '../types';
import type { ChatFn } from './client';
import {
  PROPOSE_SYSTEM,
  REFINE_SYSTEM,
  buildProposeUser,
  buildRefineUser,
  type ExistingFolderRef,
  type PromptLanguage,
} from './prompts';
import { domainHistogram } from './sampling';
import { refineSchema, taxonomySchema, type RawCategory } from './schema';

/**
 * 类目生成（propose）与二轮补类目（refine），计划 §6.3 / §6.5。
 *
 * 模型永远看不到真实 id：已有文件夹以 `f0, f1…` 引用（映射表只在本地），
 * 模型自拟的类目 id 只在本次输出内部有效，落地前统一重编号为 `c1…cN`。
 * 所有后处理都在纯函数 `finalizeTaxonomy` 里，方便测试。
 */

export type ExistingFolder = { id: string; title: string; path: string[] };

export type TaxonomyDeps = { chat: ChatFn };

export type ProposeInput = {
  /** 整理范围内的书签（只用 title / url 做直方图）。 */
  bookmarks: ReadonlyArray<Pick<FlatBookmark, 'title' | 'url'>>;
  existingFolders: ExistingFolder[];
  seedCategories: string[];
  userHint: string;
  maxDepth: 1 | 2;
  language: PromptLanguage;
  signal?: AbortSignal;
};

export type RefineInput = ProposeInput & {
  /** 当前全部类目（refine 输出续接其编号，可引用其 id 作 parentId）。 */
  categories: Category[];
};

export type TaxonomyResult = {
  /** 全部类目（refine 时 = 原有 + 新增）。 */
  categories: Category[];
  /** 本次新增的类目。 */
  added: Category[];
  /** 可被 assign 的类目：没有子类目的那些（maxDepth=1 时 = 全部）。 */
  leafCategories: Category[];
};

export const MAX_REFINE_CATEGORIES = 6;
export const UNCATEGORIZED = 'uncategorized';

/** 建 `f*` 引用表：payload 只带 ref + path，真实 id 留在本地。 */
export function buildFolderRefs(folders: ExistingFolder[]): { payload: ExistingFolderRef[]; byRef: Map<string, ExistingFolder> } {
  const payload: ExistingFolderRef[] = [];
  const byRef = new Map<string, ExistingFolder>();
  folders.forEach((folder, index) => {
    const ref = `f${index}`;
    byRef.set(ref, folder);
    payload.push({ ref, path: folder.path });
  });
  return { payload, byRef };
}

export async function proposeTaxonomy(input: ProposeInput, deps: TaxonomyDeps): Promise<TaxonomyResult> {
  const refs = buildFolderRefs(input.existingFolders);
  const user = buildProposeUser({
    seedCategories: cleanSeeds(input.seedCategories),
    userHint: input.userHint.trim(),
    existingFolders: refs.payload,
    domains: domainHistogram(input.bookmarks),
    totalBookmarks: input.bookmarks.length,
    maxDepth: input.maxDepth,
    language: input.language,
  });
  const raw = await deps.chat({ system: PROPOSE_SYSTEM, user, schema: taxonomySchema, signal: input.signal });
  console.debug('[shelfmark] propose returned', raw.categories.length, 'categories');
  return finalizeTaxonomy(raw.categories, {
    existing: [],
    refs: refs.byRef,
    existingFolders: input.existingFolders,
    seedCategories: input.seedCategories,
    maxDepth: input.maxDepth,
  });
}

export async function refineTaxonomy(input: RefineInput, deps: TaxonomyDeps): Promise<TaxonomyResult> {
  const refs = buildFolderRefs(input.existingFolders);
  const user = buildRefineUser({
    existingCategories: input.categories.map(({ id, title, parentId }) => (parentId === undefined ? { id, title } : { id, title, parentId })),
    seedCategories: cleanSeeds(input.seedCategories),
    userHint: input.userHint.trim(),
    existingFolders: refs.payload,
    domains: domainHistogram(input.bookmarks),
    uncategorizedCount: input.bookmarks.length,
    maxDepth: input.maxDepth,
    language: input.language,
  });
  const raw = await deps.chat({ system: REFINE_SYSTEM, user, schema: refineSchema, signal: input.signal });
  console.debug('[shelfmark] refine returned', raw.categories.length, 'categories');
  return finalizeTaxonomy(raw.categories, {
    existing: input.categories,
    refs: refs.byRef,
    existingFolders: input.existingFolders,
    seedCategories: input.seedCategories,
    maxDepth: input.maxDepth,
    maxNew: MAX_REFINE_CATEGORIES,
  });
}

export type FinalizeContext = {
  /** 已经落地的类目（propose 时为空；refine 时为当前全部类目）。 */
  existing: Category[];
  /** `f*` → 真实文件夹。 */
  refs: Map<string, ExistingFolder>;
  existingFolders: ExistingFolder[];
  seedCategories: string[];
  maxDepth: 1 | 2;
  /** 最多接受多少个模型新增类目（seed 补齐不计入）；默认不限。 */
  maxNew?: number;
};

/**
 * 本地后处理（§6.3）：
 * 1. 去掉空标题；按 normalize 后的标题去重（与已有类目重复的，parentId 引用转到已有类目）
 * 2. 按输出顺序续编号 `c{N+1}…`，parentId 同步改写；指向不存在的 parentId 丢弃
 * 3. `existingFolderRef` → 真实文件夹 id；没填但 normalize 后与某个已有文件夹同名的自动补 `existingFolderId`
 * 4. seedCategories 模型漏了的本地补上（顶层）；已有的强制为顶层
 * 5. maxDepth=1 → 全部平铺；maxDepth=2 → 深度超过 2 的挂到最顶层祖先，有环的去掉 parentId
 * 6. leafCategories = 没有子类目的类目
 */
export function finalizeTaxonomy(raw: RawCategory[], ctx: FinalizeContext): TaxonomyResult {
  const existing = ctx.existing.map((c) => ({ ...c }));
  const existingIds = new Set(existing.map((c) => c.id));
  const titleToId = new Map<string, string>();
  for (const category of existing) titleToId.set(normalizeTitle(category.title), category.id);

  let nextIndex = nextCategoryIndex(existing);
  const rawToFinal = new Map<string, string>();
  const added: Category[] = [];
  const pendingParents: Array<{ category: Category; rawParentId: string }> = [];

  // 1 + 2：去重、编号
  for (const item of raw) {
    const title = item.title.trim();
    if (title === '') continue;
    const key = normalizeTitle(title);
    const duplicateOf = titleToId.get(key);
    if (duplicateOf !== undefined) {
      if (!rawToFinal.has(item.id)) rawToFinal.set(item.id, duplicateOf);
      continue;
    }
    if (ctx.maxNew !== undefined && added.length >= ctx.maxNew) continue;

    const id = `c${nextIndex++}`;
    const category: Category = { id, title };
    titleToId.set(key, id);
    if (!rawToFinal.has(item.id)) rawToFinal.set(item.id, id);
    if (item.parentId !== undefined) pendingParents.push({ category, rawParentId: item.parentId });

    // 3：existingFolderRef → 真实 id；否则按同名自动补
    const folderId = item.existingFolderRef !== undefined ? ctx.refs.get(item.existingFolderRef)?.id : undefined;
    const matched = folderId ?? matchFolderByTitle(title, ctx.existingFolders);
    if (matched !== undefined) category.existingFolderId = matched;
    added.push(category);
  }

  // 2：parentId 改写。refine 时模型可能直接引用已有 c*，优先按已有 id 解析
  for (const { category, rawParentId } of pendingParents) {
    const resolved = existingIds.has(rawParentId) ? rawParentId : rawToFinal.get(rawParentId);
    if (resolved !== undefined && resolved !== category.id) category.parentId = resolved;
  }

  const all: Category[] = [...existing, ...added];

  // 4：seed 补齐 / 强制顶层
  for (const seed of cleanSeeds(ctx.seedCategories)) {
    const key = normalizeTitle(seed);
    const id = titleToId.get(key);
    if (id !== undefined) {
      const category = all.find((c) => c.id === id);
      if (category) delete category.parentId;
      continue;
    }
    const category: Category = { id: `c${nextIndex++}`, title: seed };
    const matched = matchFolderByTitle(seed, ctx.existingFolders);
    if (matched !== undefined) category.existingFolderId = matched;
    titleToId.set(key, category.id);
    added.push(category);
    all.push(category);
  }

  // 5：maxDepth
  const byId = new Map(all.map((c) => [c.id, c]));
  for (const category of all) {
    if (category.parentId === undefined) continue;
    if (ctx.maxDepth === 1 || !byId.has(category.parentId)) {
      delete category.parentId;
      continue;
    }
    const top = topAncestor(category, byId);
    if (top === undefined) delete category.parentId;
    else if (top !== category.parentId) category.parentId = top;
  }

  // 6：叶子
  const parents = new Set(all.map((c) => c.parentId).filter((id): id is string => id !== undefined));
  const leafCategories = all.filter((c) => !parents.has(c.id));

  return { categories: all, added, leafCategories };
}

/** 类目在文件夹树里的路径：`[父类目标题?, 自身标题]`。 */
export function categoryPath(category: Category, byId: Map<string, Category>): string[] {
  const parent = category.parentId !== undefined ? byId.get(category.parentId) : undefined;
  return parent ? [parent.title, category.title] : [category.title];
}

export function indexCategories(categories: Category[]): Map<string, Category> {
  return new Map(categories.map((c) => [c.id, c]));
}

/** 没有子类目的类目（maxDepth=2 时只有它们可被 assign）。 */
export function leafCategoriesOf(categories: Category[]): Category[] {
  const parents = new Set(categories.map((c) => c.parentId).filter((id): id is string => id !== undefined));
  return categories.filter((c) => !parents.has(c.id));
}

export function cleanSeeds(seeds: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const seed of seeds) {
    const title = seed.trim();
    const key = normalizeTitle(title);
    if (title === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(title);
  }
  return out;
}

function nextCategoryIndex(existing: Category[]): number {
  let max = 0;
  for (const category of existing) {
    const match = /^c(\d+)$/.exec(category.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function matchFolderByTitle(title: string, folders: ExistingFolder[]): string | undefined {
  const key = normalizeTitle(title);
  return folders.find((folder) => normalizeTitle(folder.title) === key)?.id;
}

/** 沿 parentId 走到最顶层祖先的 id；遇到环返回 undefined。 */
function topAncestor(category: Category, byId: Map<string, Category>): string | undefined {
  const visited = new Set<string>([category.id]);
  let current = category.parentId !== undefined ? byId.get(category.parentId) : undefined;
  while (current) {
    if (visited.has(current.id)) return undefined;
    visited.add(current.id);
    if (current.parentId === undefined) return current.id;
    const next = byId.get(current.parentId);
    if (!next) return current.id;
    current = next;
  }
  return undefined;
}
