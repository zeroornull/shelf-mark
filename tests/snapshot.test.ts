import { describe, expect, it } from 'vitest';
import type { BookmarksApi } from '../src/lib/bookmarks/api';
import { createFakeBookmarksApi, type SeedNode } from '../src/lib/bookmarks/fake';
import { ensureFolderPath, removeEmptyCreatedFolders } from '../src/lib/bookmarks/mutate';
import { applySnapshot, restoreSnapshot } from '../src/lib/bookmarks/snapshot';
import type { Snapshot } from '../src/lib/types';

const seed = (): SeedNode[] => [
  {
    id: '1',
    title: 'Bookmarks bar',
    folderType: 'bookmarks-bar',
    syncing: false,
    children: [{ id: 'a', title: 'a', url: 'https://a' }, { id: 'BarF', title: '工作', children: [] }],
  },
  {
    id: '2',
    title: 'Other bookmarks',
    folderType: 'other',
    syncing: false,
    children: [
      { id: 'x', title: 'x', url: 'https://x' },
      { id: 'F', title: '工作', children: [{ id: 'y', title: 'y', url: 'https://y' }] },
      { id: 'z', title: 'z', url: 'https://z' },
      { id: 'S', title: 'S', children: [{ id: 's1', title: 's1', url: 'https://s1' }] },
    ],
  },
  { id: '9', title: 'Managed', folderType: 'managed', unmodifiable: 'managed', children: [{ id: 'm', title: 'm', url: 'https://m', unmodifiable: 'managed' }] },
];

const noPersist = async () => {};

describe('applySnapshot validation (§5.3 step 1)', () => {
  it('skips duplicates, missing ids, folders, managed, changed parents, bad targets, cross-root and same-parent moves', async () => {
    const fake = createFakeBookmarksApi(seed());
    const original = fake.dump();

    const result = await applySnapshot(
      fake,
      [
        { bookmarkId: 'x', toParentId: 'F' },
        { bookmarkId: 'x', toParentId: 'S' }, // duplicate
        { bookmarkId: 'ghost', toParentId: 'F' }, // missing
        { bookmarkId: 'S', toParentId: 'F' }, // folder, not a bookmark
        { bookmarkId: 'm', toParentId: 'F' }, // managed
        { bookmarkId: 'z', toParentId: 'F', expectedParentId: 'S' }, // parent changed since planning
        { bookmarkId: 'y', toParentId: 'ghost-folder' }, // target missing
        { bookmarkId: 'y', toParentId: 'x' }, // duplicate of y (first y wins even though it was skipped)
        { bookmarkId: 's1', toParentId: 'BarF' }, // cross-root
        { bookmarkId: 'a', toParentId: '1' }, // same parent
      ],
      { persist: noPersist },
    );

    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual([
      { bookmarkId: 'x', reason: 'duplicate' },
      { bookmarkId: 'ghost', reason: 'missing' },
      { bookmarkId: 'S', reason: 'not-a-bookmark' },
      { bookmarkId: 'm', reason: 'managed' },
      { bookmarkId: 'z', reason: 'parent-changed' },
      { bookmarkId: 'y', reason: 'target-missing' },
      { bookmarkId: 'y', reason: 'duplicate' },
      { bookmarkId: 's1', reason: 'cross-root' },
      { bookmarkId: 'a', reason: 'same-parent' },
    ]);
    expect(result.snapshot.items.map((i) => i.bookmarkId)).toEqual(['x']);
    expect(fake.getChildrenIds('F')).toEqual(['y', 'x']);

    await restoreSnapshot(fake, result.snapshot, 'undone');
    expect(fake.dump()).toEqual(original);
  });

  it('drops a path move whose resolved folder is the current parent', async () => {
    const fake = createFakeBookmarksApi(seed());
    const result = await applySnapshot(fake, [{ bookmarkId: 'y', toPath: [' 工作 '] }], { persist: noPersist });
    expect(result.skipped).toEqual([{ bookmarkId: 'y', reason: 'same-parent' }]);
    expect(result.snapshot.items).toEqual([]);
    expect(result.snapshot.createdFolderIds).toEqual([]);
  });

  it('resolves paths per root: same title reuses each root\'s own folder, never crossing roots', async () => {
    const fake = createFakeBookmarksApi(seed());
    const result = await applySnapshot(
      fake,
      [
        { bookmarkId: 'a', toPath: ['工作'] },
        { bookmarkId: 'x', toPath: ['工作'] },
        { bookmarkId: 'z', toPath: ['生活'] },
      ],
      { persist: noPersist },
    );
    expect(result.ok).toBe(true);
    expect(result.snapshot.items.map((i) => [i.bookmarkId, i.toParentId])).toEqual([
      ['a', 'BarF'],
      ['x', 'F'],
      ['z', result.snapshot.createdFolderIds[0]],
    ]);
    expect(result.snapshot.createdFolderIds).toHaveLength(1);
    const created = result.snapshot.createdFolderIds[0]!;
    expect(fake.getNode(created)).toMatchObject({ parentId: '2', title: '生活' });
    // 新文件夹追加在根末尾（x、z 已移走，剩 [F, S, 生活]）
    expect(fake.getChildrenIds('2')).toEqual(['F', 'S', created]);
    expect(fake.getChildrenIds('BarF')).toEqual(['a']);
    expect(fake.getChildrenIds('F')).toEqual(['y', 'x']);
  });

  it('with nothing left to move, removes folders it just created and persists an empty applied snapshot', async () => {
    const fake = createFakeBookmarksApi(seed());
    const original = fake.dump();
    const journal: Snapshot[] = [];

    const result = await applySnapshot(fake, [{ bookmarkId: 'ghost', toPath: ['New'] }], {
      persist: async (s) => {
        journal.push(s);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.snapshot).toMatchObject({ status: 'applied', items: [], applied: [], createdFolderIds: [] });
    expect(journal).toHaveLength(1);
    expect(fake.dump()).toEqual(original);
  });

  it('cleans up created folders and rethrows if folder creation fails before anything is persisted', async () => {
    const fake = createFakeBookmarksApi(seed());
    const original = fake.dump();
    const journal: Snapshot[] = [];

    await expect(
      applySnapshot(
        fake,
        [
          { bookmarkId: 'x', toPath: ['New'] },
          { bookmarkId: 'z', toPath: ['   '] }, // ensureFolder rejects empty titles
        ],
        {
          persist: async (s) => {
            journal.push(s);
          },
        },
      ),
    ).rejects.toThrow(/empty/);

    expect(journal).toEqual([]);
    expect(fake.dump()).toEqual(original);
  });
});

describe('applySnapshot journal (§5.3 steps 4–8)', () => {
  it('persists applying before the first move, appends applied after each move, then applied', async () => {
    const fake = createFakeBookmarksApi(seed());
    const journal: Snapshot[] = [];
    const journalLengthAtMove: number[] = [];
    const spy: BookmarksApi = {
      getTree: () => fake.getTree(),
      create: (d) => fake.create(d),
      remove: (id) => fake.remove(id),
      move: (id, dest) => {
        journalLengthAtMove.push(journal.length);
        expect(dest.index, 'apply must not pass an index').toBeUndefined();
        return fake.move(id, dest);
      },
    };

    const result = await applySnapshot(
      spy,
      [
        { bookmarkId: 'x', toPath: ['New'] },
        { bookmarkId: 'z', toPath: ['New'] },
        { bookmarkId: 'a', toParentId: 'BarF' },
      ],
      {
        persist: async (s) => {
          journal.push(s);
        },
        id: 'snap-test',
        now: () => 42,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.snapshot).toMatchObject({ id: 'snap-test', createdAt: 42, status: 'applied' });
    expect(journalLengthAtMove).toEqual([1, 2, 3]);
    expect(journal.map((s) => [s.status, s.applied.length])).toEqual([
      ['applying', 0],
      ['applying', 1],
      ['applying', 2],
      ['applying', 3],
      ['applied', 3],
    ]);
    // journal 里的是深拷贝：后续变化不会回写到旧条目
    expect(journal[0]?.applied).toEqual([]);
    // fromIndex 是移动前的真实位置，且在建完文件夹之后读取
    expect(result.snapshot.items).toEqual([
      { bookmarkId: 'x', toParentId: result.snapshot.createdFolderIds[0], fromParentId: '2', fromIndex: 0, title: 'x', url: 'https://x' },
      { bookmarkId: 'z', toParentId: result.snapshot.createdFolderIds[0], fromParentId: '2', fromIndex: 2, title: 'z', url: 'https://z' },
      { bookmarkId: 'a', toParentId: 'BarF', fromParentId: '1', fromIndex: 0, title: 'a', url: 'https://a' },
    ]);
  });

  it('does not touch the tree when persisting the initial snapshot fails', async () => {
    const fake = createFakeBookmarksApi(seed());
    const original = fake.dump();
    await expect(
      applySnapshot(fake, [{ bookmarkId: 'x', toParentId: 'F' }], {
        persist: async () => {
          throw new Error('storage full');
        },
      }),
    ).rejects.toThrow('storage full');
    expect(fake.calls.move).toBe(0);
    expect(fake.dump()).toEqual(original);
  });
});

describe('restoreSnapshot edge cases (§5.3 restore step 3)', () => {
  async function applied(fake = createFakeBookmarksApi(seed())) {
    const result = await applySnapshot(
      fake,
      [
        { bookmarkId: 'x', toPath: ['New'] },
        { bookmarkId: 's1', toPath: ['New'] },
        { bookmarkId: 'a', toParentId: 'BarF' },
      ],
      { persist: noPersist },
    );
    expect(result.ok).toBe(true);
    return { fake, snapshot: result.snapshot, newFolder: result.snapshot.createdFolderIds[0]! };
  }

  it('skips bookmarks the user deleted and still restores the rest', async () => {
    const { fake, snapshot, newFolder } = await applied();
    await fake.remove('x');

    const result = await restoreSnapshot(fake, snapshot, 'undone');
    expect(result).toMatchObject({ total: 3, restored: 2, skipped: 1, relocated: 0, failed: 0, removedFolders: [newFolder], keptFolders: [] });
    expect(fake.getChildrenIds('2')).toEqual(['F', 'z', 'S']);
    expect(fake.getChildrenIds('S')).toEqual(['s1']);
    expect(fake.getChildrenIds('1')).toEqual(['a', 'BarF']);
  });

  it('moves a bookmark to the end of its root when the source folder is gone', async () => {
    const { fake, snapshot, newFolder } = await applied();
    await fake.remove('S'); // S is empty now (s1 moved out), so the user can delete it

    const result = await restoreSnapshot(fake, snapshot, 'undone');
    expect(result).toMatchObject({ total: 3, restored: 2, skipped: 0, relocated: 1, failed: 0 });
    expect(fake.getChildrenIds('2')).toEqual(['x', 'F', 'z', 's1']);
    expect(fake.getNode(newFolder)).toBeUndefined();
  });

  it('treats a bookmark the user already moved back as restored without issuing a same-parent move', async () => {
    const { fake, snapshot } = await applied();
    await fake.move('x', { parentId: '2', index: 0 });
    const movesBefore = fake.calls.move;

    const result = await restoreSnapshot(fake, snapshot, 'undone');
    expect(result).toMatchObject({ total: 3, restored: 3, failed: 0 });
    expect(fake.calls.move - movesBefore).toBe(2);
    expect(fake.getChildrenIds('2')).toEqual(['x', 'F', 'z', 'S']);
  });

  it('only restores the applied subset and keeps a created folder that still holds an unapplied bookmark', async () => {
    const { fake, snapshot, newFolder } = await applied();
    const partial: Snapshot = { ...snapshot, applied: ['x', 'a'], status: 'applying' };

    const result = await restoreSnapshot(fake, partial, 'rolled-back');
    expect(result).toMatchObject({ total: 2, restored: 2, keptFolders: [newFolder], removedFolders: [] });
    expect(result.snapshot.status).toBe('rolled-back');
    expect(fake.getChildrenIds(newFolder)).toEqual(['s1']);
    expect(fake.getChildrenIds('2')).toEqual(['x', 'F', 'z', 'S', newFolder]);
  });

  it('does not mutate the snapshot passed in and persists the final status once', async () => {
    const { fake, snapshot } = await applied();
    const before = structuredClone(snapshot);
    const journal: Snapshot[] = [];

    const result = await restoreSnapshot(fake, snapshot, 'undone', async (s) => {
      journal.push(s);
    });
    expect(snapshot).toEqual(before);
    expect(result.snapshot.status).toBe('undone');
    expect(journal.map((s) => s.status)).toEqual(['undone']);
  });

  it('counts a failing move as failed and carries on', async () => {
    const { fake, snapshot } = await applied();
    const flaky: BookmarksApi = {
      getTree: () => fake.getTree(),
      create: (d) => fake.create(d),
      remove: (id) => fake.remove(id),
      move: (id, dest) => (id === 's1' ? Promise.reject(new Error('boom')) : fake.move(id, dest)),
    };

    const result = await restoreSnapshot(flaky, snapshot, 'undone');
    expect(result).toMatchObject({ total: 3, restored: 2, failed: 1, keptFolders: snapshot.createdFolderIds });
    expect(fake.getNode('s1')?.parentId).toBe(snapshot.createdFolderIds[0]);
  });
});

describe('mutate helpers', () => {
  it('ensureFolderPath creates missing segments (parent first) and reuses existing ones', async () => {
    const fake = createFakeBookmarksApi(seed());
    const result = await ensureFolderPath(fake, '2', ['工作', '前端', 'Vue']);
    expect(result.createdIds).toHaveLength(2);
    expect(fake.getNode(result.createdIds[0]!)).toMatchObject({ parentId: 'F', title: '前端' });
    expect(fake.getNode(result.createdIds[1]!)).toMatchObject({ parentId: result.createdIds[0], title: 'Vue' });
    expect(result.id).toBe(result.createdIds[1]);

    const again = await ensureFolderPath(fake, '2', [' 工作', '前端 ', 'vue']);
    expect(again).toEqual({ id: result.id, createdIds: [] });
    expect(await ensureFolderPath(fake, '2', [])).toEqual({ id: '2', createdIds: [] });
  });

  it('removeEmptyCreatedFolders removes children before parents, keeps non-empty ones and reports missing ids', async () => {
    const fake = createFakeBookmarksApi(seed());
    const a = await fake.create({ parentId: '2', title: 'A' });
    const b = await fake.create({ parentId: a.id, title: 'B' });
    const c = await fake.create({ parentId: '2', title: 'C' });
    await fake.create({ parentId: c.id, title: 'keep me', url: 'https://keep' });
    await fake.remove(b.id);
    const b2 = await fake.create({ parentId: a.id, title: 'B2' });

    const result = await removeEmptyCreatedFolders(fake, [a.id, b.id, c.id, b2.id]);
    expect(result).toEqual({ removed: [b2.id, a.id], kept: [c.id], missing: [b.id] });
    expect(fake.getNode(a.id)).toBeUndefined();
    expect(fake.getChildrenIds(c.id)).toHaveLength(1);
    expect(await removeEmptyCreatedFolders(fake, [])).toEqual({ removed: [], kept: [], missing: [] });
  });
});
