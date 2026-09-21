import { describe, expect, it } from 'vitest';
import { createFakeBookmarksApi, type SeedNode } from '../src/lib/bookmarks/fake';
import {
  buildBookmarkTree,
  countLooseByRoot,
  countSelectedByRoot,
  isLoose,
  listEmptiedUserFolders,
  listLooseBookmarks,
  listReusableFolders,
  readBookmarkTree,
  selectBookmarksInScope,
} from '../src/lib/bookmarks/tree';

const bm = (title: string, id?: string): SeedNode => ({
  id,
  title,
  url: `https://example.com/${encodeURIComponent(title)}`,
});

/**
 * 故意用误导性的标题和非常规 id：
 * - 「书签栏」这个标题挂在 other 根上，「其他书签」挂在 bookmarks-bar 根上
 * - id 不是 Chrome 常见的 '1' / '2'
 * 只有 folderType 是可信的。
 */
const seed: SeedNode[] = [
  {
    id: '901',
    title: '其他书签',
    folderType: 'bookmarks-bar',
    syncing: false,
    children: [
      bm('bar-loose-1', 'b1'),
      { id: 'f-work', title: '工作', children: [bm('work-1', 'w1'), { id: 'f-fe', title: '前端', children: [bm('fe-1', 'fe1')] }] },
      bm('bar-loose-2', 'b2'),
      { id: 'f-empty-title', title: '', children: [{ id: 'f-inner', title: '内层', children: [bm('inner-1', 'i1')] }] },
    ],
  },
  {
    id: '902',
    title: '书签栏',
    folderType: 'other',
    syncing: false,
    children: [bm('other-loose-1', 'o1'), { id: 'f-life', title: '生活', children: [bm('life-1', 'l1')] }, bm('other-loose-2', 'o2'), bm('other-loose-3', 'o3')],
  },
  {
    id: '903',
    title: '移动设备书签',
    folderType: 'mobile',
    syncing: false,
    children: [bm('mobile-loose-1', 'm1')],
  },
  {
    id: '904',
    title: '托管书签',
    folderType: 'managed',
    unmodifiable: 'managed',
    children: [bm('managed-1', 'mg1'), { id: 'f-managed', title: '公司', unmodifiable: 'managed', children: [bm('managed-2', 'mg2')] }],
  },
];

describe('buildBookmarkTree / readBookmarkTree', () => {
  it('identifies roots by folderType, never by title or id', async () => {
    const api = createFakeBookmarksApi(seed);
    const tree = await readBookmarkTree(api);

    expect(tree.roots.map((r) => [r.id, r.folderType])).toEqual([
      ['901', 'bookmarks-bar'],
      ['902', 'other'],
      ['903', 'mobile'],
    ]);
    // 显示用标题原样保留，但识别不依赖它
    expect(tree.roots[0]?.title).toBe('其他书签');
    expect(tree.nodes.map((n) => n.id)).toEqual(['901', '902', '903']);
  });

  it('excludes the whole managed subtree', async () => {
    const tree = await readBookmarkTree(createFakeBookmarksApi(seed));

    expect(tree.roots.some((r) => r.id === '904')).toBe(false);
    expect(tree.bookmarks.map((b) => b.id)).not.toContain('mg1');
    expect(tree.bookmarks.map((b) => b.id)).not.toContain('mg2');
    expect(tree.nodes.some((n) => n.id === '904')).toBe(false);
  });

  it('skips a managed folder nested inside a normal root', () => {
    const tree = buildBookmarkTree([
      {
        id: '0',
        title: '',
        children: [
          {
            id: '1',
            title: 'bar',
            folderType: 'bookmarks-bar',
            children: [
              { id: 'm', title: 'policy', unmodifiable: 'managed', children: [{ id: 'mb', title: 'x', url: 'https://x' }] },
              { id: 'ok', title: 'ok', url: 'https://ok' },
            ],
          },
        ],
      },
    ]);

    expect(tree.bookmarks.map((b) => b.id)).toEqual(['ok']);
    expect(tree.nodes[0]?.children.map((c) => c.id)).toEqual(['ok']);
  });

  it('ignores top-level nodes without a recognised folderType', () => {
    const tree = buildBookmarkTree([
      {
        id: '0',
        title: '',
        children: [
          { id: '1', title: 'bar', folderType: 'bookmarks-bar', children: [] },
          { id: '99', title: 'Mystery', children: [{ id: 'z', title: 'z', url: 'https://z' }] },
        ],
      },
    ]);

    expect(tree.roots.map((r) => r.id)).toEqual(['1']);
    expect(tree.bookmarks).toEqual([]);
  });

  it('flattens bookmarks with rootId, parentId, index and folderPath (root title excluded)', async () => {
    const tree = await readBookmarkTree(createFakeBookmarksApi(seed));
    const byId = new Map(tree.bookmarks.map((b) => [b.id, b]));

    expect(byId.get('b1')).toMatchObject({ rootId: '901', parentId: '901', index: 0, folderPath: [] });
    expect(byId.get('b2')).toMatchObject({ rootId: '901', parentId: '901', index: 2, folderPath: [] });
    expect(byId.get('fe1')).toMatchObject({ rootId: '901', parentId: 'f-fe', index: 0, folderPath: ['工作', '前端'] });
    expect(byId.get('i1')).toMatchObject({ rootId: '901', parentId: 'f-inner', folderPath: ['', '内层'] });
    expect(byId.get('o3')).toMatchObject({ rootId: '902', parentId: '902', index: 3 });
    expect(byId.get('m1')).toMatchObject({ rootId: '903', parentId: '903' });
    expect(byId.get('b1')?.syncing).toBe(false);
  });
});

describe('dual sync/local trees', () => {
  const dual: SeedNode[] = [
    { id: '1', title: 'Bookmarks bar', folderType: 'bookmarks-bar', syncing: false, children: [bm('local-loose', 'll'), { id: 'lf', title: '工作', children: [] }] },
    { id: '2', title: 'Other bookmarks', folderType: 'other', syncing: false, children: [bm('local-other', 'lo')] },
    { id: '11', title: 'Bookmarks bar', folderType: 'bookmarks-bar', syncing: true, children: [bm('account-loose-a', 'aa'), bm('account-loose-b', 'ab'), { id: 'af', title: '工作', children: [bm('acc-work', 'aw')] }] },
    { id: '12', title: 'Other bookmarks', folderType: 'other', syncing: true, children: [] },
  ];

  it('keeps each tree as its own root with its own bookmarks', async () => {
    const tree = await readBookmarkTree(createFakeBookmarksApi(dual));

    expect(tree.roots.map((r) => [r.id, r.folderType, r.syncing])).toEqual([
      ['1', 'bookmarks-bar', false],
      ['2', 'other', false],
      ['11', 'bookmarks-bar', true],
      ['12', 'other', true],
    ]);
    const rootOf = (id: string) => tree.bookmarks.find((b) => b.id === id)?.rootId;
    expect(rootOf('ll')).toBe('1');
    expect(rootOf('aa')).toBe('11');
    expect(rootOf('aw')).toBe('11');
    expect(tree.bookmarks.find((b) => b.id === 'aa')?.syncing).toBe(true);

    expect(countLooseByRoot(tree).map(({ root, count }) => [root.id, count])).toEqual([
      ['1', 1],
      ['2', 1],
      ['11', 2],
      ['12', 0],
    ]);
  });

  it('lists reusable folders per root only', async () => {
    const tree = await readBookmarkTree(createFakeBookmarksApi(dual));

    expect(listReusableFolders(tree, '1').map((f) => f.id)).toEqual(['lf']);
    expect(listReusableFolders(tree, '11').map((f) => f.id)).toEqual(['af']);
    expect(listReusableFolders(tree, '12')).toEqual([]);
    expect(listReusableFolders(tree, 'nope')).toEqual([]);
  });
});

describe('isLoose / listLooseBookmarks', () => {
  it('treats only bookmarks directly under bookmarks-bar or other as loose', async () => {
    const tree = await readBookmarkTree(createFakeBookmarksApi(seed));
    const byId = new Map(tree.bookmarks.map((b) => [b.id, b]));

    expect(isLoose(byId.get('b1')!, tree)).toBe(true);
    expect(isLoose(byId.get('o2')!, tree)).toBe(true);
    expect(isLoose(byId.get('w1')!, tree)).toBe(false); // inside 工作
    expect(isLoose(byId.get('fe1')!, tree)).toBe(false); // nested
    expect(isLoose(byId.get('m1')!, tree)).toBe(false); // mobile root is not a loose root

    expect(listLooseBookmarks(tree).map((b) => b.id)).toEqual(['b1', 'b2', 'o1', 'o2', 'o3']);
    expect(countLooseByRoot(tree).map(({ root, count }) => [root.folderType, count])).toEqual([
      ['bookmarks-bar', 2],
      ['other', 3],
      ['mobile', 0],
    ]);
  });
});

describe('listReusableFolders', () => {
  it('returns nested named folders with paths, skipping unnamed folders but keeping their children', async () => {
    const tree = await readBookmarkTree(createFakeBookmarksApi(seed));

    expect(listReusableFolders(tree, '901')).toEqual([
      { id: 'f-work', title: '工作', path: ['工作'], rootId: '901' },
      { id: 'f-fe', title: '前端', path: ['工作', '前端'], rootId: '901' },
      { id: 'f-inner', title: '内层', path: ['', '内层'], rootId: '901' },
    ]);
    expect(listReusableFolders(tree, '902').map((f) => f.title)).toEqual(['生活']);
  });
});

describe('selectBookmarksInScope', () => {
  it("'loose-other' + includeFoldered false selects only loose bookmarks of every other-root", async () => {
    const tree = await readBookmarkTree(createFakeBookmarksApi(seed));
    expect(selectBookmarksInScope(tree, 'loose-other', undefined, false).map((b) => b.id)).toEqual(['o1', 'o2', 'o3']);
  });

  it("'loose-bar-and-other' + includeFoldered false includes the bar, but never mobile or foldered", async () => {
    const tree = await readBookmarkTree(createFakeBookmarksApi(seed));
    expect(selectBookmarksInScope(tree, 'loose-bar-and-other', undefined, false).map((b) => b.id)).toEqual(['b1', 'b2', 'o1', 'o2', 'o3']);
  });

  it('includeFoldered true (default) includes nested bookmarks under scope roots, keeps folderPath / rootId', async () => {
    const tree = await readBookmarkTree(createFakeBookmarksApi(seed));
    const other = selectBookmarksInScope(tree, 'loose-other');
    expect(other.map((b) => b.id)).toEqual(['o1', 'l1', 'o2', 'o3']);
    expect(other.find((b) => b.id === 'l1')).toMatchObject({ rootId: '902', parentId: 'f-life', folderPath: ['生活'] });

    const both = selectBookmarksInScope(tree, 'loose-bar-and-other');
    expect(both.map((b) => b.id)).toEqual(['b1', 'w1', 'fe1', 'b2', 'i1', 'o1', 'l1', 'o2', 'o3']);
    expect(both.find((b) => b.id === 'fe1')).toMatchObject({ rootId: '901', parentId: 'f-fe', folderPath: ['工作', '前端'] });
    expect(both.map((b) => b.id)).not.toContain('m1');
    expect(both.map((b) => b.id)).not.toContain('mg1');
    expect(both.map((b) => b.id)).not.toContain('mg2');
  });

  it('never crosses roots and still excludes managed nested inside a normal root', () => {
    const tree = buildBookmarkTree([
      {
        id: '0',
        title: '',
        children: [
          {
            id: '1',
            title: 'bar',
            folderType: 'bookmarks-bar',
            children: [
              { id: 'm', title: 'policy', unmodifiable: 'managed', children: [{ id: 'mb', title: 'x', url: 'https://x' }] },
              { id: 'ok', title: 'ok', url: 'https://ok' },
              { id: 'f', title: '工作', children: [{ id: 'w', title: 'w', url: 'https://w' }] },
            ],
          },
        ],
      },
    ]);
    expect(selectBookmarksInScope(tree, 'loose-bar-and-other').map((b) => b.id)).toEqual(['ok', 'w']);
    expect(selectBookmarksInScope(tree, 'loose-other')).toEqual([]);
  });

  it('applies debugLimit after inclusion, ignoring 0 / undefined', async () => {
    const tree = await readBookmarkTree(createFakeBookmarksApi(seed));
    expect(selectBookmarksInScope(tree, 'loose-bar-and-other', 2, false).map((b) => b.id)).toEqual(['b1', 'b2']);
    expect(selectBookmarksInScope(tree, 'loose-other', 1, false).map((b) => b.id)).toEqual(['o1']);
    expect(selectBookmarksInScope(tree, 'loose-other', 0, false)).toHaveLength(3);
    expect(selectBookmarksInScope(tree, 'loose-other', undefined, false)).toHaveLength(3);
    expect(selectBookmarksInScope(tree, 'loose-other', 99, false)).toHaveLength(3);
    // includeFoldered 之后再截：DFS 顺序 b1, w1, fe1… 而不是先截散装
    expect(selectBookmarksInScope(tree, 'loose-bar-and-other', 2, true).map((b) => b.id)).toEqual(['b1', 'w1']);
    expect(selectBookmarksInScope(tree, 'loose-other', 2, true).map((b) => b.id)).toEqual(['o1', 'l1']);
  });

  it('countSelectedByRoot splits loose vs foldered per root', async () => {
    const tree = await readBookmarkTree(createFakeBookmarksApi(seed));
    const selected = selectBookmarksInScope(tree, 'loose-bar-and-other', undefined, true);
    expect(countSelectedByRoot(tree, selected).map(({ root, total, loose, foldered }) => [root.id, total, loose, foldered])).toEqual([
      ['901', 5, 2, 3],
      ['902', 4, 3, 1],
      ['903', 0, 0, 0],
    ]);
    const looseOnly = selectBookmarksInScope(tree, 'loose-other', undefined, false);
    expect(countSelectedByRoot(tree, looseOnly).map(({ root, total, loose, foldered }) => [root.folderType, total, loose, foldered])).toEqual([
      ['bookmarks-bar', 0, 0, 0],
      ['other', 3, 3, 0],
      ['mobile', 0, 0, 0],
    ]);
  });

  it('listEmptiedUserFolders reports empty non-root, non-created folders only', async () => {
    const tree = await readBookmarkTree(createFakeBookmarksApi(seed));
    const emptied = listEmptiedUserFolders(tree, ['f-work', 'f-fe', '901', 'created-new'], new Set(['created-new']));
    // f-work / f-fe 还有书签；根和本次新建的都排除
    expect(emptied).toEqual([]);

    const emptyTree = buildBookmarkTree([
      {
        id: '0',
        title: '',
        children: [
          {
            id: '2',
            title: 'other',
            folderType: 'other',
            children: [{ id: 'old', title: '旧分类', children: [] }],
          },
        ],
      },
    ]);
    expect(listEmptiedUserFolders(emptyTree, ['old', '2', 'brand-new'], new Set(['brand-new']))).toEqual([{ id: 'old', path: ['旧分类'] }]);
  });
});
