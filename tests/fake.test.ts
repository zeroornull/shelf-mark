import { describe, expect, it } from 'vitest';
import { createFakeBookmarksApi, type SeedNode } from '../src/lib/bookmarks/fake';

const seed = (): SeedNode[] => [
  { id: '1', title: 'Bookmarks bar', folderType: 'bookmarks-bar', syncing: false, children: [{ id: 'a', title: 'a', url: 'https://a' }] },
  {
    id: '2',
    title: 'Other bookmarks',
    folderType: 'other',
    syncing: false,
    children: [
      { id: 'x', title: 'x', url: 'https://x' },
      { id: 'F', title: 'F', children: [{ id: 'y', title: 'y', url: 'https://y' }, { id: 'G', title: 'G', children: [] }] },
      { id: 'z', title: 'z', url: 'https://z' },
    ],
  },
  { id: '9', title: 'Managed', folderType: 'managed', unmodifiable: 'managed', children: [{ id: 'm', title: 'm', url: 'https://m', unmodifiable: 'managed' }] },
];

describe('fake getTree', () => {
  it('mirrors Chrome shape: one invisible root whose children are the permanent folders, index recomputed', async () => {
    const fake = createFakeBookmarksApi(seed());
    const [root] = await fake.getTree();

    expect(root).toMatchObject({ id: '0', title: '' });
    expect(root?.parentId).toBeUndefined();
    expect(root?.index).toBeUndefined();
    expect(root?.children?.map((c) => [c.id, c.parentId, c.index])).toEqual([
      ['1', '0', 0],
      ['2', '0', 1],
      ['9', '0', 2],
    ]);
    const other = root?.children?.[1];
    expect(other?.children?.map((c) => [c.id, c.index])).toEqual([
      ['x', 0],
      ['F', 1],
      ['z', 2],
    ]);
    // 书签没有 children 字段，文件夹有（空数组也有）
    expect(other?.children?.[0]?.children).toBeUndefined();
    expect(other?.children?.[1]?.children?.[1]?.children).toEqual([]);
  });

  it('returns a deep copy: mutating the result does not affect the fake', async () => {
    const fake = createFakeBookmarksApi(seed());
    const [root] = await fake.getTree();
    root!.children![1]!.children!.pop();
    root!.children![1]!.title = 'hacked';

    const [again] = await fake.getTree();
    expect(again?.children?.[1]?.title).toBe('Other bookmarks');
    expect(again?.children?.[1]?.children).toHaveLength(3);
  });

  it('recomputes index after a move and inherits syncing from the tree', async () => {
    const fake = createFakeBookmarksApi(seed());
    await fake.move('x', { parentId: 'F' });
    expect(fake.getNode('z')?.index).toBe(1);
    expect(fake.getNode('x')).toMatchObject({ parentId: 'F', index: 2, syncing: false });
    expect(fake.getNode('y')?.syncing).toBe(false);
  });
});

describe('fake create', () => {
  it('appends when index is omitted, inserts at index otherwise, and allows index === children.length', async () => {
    const fake = createFakeBookmarksApi(seed());
    const appended = await fake.create({ parentId: '2', title: 'new', url: 'https://new' });
    expect(appended.index).toBe(3);
    expect(fake.getChildrenIds('2')).toEqual(['x', 'F', 'z', appended.id]);

    const inserted = await fake.create({ parentId: '2', title: 'first', index: 0 });
    expect(inserted.children).toEqual([]);
    expect(fake.getChildrenIds('2')).toEqual([inserted.id, 'x', 'F', 'z', appended.id]);

    const atEnd = await fake.create({ parentId: '2', title: 'end', index: 5 });
    expect(fake.getChildrenIds('2').at(-1)).toBe(atEnd.id);
  });

  it('throws when index > children.length or negative', async () => {
    const fake = createFakeBookmarksApi(seed());
    await expect(fake.create({ parentId: '2', title: 'bad', index: 4 })).rejects.toThrow(/out of bounds/i);
    await expect(fake.create({ parentId: '2', title: 'bad', index: -1 })).rejects.toThrow(/out of bounds/i);
    expect(fake.getChildrenIds('2')).toEqual(['x', 'F', 'z']);
  });

  it('rejects missing parents, bookmark parents, the tree root and managed parents', async () => {
    const fake = createFakeBookmarksApi(seed());
    await expect(fake.create({ parentId: 'nope', title: 't' })).rejects.toThrow(/Can't find/);
    await expect(fake.create({ parentId: 'x', title: 't' })).rejects.toThrow(/not a folder/);
    await expect(fake.create({ parentId: '0', title: 't' })).rejects.toThrow(/root bookmark folders/);
    await expect(fake.create({ parentId: '9', title: 't' })).rejects.toThrow(/managed/);
  });

  it('allocates ids that never collide with seed ids', async () => {
    const fake = createFakeBookmarksApi([
      { id: '1', title: 'bar', folderType: 'bookmarks-bar', children: [{ id: '5', title: 'five', url: 'https://5' }] },
      { id: '2', title: 'other', folderType: 'other', children: [] },
    ]);
    const created = await fake.create({ parentId: '2', title: 'n' });
    expect(created.id).toBe('6');
  });
});

describe('fake move', () => {
  it('appends when index is omitted and inserts at index otherwise', async () => {
    const fake = createFakeBookmarksApi(seed());
    await fake.move('a', { parentId: '2' });
    expect(fake.getChildrenIds('2')).toEqual(['x', 'F', 'z', 'a']);
    expect(fake.getChildrenIds('1')).toEqual([]);

    await fake.move('a', { parentId: 'F', index: 0 });
    expect(fake.getChildrenIds('F')).toEqual(['a', 'y', 'G']);
  });

  it('throws when index > children.length of the destination', async () => {
    const fake = createFakeBookmarksApi(seed());
    await expect(fake.move('a', { parentId: 'F', index: 3 })).rejects.toThrow(/out of bounds/i);
    await expect(fake.move('a', { parentId: 'F', index: 2 })).resolves.toMatchObject({ parentId: 'F', index: 2 });
  });

  it('throws on a move within the same parent (Shelfmark never does this)', async () => {
    const fake = createFakeBookmarksApi(seed());
    await expect(fake.move('x', { parentId: '2' })).rejects.toThrow(/same-parent|current parent/);
    await expect(fake.move('x', { parentId: '2', index: 0 })).rejects.toThrow(/same-parent|current parent/);
    expect(fake.getChildrenIds('2')).toEqual(['x', 'F', 'z']);
  });

  it('refuses to move roots, managed nodes, into bookmarks, or a folder into its own subtree', async () => {
    const fake = createFakeBookmarksApi(seed());
    await expect(fake.move('1', { parentId: '2' })).rejects.toThrow(/root bookmark folders/);
    await expect(fake.move('0', { parentId: '2' })).rejects.toThrow(/root bookmark folders/);
    await expect(fake.move('m', { parentId: '2' })).rejects.toThrow(/managed/);
    await expect(fake.move('a', { parentId: '9' })).rejects.toThrow(/managed/);
    await expect(fake.move('a', { parentId: 'x' })).rejects.toThrow(/not a folder/);
    await expect(fake.move('a', { parentId: '0' })).rejects.toThrow(/root bookmark folders/);
    await expect(fake.move('F', { parentId: 'G' })).rejects.toThrow(/itself or its descendant/);
    await expect(fake.move('nope', { parentId: '2' })).rejects.toThrow(/Can't find/);
  });
});

describe('fake remove', () => {
  it('removes bookmarks and empty folders', async () => {
    const fake = createFakeBookmarksApi(seed());
    await fake.remove('G');
    await fake.remove('z');
    expect(fake.getChildrenIds('2')).toEqual(['x', 'F']);
    expect(fake.getChildrenIds('F')).toEqual(['y']);
    expect(fake.getNode('G')).toBeUndefined();
  });

  it('throws for non-empty folders, permanent roots, the tree root, managed nodes and unknown ids', async () => {
    const fake = createFakeBookmarksApi(seed());
    await expect(fake.remove('F')).rejects.toThrow(/non-empty/);
    await expect(fake.remove('2')).rejects.toThrow(/root bookmark folders/);
    await expect(fake.remove('0')).rejects.toThrow(/root bookmark folders/);
    await expect(fake.remove('m')).rejects.toThrow(/managed/);
    await expect(fake.remove('nope')).rejects.toThrow(/Can't find/);
    expect(fake.getNode('F')).toBeDefined();
  });
});

describe('fake dump / calls', () => {
  it('dumps ids, parentIds, titles, urls and ordered children only', () => {
    const fake = createFakeBookmarksApi(seed());
    expect(fake.dump()[1]).toEqual({
      id: '2',
      parentId: '0',
      title: 'Other bookmarks',
      children: [
        { id: 'x', parentId: '2', title: 'x', url: 'https://x' },
        {
          id: 'F',
          parentId: '2',
          title: 'F',
          children: [
            { id: 'y', parentId: 'F', title: 'y', url: 'https://y' },
            { id: 'G', parentId: 'F', title: 'G', children: [] },
          ],
        },
        { id: 'z', parentId: '2', title: 'z', url: 'https://z' },
      ],
    });
  });

  it('counts calls', async () => {
    const fake = createFakeBookmarksApi(seed());
    await fake.getTree();
    await fake.create({ parentId: '2', title: 'n' });
    await fake.move('a', { parentId: '2' });
    await fake.remove('a');
    await fake.move('nope', { parentId: '2' }).catch(() => {});
    expect(fake.calls).toEqual({ getTree: 1, create: 1, move: 2, remove: 1 });
  });

  it('rejects invalid seeds', () => {
    expect(() => createFakeBookmarksApi([{ id: '0', title: 'bad', children: [] }])).toThrow(/reserved/);
    expect(() => createFakeBookmarksApi([{ id: 'dup', title: 'a', children: [] }, { id: 'dup', title: 'b', children: [] }])).toThrow(/Duplicate/);
    expect(() => createFakeBookmarksApi([{ title: 'both', url: 'https://x', children: [] }])).toThrow(/both url and children/);
  });
});
