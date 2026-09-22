import { describe, expect, it } from 'vitest';
import type { BookmarksApi } from '../src/lib/bookmarks/api';
import { createFakeBookmarksApi, type DumpNode, type FakeBookmarksApi } from '../src/lib/bookmarks/fake';
import { Organizer } from '../src/lib/jobs/organizer';
import { describeRestoreSummary, reconcileInterruptedJournal, rollbackInterruptedSnapshot, undoSnapshot } from '../src/lib/jobs/recovery';
import type { OrganizeJob, Snapshot } from '../src/lib/types';
import { harness, scriptedChat, settings, tick, type Harness } from './helpers/organizer-harness';

/**
 * M5：review → applying → done、备份顺序、journal、失败回滚、取消回滚、撤销、中断回滚。
 * 树来自 harness：「其他书签」下 36 条散装（10 github → 复用已有「工作」，10 淘宝 → 新建「购物」，10 HN → 新建「资讯」，
 * 4 杂项 + 2 重复默认不动）→ 默认 30 条 planned moves。
 */

type MoveHook = (id: string, dest: { parentId: string; index?: number }, n: number) => Promise<void> | void;

/** 包一层 fake：每次 move 先跑 hook（可抛错 / 可等待），再转发。 */
function wrapMoves(hook: MoveHook): (api: FakeBookmarksApi) => BookmarksApi {
  return (api) => {
    let n = 0;
    return {
      getTree: () => api.getTree(),
      create: (details) => api.create(details),
      remove: (id) => api.remove(id),
      move: async (id, dest) => {
        n += 1;
        await hook(id, dest, n);
        return api.move(id, dest);
      },
    };
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function prune(nodes: DumpNode[], ids: ReadonlySet<string>): DumpNode[] {
  return nodes.filter((node) => !ids.has(node.id)).map((node) => (node.children ? { ...node, children: prune(node.children, ids) } : node));
}

async function reviewed(h: Harness): Promise<DumpNode[]> {
  await h.organizer.start();
  expect(h.organizer.state.job.phase).toBe('review');
  expect(h.organizer.plannedMoves()).toHaveLength(30);
  return h.api.dump();
}

function folderIdByTitle(api: FakeBookmarksApi, parentId: string, title: string): string {
  const id = api.getChildrenIds(parentId).find((childId) => {
    const node = api.getNode(childId);
    return node?.url === undefined && node?.title === title;
  });
  expect(id, `folder ${title} under ${parentId}`).toBeDefined();
  return id!;
}

const GH = Array.from({ length: 10 }, (_, i) => `bm-gh-${i}`);

describe('Organizer.apply – happy path', () => {
  it('review → applying → done: backup before the first move, snapshot persisted as applying before the first move and applied after', async () => {
    const seen: { atFirstMove: { snapshots: Array<Snapshot | null>; backups: number; jobPhase: string } | null } = { atFirstMove: null };
    const h = harness(4, {
      wrapApi: wrapMoves((_id, _dest, n) => {
        if (n === 1) seen.atFirstMove = { snapshots: structuredClone(h.snapshots), backups: h.backups.length, jobPhase: h.organizer.state.job.phase };
      }),
    });
    await reviewed(h);

    await h.organizer.apply();
    await h.organizer.flush();

    expect(h.phases.slice(-3)).toEqual(['review', 'applying', 'done']);

    // 第 0 步备份：在任何 move 之前调用一次，拿到的是完整树
    expect(h.backups).toHaveLength(1);
    expect(h.backups[0]!.movesSoFar).toBe(0);
    expect(h.backups[0]!.tree[0]!.children!.map((c) => c.id)).toEqual(['1', '2']);

    // 第一条 move 时：备份已做、snapshot 已以 applying 落盘且 applied 为空、job 已是 applying
    const atFirstMove = seen.atFirstMove!;
    expect(atFirstMove).not.toBeNull();
    expect(atFirstMove.backups).toBe(1);
    expect(atFirstMove.jobPhase).toBe('applying');
    expect(atFirstMove.snapshots).toHaveLength(1);
    expect(atFirstMove.snapshots[0]).toMatchObject({ status: 'applying', applied: [] });

    // journal：applying(0) + 30 条 + applied
    expect(h.snapshots).toHaveLength(32);
    const snapshot = h.currentSnapshot()!;
    expect(snapshot.status).toBe('applied');
    expect(snapshot.applied).toHaveLength(30);
    expect(snapshot.items).toHaveLength(30);
    expect(snapshot.createdFolderIds).toHaveLength(2);

    const { job } = h.organizer.state;
    expect(job).toMatchObject({ phase: 'done', snapshotId: snapshot.id, done: 30, total: 30, backupFileName: 'backup-1.html', skipped: [] });
    expect(job.restore).toBeUndefined();
    expect(job.moveReport).toHaveLength(30);
    expect(job.moveReport?.some((row) => row.toPath.includes('购物'))).toBe(true);
    expect(job.moveReport?.every((row) => row.fromPath.length > 0 && row.toPath.length > 0)).toBe(true);

    // 进度：applying 阶段 done 从 0 走到 30 并持久化；最后一条持久化是 done
    const progress = h.persisted.filter((j) => j?.phase === 'applying').map((j) => j!.done);
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(30);
    expect(h.persisted[h.persisted.length - 1]).toMatchObject({ phase: 'done', snapshotId: snapshot.id });

    // 树：github 进已有「工作」（追加末尾），淘宝 / HN 进新建文件夹，杂项与重复留在根下
    expect(h.api.getChildrenIds('other-work')).toEqual(['bm-in-work', ...GH]);
    const otherChildren = h.api.getChildrenIds('2').map((id) => h.api.getNode(id)!);
    expect(otherChildren.filter((n) => n.url === undefined).map((n) => n.title)).toEqual(['工作', '购物', '资讯']);
    expect(otherChildren.filter((n) => n.url !== undefined).map((n) => n.id)).toEqual(['bm-misc-0', 'bm-misc-1', 'bm-misc-2', 'bm-misc-3', 'bm-dup-1', 'bm-dup-2']);
    expect(h.api.getChildrenIds(folderIdByTitle(h.api, '2', '购物'))).toHaveLength(10);
    // 书签栏没被碰
    expect(h.api.getChildrenIds('1')).toEqual(['bm-bar-1', 'bar-work']);
  });

  it('bookmarks deleted or moved between review and apply land in job.skipped with reasons; the rest is applied', async () => {
    const h = harness(4);
    await reviewed(h);
    await h.api.remove('bm-tb-3');
    await h.api.move('bm-news-3', { parentId: 'other-work' });

    await h.organizer.apply();
    const { job } = h.organizer.state;
    expect(job.phase).toBe('done');
    expect(job.skipped).toEqual([
      { bookmarkId: 'bm-tb-3', reason: 'missing' },
      { bookmarkId: 'bm-news-3', reason: 'parent-changed' },
    ]);
    expect(job.done).toBe(28);
    expect(job.total).toBe(28);
    expect(h.currentSnapshot()!.applied).toHaveLength(28);
    // 被用户挪走的那条保持现状
    expect(h.api.getNode('bm-news-3')?.parentId).toBe('other-work');
  });

  it('autoBackup: false → backup dep is never called and job.backupFileName stays empty', async () => {
    const h = harness(4, { settings: settings({ autoBackup: false }) });
    await reviewed(h);
    await h.organizer.apply();
    expect(h.backups).toHaveLength(0);
    expect(h.organizer.state.job.phase).toBe('done');
    expect(h.organizer.state.job.backupFileName).toBeUndefined();
  });

  it('a failing backup aborts before touching bookmarks and returns to review with an error note', async () => {
    const h = harness(4, {
      backup: async () => {
        throw new Error("Can't find bookmark for id 42.");
      },
    });
    const original = await reviewed(h);
    await h.organizer.apply();
    const { job } = h.organizer.state;
    expect(job.phase).toBe('review');
    expect(job.error).toContain('备份失败，未改动任何书签');
    expect(job.error).toContain('书签或文件夹不存在');
    expect(h.api.dump()).toEqual(original);
    expect(h.api.calls).toMatchObject({ create: 0, move: 0, remove: 0 });
    expect(h.snapshots).toEqual([]);

    h.organizer.clearError();
    expect(h.organizer.state.job.error).toBeUndefined();
    expect(h.organizer.state.job.phase).toBe('review');
  });

  it('refuses outside review or without planned moves, without changing state', async () => {
    const h = harness(4);
    await expect(h.organizer.apply()).rejects.toThrow(/预览/);
    expect(h.organizer.state.job.phase).toBe('idle');

    await reviewed(h);
    for (const move of h.organizer.plannedMoves()) h.organizer.excludeBookmark(move.bookmarkId);
    expect(h.organizer.plannedMoves()).toEqual([]);
    await expect(h.organizer.apply()).rejects.toThrow(/没有需要移动/);
    expect(h.organizer.state.job.phase).toBe('review');
    expect(h.api.calls).toMatchObject({ create: 0, move: 0, remove: 0 });
  });
});

describe('Organizer.apply – failure and cancel roll back', () => {
  it('k-th move throws → error, tree equals the original, snapshot rolled-back, restore summary recorded; backToReview lets the user re-apply', async () => {
    const h = harness(4, {
      wrapApi: wrapMoves((_id, _dest, n) => {
        if (n === 5) throw new Error("Can't find bookmark for id bm-gh-4. (injected)");
      }),
    });
    const original = await reviewed(h);

    await h.organizer.apply();
    await h.organizer.flush();

    const { job } = h.organizer.state;
    expect(h.phases.slice(-3)).toEqual(['review', 'applying', 'error']);
    expect(job.phase).toBe('error');
    expect(job.error).toContain('写入失败，已回滚 4/4');
    expect(job.error).toContain('书签或文件夹不存在');
    expect(job.error).toContain('injected');
    expect(job.restore).toEqual({ reason: 'failure', total: 4, restored: 4, skipped: 0, relocated: 0, failed: 0, removedFolders: 2, keptFolders: 0 });
    expect(job.done).toBe(4);
    expect(job.total).toBe(30);
    expect(job.snapshotId).toBe(h.currentSnapshot()!.id);
    expect(h.currentSnapshot()).toMatchObject({ status: 'rolled-back', applied: GH.slice(0, 4) });
    expect(h.api.dump()).toEqual(original);
    expect(h.persisted[h.persisted.length - 1]).toMatchObject({ phase: 'error', restore: { reason: 'failure' } });

    // proposal 仍在：回到预览后可以再次应用（第 5 次调用已经过去，之后不再注入失败）
    await h.organizer.backToReview();
    expect(h.organizer.state.job).toMatchObject({ phase: 'review', error: undefined, restore: undefined, snapshotId: undefined, skipped: [] });
    expect(h.organizer.plannedMoves()).toHaveLength(30);
    await h.organizer.apply();
    expect(h.organizer.state.job.phase).toBe('done');
    expect(h.api.getChildrenIds('other-work')).toEqual(['bm-in-work', ...GH]);
  });

  it('cancel() during applying stops before the next move (never mid-move), rolls back the applied subset, and returns after the rollback', async () => {
    const gate = deferred();
    let movesThroughApi = 0;
    const h = harness(4, {
      wrapApi: wrapMoves(async (_id, _dest, n) => {
        movesThroughApi = n;
        if (n === 1) await gate.promise;
      }),
    });
    const original = await reviewed(h);

    const applying = h.organizer.apply();
    while (movesThroughApi < 1) await tick();
    expect(h.organizer.state.job.phase).toBe('applying');

    const cancelling = h.organizer.cancel();
    await tick();
    // 第一条 move 还挂着：取消不打断它，也没有开始回滚
    expect(h.organizer.state.job.phase).toBe('applying');
    expect(movesThroughApi).toBe(1);

    gate.resolve();
    await applying;
    await cancelling;
    await h.organizer.flush();

    const { job } = h.organizer.state;
    expect(job.phase).toBe('error');
    expect(job.error).toBe('已取消，已回滚 1/1');
    expect(job.restore).toMatchObject({ reason: 'cancel', total: 1, restored: 1, failed: 0, removedFolders: 2, keptFolders: 0 });
    expect(job.done).toBe(1);
    expect(job.total).toBe(30);
    // 1 条 apply + 1 条回滚，没有第二条 apply move
    expect(movesThroughApi).toBe(2);
    expect(h.currentSnapshot()).toMatchObject({ status: 'rolled-back', applied: ['bm-gh-0'] });
    expect(h.api.dump()).toEqual(original);
    expect(h.persisted[h.persisted.length - 1]?.phase).toBe('error');
    expect(describeRestoreSummary(job.restore!)).toBe('已取消并回滚 1/1');
  });

  it('cancel() before the first move (during backup) returns to review without touching bookmarks', async () => {
    const gate = deferred();
    const h = harness(4, {
      backup: async () => {
        await gate.promise;
        return 'late.html';
      },
    });
    const original = await reviewed(h);
    const applying = h.organizer.apply();
    while (h.organizer.state.job.phase !== 'applying') await tick();
    const cancelling = h.organizer.cancel();
    gate.resolve();
    await applying;
    await cancelling;
    expect(h.organizer.state.job.phase).toBe('review');
    expect(h.api.dump()).toEqual(original);
    expect(h.snapshots).toEqual([]);
  });

  it('[M1] journal persist failing mid-apply → rolled back, error copy says 已回滚 (not 未移动任何书签)', async () => {
    const h = harness(4);
    const original = await reviewed(h);
    const realPersist = h.snapshots;
    let writes = 0;
    // 换掉 harness 的 persistSnapshot：第 4 次写（第 3 条 move 之后）抛错
    const organizer = new Organizer({
      bookmarksApi: h.api,
      chat: scriptedChat(),
      persistJob: async () => {},
      persistSnapshot: async (s) => {
        writes += 1;
        if (writes === 4) throw new Error('QUOTA_BYTES exceeded');
        realPersist.push(s ? structuredClone(s) : null);
      },
      settings: settings(),
    });
    const saved = structuredClone(h.organizer.state.job);
    expect(await organizer.restore(saved)).toBe(true);

    await organizer.apply();
    const { job } = organizer.state;
    expect(job.phase).toBe('error');
    expect(job.error).toContain('写入失败，已回滚 3/3');
    expect(job.error).toContain('QUOTA_BYTES');
    expect(job.error).not.toContain('未移动任何书签');
    expect(job.restore).toMatchObject({ reason: 'failure', total: 3, restored: 3 });
    expect(h.api.dump()).toEqual(original);
    expect(h.currentSnapshot()).toMatchObject({ status: 'rolled-back', applied: GH.slice(0, 3) });
  });

  it('[M1] rollback itself failing → error mentions 回滚也失败, snapshot stays applying, no job.restore; the banner path can still recover', async () => {
    let treeReads = 0;
    let moves = 0;
    let failAtRead = -1;
    const h = harness(4, {
      wrapApi: (api) => ({
        getTree: async () => {
          treeReads += 1;
          // 失败 move 之后 restoreSnapshot 的第一次读树
          if (moves === 3 && treeReads === failAtRead) throw new Error('bookmarks service unavailable');
          return api.getTree();
        },
        create: (d) => api.create(d),
        remove: (id) => api.remove(id),
        move: async (id, dest) => {
          moves += 1;
          if (moves === 3) {
            failAtRead = treeReads + 1;
            throw new Error("Can't find bookmark for id bm-gh-2.");
          }
          return api.move(id, dest);
        },
      }),
    });
    const original = await reviewed(h);

    await h.organizer.apply();
    const { job } = h.organizer.state;
    expect(job.phase).toBe('error');
    expect(job.error).toContain('写入失败');
    expect(job.error).toContain('回滚也失败');
    expect(job.error).toContain('service unavailable');
    expect(job.error).toContain('2/30');
    expect(job.restore).toBeUndefined();
    expect(job.snapshotId).toBe(h.currentSnapshot()!.id);
    expect(h.currentSnapshot()).toMatchObject({ status: 'applying', applied: GH.slice(0, 2) });
    expect(h.api.getNode('bm-gh-0')?.parentId).toBe('other-work'); // 仍在新位置

    // 中断横幅走的路径：对 applying 的 snapshot 回滚
    const summary = await h.organizer.rollbackInterrupted(h.currentSnapshot()!);
    expect(summary).toMatchObject({ reason: 'interrupted', total: 2, restored: 2 });
    expect(h.api.dump()).toEqual(original);
    expect(h.currentSnapshot()?.status).toBe('rolled-back');
  });

  it('[Nit] a listener that synchronously calls cancel() on the applying transition takes the stop branch and does not wipe the job', async () => {
    const h = harness(4);
    const original = await reviewed(h);
    let cancelled: Promise<void> | null = null;
    h.organizer.subscribe(({ job }) => {
      if (job.phase === 'applying' && cancelled === null) cancelled = h.organizer.cancel();
    });
    await h.organizer.apply();
    await cancelled;
    const { job } = h.organizer.state;
    expect(job.phase).toBe('review'); // 备份期间就被取消：没碰书签，回到预览
    expect(job.proposal).toBeDefined();
    expect(h.api.calls.move).toBe(0);
    expect(h.api.dump()).toEqual(original);
    expect(h.persisted[h.persisted.length - 1]).not.toBeNull();
  });

  it('reset() during applying cancels + rolls back, then clears the job', async () => {
    const gate = deferred();
    let moves = 0;
    const h = harness(4, {
      wrapApi: wrapMoves(async (_id, _dest, n) => {
        moves = n;
        if (n === 2) await gate.promise;
      }),
    });
    const original = await reviewed(h);
    const applying = h.organizer.apply();
    while (moves < 2) await tick();
    const resetting = h.organizer.reset();
    gate.resolve();
    await applying;
    await resetting;
    expect(h.organizer.state.job.phase).toBe('idle');
    expect(h.persisted[h.persisted.length - 1]).toBeNull();
    expect(h.api.dump()).toEqual(original);
    expect(h.currentSnapshot()?.status).toBe('rolled-back');
  });
});

describe('Organizer.undo', () => {
  it('after done: tree equals the original, snapshot undone, empty created folders removed, job keeps phase done with the summary; a second undo is refused', async () => {
    const h = harness(4);
    const original = await reviewed(h);
    await h.organizer.apply();
    expect(h.organizer.state.job.phase).toBe('done');

    const summary = await h.organizer.undo();
    await h.organizer.flush();
    expect(summary).toEqual({ reason: 'undo', total: 30, restored: 30, skipped: 0, relocated: 0, failed: 0, removedFolders: 2, keptFolders: 0 });
    expect(describeRestoreSummary(summary)).toBe('已撤销 30/30');
    expect(h.api.dump()).toEqual(original);
    expect(h.currentSnapshot()).toMatchObject({ status: 'undone', applied: expect.arrayContaining(GH) });
    expect(h.organizer.state.job.phase).toBe('done');
    expect(h.organizer.state.job.restore).toEqual(summary);
    expect(h.persisted[h.persisted.length - 1]).toMatchObject({ phase: 'done', restore: summary });

    await expect(h.organizer.undo()).rejects.toThrow(/没有可撤销的整理.*已撤销/);
  });

  it('keeps a new folder the user has since added a bookmark to (and its content), removes the other', async () => {
    const h = harness(4);
    const original = await reviewed(h);
    await h.organizer.apply();
    const shopping = folderIdByTitle(h.api, '2', '购物');
    const news = folderIdByTitle(h.api, '2', '资讯');
    const mine = await h.api.create({ parentId: shopping, title: 'mine', url: 'https://mine.example/' });

    const summary = await h.organizer.undo();
    expect(summary).toMatchObject({ restored: 30, removedFolders: 1, keptFolders: 1 });
    expect(describeRestoreSummary(summary)).toBe('已撤销 30/30；1 个新建文件夹因非空而保留');
    expect(h.api.getChildrenIds(shopping)).toEqual([mine.id]);
    expect(h.api.getNode(news)).toBeUndefined();
    expect(prune(h.api.dump(), new Set([shopping]))).toEqual(original);
  });

  it('refuses when the phase is not done, when the snapshot is not applied, or when the ids do not match', async () => {
    const idle = harness(4);
    await expect(idle.organizer.undo()).rejects.toThrow(/没有可撤销的整理/);

    const h = harness(4);
    await reviewed(h);
    await h.organizer.apply();
    const snapshot = h.currentSnapshot()!;
    await expect(h.organizer.undo({ ...snapshot, status: 'rolled-back' })).rejects.toThrow(/已回滚/);
    await expect(h.organizer.undo({ ...snapshot, status: 'applying' })).rejects.toThrow(/应用中/);
    await expect(h.organizer.undo({ ...snapshot, id: 'someone-else' })).rejects.toThrow(/不匹配/);
    // 没动过书签
    expect(h.api.getChildrenIds('other-work')).toEqual(['bm-in-work', ...GH]);
    expect(h.currentSnapshot()!.status).toBe('applied');

    // 直接调共用入口也一样
    await expect(undoSnapshot(h.api, { ...snapshot, status: 'undone' }, async () => {})).rejects.toThrow(/已撤销/);
  });
});

describe('rollbackInterrupted (page died mid-apply)', () => {
  /** 「其他书签」= [a, b, c, F]；模拟 apply 到一半：新建 G，a 已 move 且记入 journal，b 已 move 但 journal 没落盘，c 还没动。 */
  async function interrupted(): Promise<{ api: FakeBookmarksApi; snapshot: Snapshot; original: DumpNode[]; gId: string }> {
    const api = createFakeBookmarksApi([
      { id: '1', title: 'Bookmarks bar', folderType: 'bookmarks-bar', syncing: false, children: [] },
      {
        id: '2',
        title: 'Other bookmarks',
        folderType: 'other',
        syncing: false,
        children: [
          { id: 'a', title: 'a', url: 'https://a' },
          { id: 'b', title: 'b', url: 'https://b' },
          { id: 'c', title: 'c', url: 'https://c' },
          { id: 'F', title: 'F', children: [{ id: 'f1', title: 'f1', url: 'https://f1' }] },
        ],
      },
    ]);
    const original = api.dump();
    const g = await api.create({ parentId: '2', title: 'G' });
    const item = (id: string, fromIndex: number) => ({ bookmarkId: id, toParentId: g.id, fromParentId: '2', fromIndex, title: id, url: `https://${id}` });
    const snapshot: Snapshot = {
      id: 'snap-interrupted',
      createdAt: 1,
      items: [item('a', 0), item('b', 1), item('c', 2)],
      createdFolderIds: [g.id],
      applied: ['a'],
      status: 'applying',
    };
    await api.move('a', { parentId: g.id });
    await api.move('b', { parentId: g.id });
    return { api, snapshot, original, gId: g.id };
  }

  it('restores the applied subset plus the journal-window item (moved but not journaled), leaves untouched items alone, status rolled-back', async () => {
    const { api, snapshot, original, gId } = await interrupted();
    expect(api.getChildrenIds('2')).toEqual(['c', 'F', gId]);

    const reconciled = await reconcileInterruptedJournal(api, snapshot);
    expect(reconciled.applied).toEqual(['a', 'b']);
    expect(snapshot.applied).toEqual(['a']); // 不改传入对象

    const persisted: Snapshot[] = [];
    const organizer = new Organizer({
      bookmarksApi: api,
      chat: scriptedChat(),
      persistJob: async () => {},
      persistSnapshot: async (s) => {
        if (s) persisted.push(s);
      },
      settings: settings(),
    });
    const summary = await organizer.rollbackInterrupted(snapshot);

    expect(summary).toEqual({ reason: 'interrupted', total: 2, restored: 2, skipped: 0, relocated: 0, failed: 0, removedFolders: 1, keptFolders: 0 });
    expect(describeRestoreSummary(summary)).toBe('已回滚 2/2');
    expect(api.dump()).toEqual(original);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ id: 'snap-interrupted', status: 'rolled-back', applied: ['a', 'b'] });
    expect(organizer.state.job.phase).toBe('idle'); // 不碰 job
  });

  it('[L1] only items[applied.length] is reconciled: a later unapplied item sitting in the target folder is NOT touched', async () => {
    const { api, snapshot, gId } = await interrupted();
    // c（items[2]）也在 G 里 —— 但 journal 窗口只有 items[1] = b；c 是用户自己放进去的
    await api.move('c', { parentId: gId });
    expect(api.getChildrenIds(gId)).toEqual(['a', 'b', 'c']);

    const reconciled = await reconcileInterruptedJournal(api, snapshot);
    expect(reconciled.applied).toEqual(['a', 'b']);

    const summary = await rollbackInterruptedSnapshot(api, snapshot, async () => {});
    expect(summary).toMatchObject({ total: 2, restored: 2, removedFolders: 0, keptFolders: 1 });
    expect(api.getChildrenIds(gId)).toEqual(['c']); // c 留在 G，G 因非空保留
    expect(api.getChildrenIds('2')).toEqual(['a', 'b', 'F', gId]);
  });

  it('[L1] the window item is not reconciled when it is not at toParentId, and a b-in-target with applied=[] still counts (items[0])', async () => {
    const { api, snapshot, gId } = await interrupted();
    // b 不在 G（用户挪回去了）→ 不补
    await api.move('b', { parentId: 'F' });
    expect((await reconcileInterruptedJournal(api, snapshot)).applied).toEqual(['a']);
    // applied 为空时窗口是 items[0] = a，它在 G → 补上
    expect((await reconcileInterruptedJournal(api, { ...snapshot, applied: [] })).applied).toEqual(['a']);
    expect(api.getNode('a')?.parentId).toBe(gId);
  });

  it('with a plain partial journal (nothing outside applied moved) only the applied subset is restored', async () => {
    const { api, snapshot, gId } = await interrupted();
    // 把 b 挪回去，模拟「只有 a 动过」
    await api.move('b', { parentId: '2', index: 0 });
    const persisted: Snapshot[] = [];
    const summary = await rollbackInterruptedSnapshot(api, snapshot, async (s) => void persisted.push(s));
    expect(summary).toMatchObject({ reason: 'interrupted', total: 1, restored: 1, removedFolders: 1 });
    expect(api.getChildrenIds('2')).toEqual(['a', 'b', 'c', 'F']);
    expect(api.getNode(gId)).toBeUndefined();
    expect(persisted[0]?.status).toBe('rolled-back');
  });

  it('refuses snapshots that are not applying, and refuses while this organizer is applying', async () => {
    const { api, snapshot } = await interrupted();
    await expect(rollbackInterruptedSnapshot(api, { ...snapshot, status: 'applied' }, async () => {})).rejects.toThrow(/没有需要回滚/);
    await expect(rollbackInterruptedSnapshot(api, { ...snapshot, status: 'rolled-back' }, async () => {})).rejects.toThrow(/已回滚/);
    expect(api.calls.move).toBe(2); // 只有 interrupted() 里的两次

    const gate = deferred();
    let moves = 0;
    const h = harness(4, {
      wrapApi: wrapMoves(async (_id, _dest, n) => {
        moves = n;
        if (n === 1) await gate.promise;
      }),
    });
    await reviewed(h);
    const applying = h.organizer.apply();
    while (moves < 1) await tick();
    await expect(h.organizer.rollbackInterrupted(snapshot)).rejects.toThrow(/正在应用中/);
    gate.resolve();
    await applying;
    expect(h.organizer.state.job.phase).toBe('done');
  });
});

describe('restore() and apply-related persistence (M6)', () => {
  it('[H1] does not restore a job left in applying, and does NOT clear it either (another organize tab may be writing it)', async () => {
    const h = harness(4);
    const live: OrganizeJob = { id: 'j', phase: 'applying', total: 30, done: 12, skipped: [], snapshotId: 'snap-x' };
    expect(await h.organizer.restore(live)).toBe(false);
    expect(h.organizer.state.job.phase).toBe('idle');
    expect(h.persisted).toEqual([]); // 不能 persist(null) 抹掉别的页面正在写的 job
    expect(h.organizer.isRunning).toBe(false);

    // 生成阶段的 job 仍然照旧清掉
    const midRun: OrganizeJob = { id: 'j2', phase: 'assigning', total: 40, done: 20, skipped: [] };
    expect(await h.organizer.restore(midRun)).toBe(false);
    expect(h.persisted).toEqual([null]);
  });

  it('[M2] restoring a review job skips bookmarks the user filed into a folder meanwhile (parent-changed) and never moves them', async () => {
    const first = harness(4);
    await reviewed(first);
    await first.organizer.flush();
    const saved = structuredClone(first.persisted[first.persisted.length - 1]!);

    const second = harness(4);
    // 用户在预览和刷新之间自己把 bm-tb-2 归档到「工作」，bm-news-1 挪到书签栏（另一个根，非 scope）
    await second.api.move('bm-tb-2', { parentId: 'other-work' });
    await second.api.move('bm-news-1', { parentId: '1' });
    expect(await second.organizer.restore(saved)).toBe(true);

    const { job, bookmarks } = second.organizer.state;
    expect(bookmarks.map((b) => b.id)).not.toContain('bm-tb-2');
    expect(bookmarks.map((b) => b.id)).not.toContain('bm-news-1');
    expect(bookmarks).toHaveLength(34);
    expect(job.skipped).toEqual([
      { bookmarkId: 'bm-tb-2', reason: 'parent-changed' },
      { bookmarkId: 'bm-news-1', reason: 'parent-changed' },
    ]);
    expect(job.proposal!.assignments.some((a) => a.bookmarkId === 'bm-tb-2' || a.bookmarkId === 'bm-news-1')).toBe(false);
    const planned = second.organizer.plannedMoves();
    expect(planned).toHaveLength(28);
    expect(planned.map((m) => m.bookmarkId)).not.toContain('bm-tb-2');

    await second.organizer.apply();
    expect(second.organizer.state.job.phase).toBe('done');
    expect(second.api.getNode('bm-tb-2')?.parentId).toBe('other-work');
    expect(second.api.getNode('bm-news-1')?.parentId).toBe('1');
    // 「工作」里：原有 1 条 + 用户放的 tb-2 + 10 条 github（追加）
    expect(second.api.getChildrenIds('other-work')).toEqual(['bm-in-work', 'bm-tb-2', ...GH]);
  });

  it('[M3] an apply where every item is skipped does not persist a snapshot: the previous undoable one survives', async () => {
    const h = harness(4);
    await reviewed(h);
    // 假装上一次整理留下的 snapshot 还在存储里
    const previous: Snapshot = { id: 'snap-previous', createdAt: 1, items: [], createdFolderIds: [], applied: ['bm-bar-1'], status: 'applied' };
    h.snapshots.push(previous);
    // 预览后所有计划内的书签都被用户挪走了
    for (const move of h.organizer.plannedMoves()) await h.api.move(move.bookmarkId, { parentId: 'other-work' });

    await h.organizer.apply();
    const { job } = h.organizer.state;
    expect(job.phase).toBe('review');
    expect(job.error).toContain('没有可移动的书签');
    expect(job.snapshotId).toBeUndefined();
    expect(job.skipped).toHaveLength(30);
    expect(job.skipped.every((s) => s.reason === 'parent-changed')).toBe(true);
    expect(h.currentSnapshot()).toBe(previous); // 一次都没写
    expect(h.snapshots).toHaveLength(1);
    expect(h.backups).toHaveLength(1); // 备份仍然做了（在校验之前）
    // 没有建过（也没留下）任何新文件夹
    expect(h.api.calls.create).toBe(0);
    expect(h.api.getChildrenIds('2').map((id) => h.api.getNode(id)!.title).filter((t) => t === '购物' || t === '资讯')).toEqual([]);
  });

  it('restores a done job as-is (result view), without adding skipped entries for bookmarks deleted after apply', async () => {
    const first = harness(4);
    await reviewed(first);
    await first.organizer.apply();
    await first.organizer.flush();
    const saved = structuredClone(first.persisted[first.persisted.length - 1]!);
    expect(saved.phase).toBe('done');

    const second = harness(4);
    // 第二个 fake 是原始树；删一条也不该被记成 skipped
    await second.api.remove('bm-gh-0');
    expect(await second.organizer.restore(saved)).toBe(true);
    expect(second.organizer.state.job).toEqual(saved);
    expect(second.organizer.state.job.snapshotId).toBe(saved.snapshotId);
    expect(second.record).toEqual([]);
    expect(second.persisted).toEqual([]);
  });

  it('restores an error-after-rollback job with its proposal so backToReview works after a reload', async () => {
    const first = harness(4, {
      wrapApi: wrapMoves((_id, _dest, n) => {
        if (n === 3) throw new Error('boom');
      }),
    });
    await reviewed(first);
    await first.organizer.apply();
    await first.organizer.flush();
    const saved = structuredClone(first.persisted[first.persisted.length - 1]!);
    expect(saved).toMatchObject({ phase: 'error', restore: { reason: 'failure' } });

    const second = harness(4);
    expect(await second.organizer.restore(saved)).toBe(true);
    expect(second.organizer.state.bookmarks).toHaveLength(36);
    await second.organizer.backToReview();
    expect(second.organizer.state.job.phase).toBe('review');
    expect(second.organizer.plannedMoves()).toHaveLength(30);
  });
});

describe('includeFoldered: restore origins, keep-still, emptied folders', () => {
  it('restore skips a loose-origin bookmark whose parent changed after persist', async () => {
    const first = harness(4);
    await reviewed(first);
    await first.organizer.flush();
    const saved = structuredClone(first.persisted[first.persisted.length - 1]!);
    expect(saved.origins?.['bm-tb-2']).toEqual({ parentId: '2', rootId: '2' });

    const second = harness(4);
    await second.api.move('bm-tb-2', { parentId: 'other-work' });
    expect(await second.organizer.restore(saved)).toBe(true);
    expect(second.organizer.state.bookmarks.map((b) => b.id)).not.toContain('bm-tb-2');
    expect(second.organizer.state.job.skipped).toContainEqual({ bookmarkId: 'bm-tb-2', reason: 'parent-changed' });
    expect(second.organizer.plannedMoves().map((m) => m.bookmarkId)).not.toContain('bm-tb-2');
  });

  it('restore skips a foldered-origin bookmark whose parent changed after persist', async () => {
    const first = harness(4, { settings: settings({ includeFoldered: true }) });
    await first.organizer.start();
    await first.organizer.flush();
    const saved = structuredClone(first.persisted[first.persisted.length - 1]!);
    expect(saved.origins?.['bm-in-work']).toEqual({ parentId: 'other-work', rootId: '2' });
    expect(first.organizer.state.bookmarks.map((b) => b.id)).toContain('bm-in-work');

    const second = harness(4, { settings: settings({ includeFoldered: true }) });
    await second.api.move('bm-in-work', { parentId: '2' });
    expect(await second.organizer.restore(saved)).toBe(true);
    expect(second.organizer.state.bookmarks.map((b) => b.id)).not.toContain('bm-in-work');
    expect(second.organizer.state.job.skipped).toContainEqual({ bookmarkId: 'bm-in-work', reason: 'parent-changed' });
    expect(second.organizer.state.job.proposal!.assignments.some((a) => a.bookmarkId === 'bm-in-work')).toBe(false);
  });

  it('already-in-reused-target is planned as keep-still and is not moved', async () => {
    const h = harness(4, { settings: settings({ includeFoldered: true }) });
    await h.api.move('bm-gh-0', { parentId: 'other-work' });
    await h.organizer.start();
    const keep = h.organizer.plannedMoves().find((m) => m.bookmarkId === 'bm-gh-0');
    expect(keep).toEqual({ bookmarkId: 'bm-gh-0', toParentId: 'other-work', expectedParentId: 'other-work' });

    await h.organizer.apply();
    expect(h.organizer.state.job.phase).toBe('done');
    expect(h.api.getNode('bm-gh-0')?.parentId).toBe('other-work');
    expect(h.organizer.state.job.skipped).toContainEqual({ bookmarkId: 'bm-gh-0', reason: 'same-parent' });
    expect(h.currentSnapshot()!.items.map((i) => i.bookmarkId)).not.toContain('bm-gh-0');
    expect(h.currentSnapshot()!.applied).not.toContain('bm-gh-0');
  });

  it('reports pre-existing folders emptied by apply and never deletes them', async () => {
    const h = harness(4, { settings: settings({ includeFoldered: true }) });
    const old = await h.api.create({ parentId: '2', title: '旧分类' });
    await h.api.move('bm-tb-0', { parentId: old.id });
    await h.organizer.start();
    expect(h.organizer.state.job.origins?.[old.id]).toBeUndefined();
    expect(h.organizer.state.job.origins?.['bm-tb-0']).toEqual({ parentId: old.id, rootId: '2' });

    const removesBefore = h.api.calls.remove;
    await h.organizer.apply();
    expect(h.organizer.state.job.phase).toBe('done');
    expect(h.api.getNode(old.id)).toBeDefined();
    expect(h.api.getChildrenIds(old.id)).toEqual([]);
    expect(h.api.calls.remove).toBe(removesBefore);
    expect(h.organizer.state.job.emptiedFolders).toEqual([{ id: old.id, path: ['旧分类'] }]);
  });
});
