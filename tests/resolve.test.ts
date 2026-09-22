import { describe, expect, it } from 'vitest';
import { isKeepStillMove, listApplyCandidates, resolveMoves } from '../src/lib/jobs/resolve';
import type { Proposal, ReviewState } from '../src/lib/types';

/**
 * resolveMoves（§5.3 第 2 步）：existingFolderId 只对同根生效；[M4] 父类目复用了同根已有文件夹时，
 * 子类目以它为起点（baseParentId），不在根下重建同名父文件夹。
 */

const review: ReviewState = { excluded: [], includeUncategorized: false, includeDuplicates: false };

/** 已有文件夹：其他书签/工作（fWork）、其他书签/工作/前端（fFe）、书签栏/工作（fBarWork）。 */
const folderRoot = (id: string) => ({ fWork: '2', fFe: '2', fBarWork: '1' } as Record<string, string>)[id];

const proposal = (): Proposal => ({
  categories: [
    { id: 'c1', title: '工作', existingFolderId: 'fWork' },
    { id: 'c2', title: '前端', parentId: 'c1', existingFolderId: 'fFe' }, // 叶子自己复用
    { id: 'c3', title: 'React', parentId: 'c1' }, // 父复用、自己新建
    { id: 'c4', title: '生活' },
    { id: 'c5', title: '购物', parentId: 'c4' }, // 父不复用
  ],
  assignments: [
    { bookmarkId: 'o-fe', categoryId: 'c2', confidence: 'high' },
    { bookmarkId: 'o-react', categoryId: 'c3', confidence: 'high' },
    { bookmarkId: 'o-shop', categoryId: 'c5', confidence: 'high' },
    { bookmarkId: 'b-react', categoryId: 'c3', confidence: 'high' },
    { bookmarkId: 'o-work', categoryId: 'c1', confidence: 'high' },
  ],
  duplicates: [],
  warnings: { unknownCategory: 0, missingIndex: 0 },
});

const bookmarks = [
  { id: 'o-fe', rootId: '2', parentId: '2' },
  { id: 'o-react', rootId: '2', parentId: '2' },
  { id: 'o-shop', rootId: '2', parentId: '2' },
  { id: 'b-react', rootId: '1', parentId: '1' },
  { id: 'o-work', rootId: '2', parentId: '2' },
];

describe('resolveMoves', () => {
  const moves = resolveMoves({ proposal: proposal(), review, bookmarks, folderRoot });
  const byId = new Map(moves.map((m) => [m.bookmarkId, m]));

  it('leaf with existingFolderId in the same root → ResolvedMove to that folder', () => {
    expect(byId.get('o-fe')).toEqual({ bookmarkId: 'o-fe', toParentId: 'fFe', expectedParentId: '2' });
    expect(byId.get('o-work')).toEqual({ bookmarkId: 'o-work', toParentId: 'fWork', expectedParentId: '2' });
  });

  it('[M4] child of a parent that reuses a same-root folder → PathMove rooted at that folder (no new top-level 工作)', () => {
    expect(byId.get('o-react')).toEqual({ bookmarkId: 'o-react', baseParentId: 'fWork', toPath: ['React'], expectedParentId: '2' });
  });

  it('other root → full title path from that root (existing folder ids never cross roots)', () => {
    expect(byId.get('b-react')).toEqual({ bookmarkId: 'b-react', toPath: ['工作', 'React'], expectedParentId: '1' });
  });

  it('parent without an existing folder → plain two-level path', () => {
    expect(byId.get('o-shop')).toEqual({ bookmarkId: 'o-shop', toPath: ['生活', '购物'], expectedParentId: '2' });
  });

  it('honours exclusions', () => {
    const out = resolveMoves({ proposal: proposal(), review: { ...review, excluded: ['o-react'] }, bookmarks, folderRoot });
    expect(out.map((m) => m.bookmarkId)).not.toContain('o-react');
    expect(out).toHaveLength(4);
  });

  it('takes expectedParentId from persisted origins, not the live parentId', () => {
    const foldered = [{ id: 'o-fe', rootId: '2', parentId: 'fFe' }];
    const out = resolveMoves({
      proposal: proposal(),
      review,
      bookmarks: foldered,
      folderRoot,
      origins: { 'o-fe': { parentId: 'fFe' } },
    });
    expect(out).toEqual([{ bookmarkId: 'o-fe', toParentId: 'fFe', expectedParentId: 'fFe' }]);

    const moved = [{ id: 'o-fe', rootId: '2', parentId: '2' }];
    const fromOrigin = resolveMoves({
      proposal: proposal(),
      review,
      bookmarks: moved,
      folderRoot,
      origins: { 'o-fe': { parentId: 'old-parent' } },
    });
    expect(fromOrigin[0]).toMatchObject({ bookmarkId: 'o-fe', expectedParentId: 'old-parent' });
  });

  it('treats a path move as keep-still when folderPath already matches toPath', () => {
    expect(
      isKeepStillMove(
        { bookmarkId: 'a', toPath: ['github.com'], expectedParentId: '2' },
        { parentId: 'gh', folderPath: ['github.com'] },
      ),
    ).toBe(true);
    expect(
      isKeepStillMove(
        { bookmarkId: 'a', toPath: ['github.com'], expectedParentId: '2' },
        { parentId: '2', folderPath: [] },
      ),
    ).toBe(false);
    expect(isKeepStillMove({ bookmarkId: 'a', toParentId: 'gh', expectedParentId: 'gh' })).toBe(true);
  });

  it('lists apply candidates including excluded rows so the user can uncheck part of a plan', () => {
    const rows = listApplyCandidates({
      proposal: {
        categories: [{ id: 'c1', title: 'github.com' }, { id: 'c2', title: '其他站点' }],
        assignments: [
          { bookmarkId: 'a', categoryId: 'c1', confidence: 'high' },
          { bookmarkId: 'b', categoryId: 'c2', confidence: 'medium' },
          { bookmarkId: 'c', categoryId: 'uncategorized', confidence: 'low' },
        ],
        duplicates: [],
        warnings: { unknownCategory: 0, missingIndex: 0 },
      },
      review: { excluded: ['b'], includeUncategorized: false, includeDuplicates: true },
      bookmarks: [
        { id: 'a', title: 'Repo', rootId: '2', parentId: '2', folderPath: [] },
        { id: 'b', title: 'Rare', rootId: '2', parentId: '2', folderPath: [] },
        { id: 'c', title: 'Skip', rootId: '2', parentId: '2', folderPath: [] },
      ],
      folderRoot: () => undefined,
      rootTitleOf: () => '其他书签',
    });
    expect(rows.map((r) => r.bookmarkId)).toEqual(['a', 'b']);
    expect(rows.find((r) => r.bookmarkId === 'a')).toMatchObject({
      destLabel: '其他书签 / github.com',
      fromLabel: '其他书签',
      excluded: false,
      keepStill: false,
    });
    expect(rows.find((r) => r.bookmarkId === 'b')).toMatchObject({ destLabel: '其他书签 / 其他站点', excluded: true });
    expect(resolveMoves({
      proposal: {
        categories: [{ id: 'c1', title: 'github.com' }, { id: 'c2', title: '其他站点' }],
        assignments: [
          { bookmarkId: 'a', categoryId: 'c1', confidence: 'high' },
          { bookmarkId: 'b', categoryId: 'c2', confidence: 'medium' },
        ],
        duplicates: [],
        warnings: { unknownCategory: 0, missingIndex: 0 },
      },
      review: { excluded: ['b'], includeUncategorized: false, includeDuplicates: true },
      bookmarks: [
        { id: 'a', rootId: '2', parentId: '2' },
        { id: 'b', rootId: '2', parentId: '2' },
      ],
      folderRoot: () => undefined,
    })).toEqual([{ bookmarkId: 'a', toPath: ['github.com'], expectedParentId: '2' }]);
  });
});
