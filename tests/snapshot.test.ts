import { describe, expect, it } from 'vitest';
import type { BookmarksApi } from '../src/lib/bookmarks/api';
import { createFakeBookmarksApi, type SeedNode } from '../src/lib/bookmarks/fake';
import { ensureFolderPath, removeEmptyCreatedFolders } from '../src/lib/bookmarks/mutate';
import { ApplySnapshotError, applySnapshot, restoreSnapshot, type PlannedMove } from '../src/lib/bookmarks/snapshot';
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

  it('with nothing left to move, removes folders it just created and does NOT persist (the previous undoable snapshot survives)', async () => {
    const fake = createFakeBookmarksApi(seed());
    const original = fake.dump();
    const journal: Snapshot[] = [];

    const result = await applySnapshot(fake, [{ bookmarkId: 'ghost', toPath: ['New'] }], {
      persist: async (s) => {
        journal.push(s);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.nothingToDo).toBe(true);
    expect(result.skipped).toEqual([{ bookmarkId: 'ghost', reason: 'missing' }]);
    expect(result.snapshot).toMatchObject({ items: [], applied: [], createdFolderIds: [] });
    expect(journal).toEqual([]);
    expect(fake.dump()).toEqual(original);
  });

  it('all items skipped after folders were created (deleted meanwhile) → folders removed, nothing persisted', async () => {
    const fake = createFakeBookmarksApi(seed());
    const journal: Snapshot[] = [];
    // z 在校验后、move 前被用户删掉：在第二次 getTree（ensureFolder 那次）时动手
    let reads = 0;
    const racy: BookmarksApi = {
      getTree: async () => {
        reads += 1;
        if (reads === 2) await fake.remove('z');
        return fake.getTree();
      },
      create: (d) => fake.create(d),
      remove: (id) => fake.remove(id),
      move: (id, dest) => fake.move(id, dest),
    };
    const result = await applySnapshot(racy, [{ bookmarkId: 'z', toPath: ['New'], expectedParentId: '2' }], {
      persist: async (s) => {
        journal.push(s);
      },
    });
    expect(result).toMatchObject({ ok: true, nothingToDo: true, skipped: [{ bookmarkId: 'z', reason: 'missing' }] });
    expect(journal).toEqual([]);
    expect(fake.calls.move).toBe(0);
    expect(fake.calls.create).toBe(1);
    expect(fake.calls.remove).toBe(2); // 用户删 z + 收回 New
    expect(fake.getChildrenIds('2').map((id) => fake.getNode(id)!.title)).toEqual(['x', '工作', 'S']);
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

  it('[L7] initial persist failure also removes the folders just created, and the error is tagged stage=prepare', async () => {
    const fake = createFakeBookmarksApi(seed());
    const original = fake.dump();
    let thrown: unknown;
    try {
      await applySnapshot(fake, [{ bookmarkId: 'x', toPath: ['New', 'Deep'] }], {
        persist: async () => {
          throw new Error('storage full');
        },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ApplySnapshotError);
    expect((thrown as ApplySnapshotError).stage).toBe('prepare');
    expect((thrown as Error).message).toBe('storage full');
    expect(fake.calls.create).toBe(2);
    expect(fake.calls.remove).toBe(2);
    expect(fake.calls.move).toBe(0);
    expect(fake.dump()).toEqual(original);
  });

  it('[L6] a failing cleanup does not mask the original prepare error', async () => {
    const fake = createFakeBookmarksApi(seed());
    // 读树：#1 校验、#2 ensureFolder(New)、#3 是 removeEmptyCreatedFolders 的那次 → 让它炸
    let reads = 0;
    const broken: BookmarksApi = {
      getTree: async () => {
        reads += 1;
        if (reads === 3) throw new Error('tree exploded during cleanup');
        return fake.getTree();
      },
      create: (d) => fake.create(d),
      move: (id, dest) => fake.move(id, dest),
      remove: (id) => fake.remove(id),
    };
    await expect(
      applySnapshot(
        broken,
        [
          { bookmarkId: 'x', toPath: ['New'] },
          { bookmarkId: 'z', toPath: ['   '] },
        ],
        { persist: async () => {} },
      ),
    ).rejects.toThrow(/empty/);
    expect(reads).toBe(3);
    // New 建了、收不回（清理自己失败），但抛出去的还是原始错误
    expect(fake.getChildrenIds('2').map((id) => fake.getNode(id)!.title)).toContain('New');
  });
});

describe('[M1] failures after the first move never bypass rollback', () => {
  const moves = (): PlannedMove[] => [
    { bookmarkId: 'x', toPath: ['New'] },
    { bookmarkId: 'z', toPath: ['New'] },
    { bookmarkId: 'a', toParentId: 'BarF' },
  ];

  it('journal persist throwing on the k-th write → the k-th move counts as applied, everything rolls back, status rolled-back', async () => {
    const fake = createFakeBookmarksApi(seed());
    const original = fake.dump();
    const journal: Snapshot[] = [];
    let writes = 0;
    const result = await applySnapshot(fake, moves(), {
      persist: async (s) => {
        writes += 1;
        if (writes === 3) throw new Error('quota exceeded'); // applying(0), after#1, after#2 ← throws
        journal.push(s);
      },
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('quota exceeded');
    expect(result.stopped).toBeUndefined();
    // 第 2 条 move 已经成功：回滚必须把它算进去
    expect(result.rollback).toMatchObject({ total: 2, restored: 2, failed: 0 });
    expect(result.snapshot).toMatchObject({ status: 'rolled-back', applied: ['x', 'z'] });
    expect(journal.at(-1)?.status).toBe('rolled-back');
    expect(fake.dump()).toEqual(original);
  });

  it('restoreSnapshot itself throwing → ok:false with error + rollbackError, snapshot left applying so the banner can retry', async () => {
    const fake = createFakeBookmarksApi(seed());
    const original = fake.dump();
    const journal: Snapshot[] = [];
    let moveCalls = 0;
    let treeReads = 0;
    const flaky: BookmarksApi = {
      getTree: async () => {
        treeReads += 1;
        // #1 校验、#2 ensureFolder(New)、#3 第 4 步重读；#4 是 restoreSnapshot 开头那次读树
        if (treeReads === 4) throw new Error('bookmarks service unavailable');
        return fake.getTree();
      },
      create: (d) => fake.create(d),
      remove: (id) => fake.remove(id),
      move: async (id, dest) => {
        moveCalls += 1;
        if (moveCalls === 2) throw new Error("Can't find bookmark for id z.");
        return fake.move(id, dest);
      },
    };
    const result = await applySnapshot(flaky, moves(), {
      persist: async (s) => {
        journal.push(s);
      },
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("Can't find bookmark");
    expect(result.rollback).toBeUndefined();
    expect(String(result.rollbackError)).toContain('service unavailable');
    expect(result.snapshot).toMatchObject({ status: 'applying', applied: ['x'] });
    expect(journal.at(-1)).toMatchObject({ status: 'applying', applied: ['x'] });
    // x 还在新文件夹里；用持久化的 snapshot 走中断回滚路径就能恢复
    expect(fake.getNode('x')?.parentId).toBe(result.snapshot.createdFolderIds[0]);
    const restore = await restoreSnapshot(fake, journal.at(-1)!, 'rolled-back');
    expect(restore).toMatchObject({ total: 1, restored: 1 });
    expect(fake.dump()).toEqual(original);
  });

  it('final status persist throwing → treated as a failure after all moves: rolled back, tree equals original', async () => {
    const fake = createFakeBookmarksApi(seed());
    const original = fake.dump();
    let writes = 0;
    const result = await applySnapshot(fake, moves(), {
      persist: async (s) => {
        writes += 1;
        if (s.status === 'applied') throw new Error('final write failed');
      },
    });
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain('final write failed');
    expect(result.rollback).toMatchObject({ total: 3, restored: 3 });
    expect(result.snapshot.status).toBe('rolled-back');
    expect(writes).toBe(6); // applying + 3 + applied(throws) + rolled-back
    expect(fake.dump()).toEqual(original);
  });

  it('a throwing onProgress listener does not turn into a write failure', async () => {
    const fake = createFakeBookmarksApi(seed());
    const result = await applySnapshot(fake, moves(), {
      persist: async () => {},
      onProgress: () => {
        throw new Error('listener bug');
      },
    });
    expect(result.ok).toBe(true);
    expect(result.snapshot.applied).toEqual(['x', 'z', 'a']);
  });
});

describe('[M4] PathMove.baseParentId: children of a reused nested folder', () => {
  it('builds the sub-folder under baseParentId instead of creating a same-named folder at the root', async () => {
    const fake = createFakeBookmarksApi(seed());
    const result = await applySnapshot(fake, [{ bookmarkId: 'x', toPath: ['React'], baseParentId: 'F', expectedParentId: '2' }], { persist: async () => {} });
    expect(result.ok).toBe(true);
    const [react] = result.snapshot.createdFolderIds;
    expect(fake.getNode(react!)).toMatchObject({ parentId: 'F', title: 'React' });
    expect(fake.getNode('x')?.parentId).toBe(react);
    // 根下没有新建任何文件夹
    expect(fake.getChildrenIds('2').map((id) => fake.getNode(id)!.title)).toEqual(['工作', 'z', 'S']);
    // undo 回到原状
    await restoreSnapshot(fake, result.snapshot, 'undone');
    expect(fake.getNode(react!)).toBeUndefined();
    expect(fake.getChildrenIds('F')).toEqual(['y']);
  });

  it('reuses an existing child under baseParentId (normalize) and falls back to the root when baseParentId is in another root or missing', async () => {
    const fake = createFakeBookmarksApi(seed());
    await fake.create({ parentId: 'F', title: 'react' });
    const result = await applySnapshot(
      fake,
      [
        { bookmarkId: 'x', toPath: ['React'], baseParentId: 'F' }, // 复用 F/ react
        { bookmarkId: 'z', toPath: ['Tools'], baseParentId: 'BarF' }, // BarF 在书签栏根 → 退回 other 根
        { bookmarkId: 'a', toPath: ['Tools'], baseParentId: 'nope' }, // 不存在 → 退回 bar 根
      ],
      { persist: async () => {} },
    );
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual([]);
    const existingReact = fake.getChildrenIds('F').find((id) => fake.getNode(id)?.title === 'react')!;
    expect(fake.getNode('x')?.parentId).toBe(existingReact);
    expect(fake.getNode(fake.getNode('z')!.parentId!)).toMatchObject({ parentId: '2', title: 'Tools' });
    expect(fake.getNode(fake.getNode('a')!.parentId!)).toMatchObject({ parentId: '1', title: 'Tools' });
    expect(result.snapshot.createdFolderIds).toHaveLength(2);
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
