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
  it('discards a job left in applying by a crash (the snapshot banner handles it), clearing storage', async () => {
    const h = harness(4);
    const crashed: OrganizeJob = { id: 'j', phase: 'applying', total: 30, done: 12, skipped: [], snapshotId: 'snap-x' };
    expect(await h.organizer.restore(crashed)).toBe(false);
    expect(h.organizer.state.job.phase).toBe('idle');
    expect(h.persisted).toEqual([null]);
    expect(h.organizer.isRunning).toBe(false);
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
