import { UNCATEGORIZED } from '../ai/taxonomy';
import { normalizeTitle } from '../bookmarks/mutate';
import type { Category, Proposal, ReviewState } from '../types';

/**
 * review 阶段的人工编辑（计划 §7 / §8 第 3 步），全部是返回新对象的纯函数，方便测试与撤销。
 */

export function defaultReviewState(): ReviewState {
  return { excluded: [], includeUncategorized: false, includeDuplicates: false };
}

/** 按域名整理：重复 URL 也按域名归夹；未分类仍默认不移动（主题夹 / 解析失败）。 */
export function defaultDomainReviewState(): ReviewState {
  return { excluded: [], includeUncategorized: false, includeDuplicates: true };
}

/** 改某条书签的类目（`c*` 或 `uncategorized`）；未知类目 id、或目标是有子类目的父类目（纯结构）时原样返回。 */
export function setAssignmentCategory(proposal: Proposal, bookmarkId: string, categoryId: string): Proposal {
  if (categoryId !== UNCATEGORIZED && !proposal.categories.some((c) => c.id === categoryId)) return proposal;
  if (categoryId !== UNCATEGORIZED && hasChildCategories(proposal, categoryId)) return proposal;
  let changed = false;
  const assignments = proposal.assignments.map((a) => {
    if (a.bookmarkId !== bookmarkId || a.categoryId === categoryId) return a;
    changed = true;
    // 人工指定的视为高置信度
    return { ...a, categoryId, confidence: 'high' as const };
  });
  return changed ? { ...proposal, assignments } : proposal;
}

/** 有子类目的类目是纯结构（§0「父类目纯结构」），不能直接放书签，也不能作为合并目标。 */
export function hasChildCategories(proposal: Proposal, categoryId: string): boolean {
  return proposal.categories.some((c) => c.parentId === categoryId);
}

/** 能否把别的类目合并进 `intoId`：目标必须存在且没有子类目（把 A 自己的子类目算进来会让 A→A 的子类目成立，故排除 A 的孩子）。 */
export function canMergeInto(proposal: Proposal, fromId: string, intoId: string): boolean {
  if (fromId === intoId) return false;
  const into = proposal.categories.find((c) => c.id === intoId);
  if (!into) return false;
  return !proposal.categories.some((c) => c.parentId === intoId && c.id !== fromId);
}

/**
 * 把类目 A 合并进 B：A 的书签全部改到 B，A 的子类目挂到 B 下（B 自己有父类目时子类目提升为顶层，保证最多两层），
 * 然后删掉 A。A 或 B 不存在、A === B、或 B 有子类目（纯结构，不能收书签）时原样返回。
 */
export function mergeCategories(proposal: Proposal, fromId: string, intoId: string): Proposal {
  if (fromId === intoId) return proposal;
  const from = proposal.categories.find((c) => c.id === fromId);
  const into = proposal.categories.find((c) => c.id === intoId);
  if (!from || !into) return proposal;
  if (!canMergeInto(proposal, fromId, intoId)) return proposal;

  const intoIsTopLevel = into.parentId === undefined || into.parentId === fromId;
  const categories: Category[] = [];
  for (const category of proposal.categories) {
    if (category.id === fromId) continue;
    let next: Category = { ...category };
    if (next.id === intoId && next.parentId === fromId) {
      // B 原本是 A 的子类目：提升为顶层
      delete next.parentId;
    } else if (next.parentId === fromId) {
      if (intoIsTopLevel) next.parentId = intoId;
      else delete next.parentId;
    }
    categories.push(next);
  }
  // B 若是顶层且现在有了子类目，B 自身仍可保留原有书签（应用时进 B 文件夹本身）
  const assignments = proposal.assignments.map((a) => (a.categoryId === fromId ? { ...a, categoryId: intoId } : a));
  return { ...proposal, categories: fixDanglingParents(categories), assignments };
}

/**
 * 重命名类目。新名字 normalize 后与旧名字不同时，清掉 `existingFolderId`（用户显然想要一个新名字的文件夹），
 * 再按 `existingFolders` 重新匹配同名文件夹。空名字原样返回。
 */
export function renameCategory(
  proposal: Proposal,
  categoryId: string,
  title: string,
  existingFolders: ReadonlyArray<{ id: string; title: string }> = [],
): Proposal {
  const trimmed = title.trim();
  if (trimmed === '') return proposal;
  let changed = false;
  const categories = proposal.categories.map((c) => {
    if (c.id !== categoryId || c.title === trimmed) return c;
    changed = true;
    const next: Category = { ...c, title: trimmed };
    if (normalizeTitle(c.title) !== normalizeTitle(trimmed)) {
      delete next.existingFolderId;
      const key = normalizeTitle(trimmed);
      const match = existingFolders.find((f) => normalizeTitle(f.title) === key);
      if (match) next.existingFolderId = match.id;
    }
    return next;
  });
  return changed ? { ...proposal, categories } : proposal;
}

export function excludeBookmark(review: ReviewState, bookmarkId: string): ReviewState {
  if (review.excluded.includes(bookmarkId)) return review;
  return { ...review, excluded: [...review.excluded, bookmarkId] };
}

export function includeBookmark(review: ReviewState, bookmarkId: string): ReviewState {
  if (!review.excluded.includes(bookmarkId)) return review;
  return { ...review, excluded: review.excluded.filter((id) => id !== bookmarkId) };
}

export function setIncludeUncategorized(review: ReviewState, value: boolean): ReviewState {
  return review.includeUncategorized === value ? review : { ...review, includeUncategorized: value };
}

export function setIncludeDuplicates(review: ReviewState, value: boolean): ReviewState {
  return review.includeDuplicates === value ? review : { ...review, includeDuplicates: value };
}

/** 每个类目（含 uncategorized）当前有多少条书签。 */
export function countByCategory(proposal: Proposal): Map<string, number> {
  const counts = new Map<string, number>();
  for (const category of proposal.categories) counts.set(category.id, 0);
  counts.set(UNCATEGORIZED, 0);
  for (const a of proposal.assignments) counts.set(a.categoryId, (counts.get(a.categoryId) ?? 0) + 1);
  return counts;
}

function fixDanglingParents(categories: Category[]): Category[] {
  const ids = new Set(categories.map((c) => c.id));
  return categories.map((c) => {
    if (c.parentId === undefined || ids.has(c.parentId)) return c;
    const next = { ...c };
    delete next.parentId;
    return next;
  });
}
