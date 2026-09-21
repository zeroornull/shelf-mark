import { describe, expect, it } from 'vitest';
import { canMergeInto, countByCategory, hasChildCategories, mergeCategories, renameCategory, setAssignmentCategory } from '../src/lib/jobs/review';
import type { Proposal } from '../src/lib/types';

const proposal = (): Proposal => ({
  categories: [
    { id: 'c1', title: '开发' },
    { id: 'c2', title: '前端', parentId: 'c1' },
    { id: 'c3', title: '后端', parentId: 'c1' },
    { id: 'c4', title: '生活', existingFolderId: 'real-life' },
    { id: 'c5', title: '购物', parentId: 'c4' },
  ],
  assignments: [
    { bookmarkId: 'a', categoryId: 'c2', confidence: 'high' },
    { bookmarkId: 'b', categoryId: 'c3', confidence: 'low' },
    { bookmarkId: 'c', categoryId: 'c5', confidence: 'medium' },
    { bookmarkId: 'd', categoryId: 'uncategorized', confidence: 'low' },
  ],
  duplicates: [],
  warnings: { unknownCategory: 0, missingIndex: 0 },
});

describe('mergeCategories', () => {
  it('[L4] refuses to merge into a category that has children (parents are pure structure)', () => {
    const p = proposal();
    expect(canMergeInto(p, 'c1', 'c4')).toBe(false); // c4 有子类目 c5
    expect(mergeCategories(p, 'c1', 'c4')).toBe(p);
    expect(canMergeInto(p, 'c2', 'c1')).toBe(false); // c1 有 c2、c3；除去 c2 自己还有 c3
    expect(mergeCategories(p, 'c2', 'c1')).toBe(p);
    expect(hasChildCategories(p, 'c1')).toBe(true);
    expect(hasChildCategories(p, 'c2')).toBe(false);
  });

  it('merging a parent into a leaf category re-parents its children and moves its bookmarks', () => {
    const next = mergeCategories(proposal(), 'c1', 'c5');
    // c5 是二级类目：c1 的孩子提升为顶层（保证 ≤ 2 层）
    expect(next.categories.find((c) => c.id === 'c2')).toEqual({ id: 'c2', title: '前端' });
    expect(next.categories.find((c) => c.id === 'c3')).toEqual({ id: 'c3', title: '后端' });
    expect(next.categories.some((c) => c.id === 'c1')).toBe(false);
  });

  it('merging a leaf into a sibling leaf moves the bookmarks; collapsing the only child into its parent is allowed', () => {
    const p = proposal();
    const next = mergeCategories(p, 'c2', 'c3');
    expect(next.categories.map((c) => c.id)).toEqual(['c1', 'c3', 'c4', 'c5']);
    expect(next.assignments.find((a) => a.bookmarkId === 'a')?.categoryId).toBe('c3');

    // c5 是 c4 唯一的子类目：合并进 c4 后 c4 成为叶子，可以收书签
    expect(canMergeInto(p, 'c5', 'c4')).toBe(true);
    const collapsed = mergeCategories(p, 'c5', 'c4');
    expect(collapsed.categories.some((c) => c.id === 'c5')).toBe(false);
    expect(collapsed.assignments.find((a) => a.bookmarkId === 'c')?.categoryId).toBe('c4');
    expect(hasChildCategories(collapsed, 'c4')).toBe(false);
  });

  it('merging a parent into a second-level category lifts the orphaned children to the top level (depth ≤ 2)', () => {
    const next = mergeCategories(proposal(), 'c1', 'c5');
    expect(next.categories.find((c) => c.id === 'c2')?.parentId).toBeUndefined();
    expect(next.categories.find((c) => c.id === 'c3')?.parentId).toBeUndefined();
    expect(next.categories.find((c) => c.id === 'c5')?.parentId).toBe('c4');
  });

  it('merging a parent into its own child lifts the child to the top level', () => {
    const next = mergeCategories(proposal(), 'c4', 'c5');
    expect(next.categories.find((c) => c.id === 'c5')).toEqual({ id: 'c5', title: '购物' });
    expect(next.assignments.find((a) => a.bookmarkId === 'c')?.categoryId).toBe('c5');
  });

  it('is a no-op for unknown ids or self-merge', () => {
    const p = proposal();
    expect(mergeCategories(p, 'c1', 'c1')).toBe(p);
    expect(mergeCategories(p, 'nope', 'c1')).toBe(p);
    expect(mergeCategories(p, 'c1', 'nope')).toBe(p);
  });
});

describe('setAssignmentCategory / renameCategory / countByCategory', () => {
  it('setAssignmentCategory marks manual choices as high confidence and ignores unknown categories', () => {
    const p = proposal();
    const next = setAssignmentCategory(p, 'b', 'c2');
    expect(next.assignments[1]).toEqual({ bookmarkId: 'b', categoryId: 'c2', confidence: 'high' });
    expect(setAssignmentCategory(p, 'b', 'c99')).toBe(p);
    expect(setAssignmentCategory(p, 'ghost', 'c2')).toBe(p);
    expect(setAssignmentCategory(p, 'a', 'c2')).toBe(p); // 没变
  });

  it('renameCategory keeps existingFolderId when only casing/whitespace changes, clears it otherwise', () => {
    const kept = renameCategory(proposal(), 'c4', ' 生活');
    expect(kept.categories[3]).toEqual({ id: 'c4', title: '生活', existingFolderId: 'real-life' });
    const cleared = renameCategory(proposal(), 'c4', '日常');
    expect(cleared.categories[3]).toEqual({ id: 'c4', title: '日常' });
    const rematched = renameCategory(proposal(), 'c4', 'shopping', [{ id: 'real-shop', title: 'Shopping' }]);
    expect(rematched.categories[3]).toEqual({ id: 'c4', title: 'shopping', existingFolderId: 'real-shop' });
  });

  it('countByCategory includes zero counts and uncategorized', () => {
    const counts = countByCategory(proposal());
    expect([...counts.entries()]).toEqual([
      ['c1', 0],
      ['c2', 1],
      ['c3', 1],
      ['c4', 0],
      ['c5', 1],
      ['uncategorized', 1],
    ]);
  });

  it('[L4] setAssignmentCategory refuses a parent category as target', () => {
    const p = proposal();
    expect(setAssignmentCategory(p, 'a', 'c1')).toBe(p); // c1 有子类目
    expect(setAssignmentCategory(p, 'a', 'c4')).toBe(p);
    expect(setAssignmentCategory(p, 'a', 'c3').assignments.find((x) => x.bookmarkId === 'a')?.categoryId).toBe('c3');
  });
});
