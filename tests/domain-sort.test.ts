import { describe, expect, it } from 'vitest';
import { domainOf } from '../src/lib/ai/sampling';
import {
  clampDomainMinCount,
  isThematicFolder,
  proposeByDomain,
  titleMatchesDomain,
} from '../src/lib/domain-sort';
import type { FlatBookmark } from '../src/lib/types';

function bm(partial: Partial<FlatBookmark> & Pick<FlatBookmark, 'id' | 'url'>): FlatBookmark {
  return {
    title: partial.title ?? partial.id,
    parentId: partial.parentId ?? '2',
    index: partial.index ?? 0,
    rootId: partial.rootId ?? '2',
    folderPath: partial.folderPath ?? [],
    ...partial,
  };
}

describe('domain-sort helpers', () => {
  it('clamps min count to 1–50, default 1（整理页按域名：一域一夹）', () => {
    expect(clampDomainMinCount(undefined)).toBe(1);
    expect(clampDomainMinCount(1)).toBe(1);
    expect(clampDomainMinCount(0)).toBe(1);
    expect(clampDomainMinCount(99)).toBe(50);
    expect(clampDomainMinCount(5.8)).toBe(6);
  });

  it('matches folder titles to eTLD+1 and first label', () => {
    expect(titleMatchesDomain('github.com', 'github.com')).toBe(true);
    expect(titleMatchesDomain('GitHub', 'github.com')).toBe(true);
    expect(titleMatchesDomain('  ＧｉｔＨｕｂ ', 'github.com')).toBe(true);
    expect(titleMatchesDomain('工作', 'github.com')).toBe(false);
    expect(titleMatchesDomain('com', 'github.com')).toBe(false);
  });

  it('treats non-domain parent folders as thematic', () => {
    expect(isThematicFolder(bm({ id: 'a', url: 'https://github.com/x', folderPath: [] }))).toBe(false);
    expect(isThematicFolder(bm({ id: 'b', url: 'https://github.com/x', folderPath: ['github.com'] }))).toBe(false);
    expect(isThematicFolder(bm({ id: 'c', url: 'https://github.com/x', folderPath: ['工作'] }))).toBe(true);
    expect(isThematicFolder(bm({ id: 'd', url: 'https://github.com/x', folderPath: ['工作', 'GitHub'] }))).toBe(false);
  });
});

describe('proposeByDomain', () => {
  const github = ['a', 'b', 'c'].map((id, i) => bm({ id, url: `https://github.com/${id}`, index: i }));
  const solo = bm({ id: 'solo', url: 'https://rare.example/x', index: 3 });

  it('with minCount 1, every resolvable domain gets its own folder', () => {
    const proposal = proposeByDomain({ bookmarks: [...github, solo], existingFolders: [], minCount: 1 });
    expect(proposal.qualifyingDomains).toEqual(['github.com', 'rare.example']);
    expect(proposal.categories.map((c) => c.title)).toEqual(['github.com', 'rare.example']);
    expect(proposal.belowThreshold).toBe(0);
    expect(proposal.assignments.find((a) => a.bookmarkId === 'solo')?.categoryId).toBe('c2');
  });

  it('builds one category per domain at or above the threshold and files the rest under 其他站点', () => {
    const proposal = proposeByDomain({ bookmarks: [...github, solo], existingFolders: [], minCount: 3 });
    expect(proposal.qualifyingDomains).toEqual(['github.com']);
    expect(proposal.categories).toEqual([
      { id: 'c1', title: 'github.com' },
      { id: 'c2', title: '其他站点' },
    ]);
    expect(proposal.assignments.filter((a) => a.categoryId === 'c1').map((a) => a.bookmarkId)).toEqual(['a', 'b', 'c']);
    expect(proposal.assignments.find((a) => a.bookmarkId === 'solo')).toEqual({
      bookmarkId: 'solo',
      categoryId: 'c2',
      confidence: 'medium',
    });
    expect(proposal.belowThreshold).toBe(1);
    expect(proposal.thematicHeld).toBe(0);
    expect(proposal.warnings).toEqual({ unknownCategory: 0, missingIndex: 0 });
  });

  it('reuses an existing folder named GitHub', () => {
    const proposal = proposeByDomain({
      bookmarks: github,
      existingFolders: [{ id: 'fold-gh', title: 'GitHub', path: ['GitHub'] }],
      minCount: 3,
    });
    expect(proposal.categories[0]).toEqual({ id: 'c1', title: 'github.com', existingFolderId: 'fold-gh' });
  });

  it('prefers an exact domain title over a first-label match, then shallower path', () => {
    const proposal = proposeByDomain({
      bookmarks: github,
      existingFolders: [
        { id: 'deep', title: 'GitHub', path: ['工作', 'GitHub'] },
        { id: 'exact', title: 'github.com', path: ['工作', 'github.com'] },
        { id: 'shallow', title: 'github.com', path: ['github.com'] },
      ],
      minCount: 3,
    });
    expect(proposal.categories[0]?.existingFolderId).toBe('shallow');
  });

  it('does not pull bookmarks out of a thematic folder when keepThematic is on', () => {
    const inside = bm({ id: 'in-work', url: 'https://github.com/in', folderPath: ['工作'], parentId: 'work' });
    const proposal = proposeByDomain({
      bookmarks: [...github, inside],
      existingFolders: [{ id: 'work', title: '工作', path: ['工作'] }],
      minCount: 3,
      keepThematic: true,
    });
    expect(proposal.assignments.find((a) => a.bookmarkId === 'in-work')?.categoryId).toBe('uncategorized');
    expect(proposal.thematicHeld).toBe(1);
  });

  it('assigns thematic-folder bookmarks when keepThematic is false', () => {
    const inside = bm({ id: 'in-work', url: 'https://github.com/in', folderPath: ['工作'], parentId: 'work' });
    const proposal = proposeByDomain({
      bookmarks: [...github, inside],
      existingFolders: [],
      minCount: 3,
      keepThematic: false,
    });
    expect(proposal.assignments.find((a) => a.bookmarkId === 'in-work')?.categoryId).toBe('c1');
    expect(proposal.thematicHeld).toBe(0);
  });

  it('reuses an existing 其他站点 folder', () => {
    const proposal = proposeByDomain({
      bookmarks: [...github, solo],
      existingFolders: [{ id: 'other-sites', title: '其他站点', path: ['其他站点'] }],
      minCount: 3,
    });
    expect(proposal.categories[1]).toEqual({ id: 'c2', title: '其他站点', existingFolderId: 'other-sites' });
  });

  it('skips unknown / script URLs as folder names', () => {
    const junk = [0, 1, 2].map((i) => bm({ id: `j${i}`, url: 'javascript:void(0)' }));
    const proposal = proposeByDomain({ bookmarks: junk, existingFolders: [], minCount: 2 });
    expect(proposal.categories).toEqual([]);
    expect(proposal.assignments.every((a) => a.categoryId === 'uncategorized')).toBe(true);
    expect(domainOf('javascript:void(0)')).toMatch(/javascript|^unknown$/);
  });

  it('detects duplicate URLs without deleting them', () => {
    const dups = [
      bm({ id: 'd1', url: 'https://github.com/dup/repo' }),
      bm({ id: 'd2', url: 'https://github.com/dup/repo/' }),
      bm({ id: 'd3', url: 'https://github.com/other' }),
    ];
    const proposal = proposeByDomain({ bookmarks: dups, existingFolders: [], minCount: 3 });
    expect(proposal.duplicates).toEqual([{ url: 'https://github.com/dup/repo', bookmarkIds: ['d1', 'd2'] }]);
  });
});
