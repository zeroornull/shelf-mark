import { describe, expect, it } from 'vitest';
import { AiError, type ChatFn } from '../src/lib/ai/client';
import { ASSIGN_SYSTEM, PROPOSE_SYSTEM, REFINE_SYSTEM } from '../src/lib/ai/prompts';
import { createFakeBookmarksApi } from '../src/lib/bookmarks/fake';
import { applySnapshot } from '../src/lib/bookmarks/snapshot';
import { Organizer, createIdleJob } from '../src/lib/jobs/organizer';
import type { OrganizeJob } from '../src/lib/types';
import { API_KEY, harness, scriptedChat, settings, tick, type AssignPayload, type Recorded } from './helpers/organizer-harness';

describe('Organizer – happy path', () => {
  it('walks loading-tree → proposing → assigning → review, persists each phase and each batch, never touches bookmarks', async () => {
    const { api, organizer, persisted, phases, record } = harness(4);
    await organizer.start();
    await organizer.flush();

    expect(phases).toEqual(['loading-tree', 'proposing', 'assigning', 'review']);
    const { job, bookmarks, roots, existingFolders } = organizer.state;
    expect(job.id).toBe('job-1');
    expect(job.phase).toBe('review');
    expect(job.total).toBe(36);
    expect(job.done).toBe(36);
    expect(bookmarks).toHaveLength(36);
    expect(bookmarks.every((b) => b.parentId === '2')).toBe(true); // loose-other only
    expect(roots.map((r) => r.id)).toEqual(['1', '2']);
    expect(existingFolders.map((f) => f.id)).toEqual(['other-work']); // scope 只有 other 根

    // 类目重编号，f0 → 真实文件夹 id，seed 已在输出中不重复补
    expect(job.proposal?.categories).toEqual([
      { id: 'c1', title: '开发', existingFolderId: 'other-work' },
      { id: 'c2', title: '购物' },
      { id: 'c3', title: '资讯' },
      { id: 'c4', title: '生活' },
    ]);
    expect(job.proposal?.assignments).toHaveLength(36);
    const byId = new Map(job.proposal!.assignments.map((a) => [a.bookmarkId, a]));
    expect(byId.get('bm-gh-3')).toEqual({ bookmarkId: 'bm-gh-3', categoryId: 'c1', confidence: 'high' });
    expect(byId.get('bm-tb-3')?.categoryId).toBe('c2');
    expect(byId.get('bm-news-3')?.categoryId).toBe('c3');
    expect(byId.get('bm-misc-0')).toEqual({ bookmarkId: 'bm-misc-0', categoryId: 'uncategorized', confidence: 'low' });
    expect(job.proposal?.duplicates).toEqual([{ url: 'https://github.com/dup/repo', bookmarkIds: ['bm-dup-1', 'bm-dup-2'] }]);
    expect(job.proposal?.warnings).toEqual({ unknownCategory: 0, missingIndex: 0 });
    expect(job.review).toEqual({ excluded: [], includeUncategorized: false, includeDuplicates: false });

    // 4 个杂项 / 36 = 11%，且 < 10 条 → 不 refine
    expect(record.filter((r) => r.system === REFINE_SYSTEM)).toHaveLength(0);
    expect(record.filter((r) => r.system === PROPOSE_SYSTEM)).toHaveLength(1);
    expect(record.filter((r) => r.system === ASSIGN_SYSTEM)).toHaveLength(4); // 36 / 10 → 4 批

    // 持久化：每个 phase + 每批进度
    const persistedPhases = persisted.map((j) => j?.phase);
    expect(persistedPhases[0]).toBe('loading-tree');
    expect(persistedPhases).toContain('proposing');
    expect(persistedPhases.filter((p) => p === 'assigning').length).toBeGreaterThanOrEqual(1 + 4);
    expect(persistedPhases[persistedPhases.length - 1]).toBe('review');
    const dones = persisted.filter((j) => j?.phase === 'assigning').map((j) => j!.done);
    expect(dones).toContain(36);
    expect(persisted[persisted.length - 1]?.proposal?.assignments).toHaveLength(36);

    // 预览阶段绝不写书签
    expect(api.calls).toMatchObject({ create: 0, move: 0, remove: 0 });
  });

  it('refuses to start without an api key and never calls the model', async () => {
    const record: Recorded[] = [];
    const { organizer, persisted } = harness(4, { settings: settings({ provider: { baseUrl: 'https://x', apiKey: '  ', model: 'm' } }), record });
    await organizer.start();
    expect(organizer.state.job.phase).toBe('error');
    expect(organizer.state.job.error).toContain('未配置 Key');
    expect(record).toHaveLength(0);
    expect(persisted[persisted.length - 1]?.phase).toBe('error');
  });

  it('errors when the scope has no loose bookmarks', async () => {
    const api = createFakeBookmarksApi([{ id: '2', title: 'Other', folderType: 'other', syncing: false, children: [] }]);
    const organizer = new Organizer({ bookmarksApi: api, chat: scriptedChat(), persistJob: async () => {}, persistSnapshot: async () => {}, settings: settings() });
    await organizer.start();
    expect(organizer.state.job.phase).toBe('error');
    expect(organizer.state.job.error).toContain('没有散装书签');
  });
});

describe('Organizer – refine', () => {
  it('triggers one refine round when (uncategorized + low) > 20% and ≥ 10, re-assigning only those bookmarks', async () => {
    const { organizer, phases, record } = harness(12);
    await organizer.start();

    expect(phases).toEqual(['loading-tree', 'proposing', 'assigning', 'refining', 'review']);
    expect(record.filter((r) => r.system === REFINE_SYSTEM)).toHaveLength(1);
    const refinePayload = JSON.parse(record.find((r) => r.system === REFINE_SYSTEM)!.user) as { existingCategories: unknown[]; uncategorizedCount: number; domains: Array<{ domain: string }> };
    expect(refinePayload.existingCategories).toHaveLength(4);
    expect(refinePayload.uncategorizedCount).toBe(12);
    expect(refinePayload.domains.every((d) => d.domain.endsWith('example.org'))).toBe(true);

    // 第一轮 44 条 / 10 = 5 批；第二轮只对 12 条杂项 = 2 批，且类目列表里有新类目 c5
    const assigns = record.filter((r) => r.system === ASSIGN_SYSTEM).map((r) => JSON.parse(r.user) as AssignPayload);
    expect(assigns).toHaveLength(7);
    const secondRound = assigns.slice(5);
    expect(secondRound.reduce((n, p) => n + p.bookmarks.length, 0)).toBe(12);
    expect(secondRound[0]?.categories.map((c) => c.id)).toContain('c5');
    expect(secondRound.every((p) => p.bookmarks.every((b) => b.url.includes('example.org')))).toBe(true);

    const { job } = organizer.state;
    expect(job.proposal?.categories.map((c) => [c.id, c.title])).toEqual([
      ['c1', '开发'],
      ['c2', '购物'],
      ['c3', '资讯'],
      ['c4', '生活'],
      ['c5', '工具'],
    ]);
    const misc = job.proposal!.assignments.filter((a) => a.bookmarkId.startsWith('bm-misc-'));
    expect(misc).toHaveLength(12);
    expect(misc.every((a) => a.categoryId === 'c5' && a.confidence === 'high')).toBe(true);
    expect(job.total).toBe(44);
    expect(job.done).toBe(44);
  });

  it('does not refine when weak count is below 10 even if the ratio is high', async () => {
    // 9 misc of 41 = 22% 但不足 10 条
    const { phases, record, organizer } = harness(9);
    await organizer.start();
    expect(phases).not.toContain('refining');
    expect(record.filter((r) => r.system === REFINE_SYSTEM)).toHaveLength(0);
  });
});

describe('Organizer – cancel and error', () => {
  it('cancel mid-assign aborts in-flight requests, discards results, clears storage and leaves bookmarks untouched', async () => {
    const record: Recorded[] = [];
    const gate = { block: true };
    const chat = scriptedChat(record, {
      onAssign: (_payload, signal) =>
        new Promise<void>((resolve, reject) => {
          if (!gate.block) return resolve();
          signal?.addEventListener('abort', () => reject(new AiError('aborted', '已取消')), { once: true });
        }),
    });
    const { api, organizer, persisted, phases } = harness(4, { chat, record });
    const original = api.dump();

    const running = organizer.start();
    while (organizer.state.job.phase !== 'assigning') await tick();
    await tick();
    expect(record.filter((r) => r.system === ASSIGN_SYSTEM)).toHaveLength(2); // concurrency 2

    await organizer.cancel();
    await running;
    await organizer.flush();

    expect(organizer.state.job.phase).toBe('idle');
    expect(organizer.state.job.proposal).toBeUndefined();
    expect(phases[phases.length - 1]).toBe('idle');
    expect(phases).not.toContain('error');
    expect(persisted[persisted.length - 1]).toBeNull();
    expect(api.dump()).toEqual(original);
    expect(api.calls).toMatchObject({ create: 0, move: 0, remove: 0 });
    expect(record.filter((r) => r.system === ASSIGN_SYSTEM)).toHaveLength(2); // 取消后不再取新批次
  });

  it('a model failure lands in error with the describeAiError text', async () => {
    const record: Recorded[] = [];
    const chat = scriptedChat(record, { failPropose: new AiError('http', 'HTTP 401：invalid key', { status: 401, detail: 'invalid key' }) });
    const { organizer, persisted, phases, api } = harness(4, { chat, record });
    await organizer.start();
    await organizer.flush();

    expect(phases).toEqual(['loading-tree', 'proposing', 'error']);
    expect(organizer.state.job.phase).toBe('error');
    expect(organizer.state.job.error).toContain('Key 无效');
    expect(persisted[persisted.length - 1]?.phase).toBe('error');
    expect(persisted[persisted.length - 1]?.error).toContain('Key 无效');
    expect(api.calls).toMatchObject({ create: 0, move: 0, remove: 0 });
  });

  it('a network failure during assign fails the job (no partial proposal)', async () => {
    const chat = scriptedChat([], {
      onAssign: (payload) => {
        if (payload.bookmarks[0]?.title.startsWith('HN')) throw new AiError('network', 'TypeError: Failed to fetch', { hint: 'x' });
      },
    });
    const { organizer } = harness(4, { chat });
    await organizer.start();
    expect(organizer.state.job.phase).toBe('error');
    expect(organizer.state.job.error).toContain('CORS / 未授权 origin');
    expect(organizer.state.job.proposal).toBeUndefined();
  });

  it('reset after review clears the job', async () => {
    const { organizer, persisted } = harness(4);
    await organizer.start();
    await organizer.reset();
    expect(organizer.state.job).toEqual(createIdleJob());
    expect(persisted[persisted.length - 1]).toBeNull();
  });
});

describe('Organizer – review edits and planned moves', () => {
  async function reviewed() {
    const h = harness(4);
    await h.organizer.start();
    return h;
  }

  it('setCategory / mergeCategories / renameCategory / exclude / include / toggles, all persisted', async () => {
    const { organizer, persisted } = await reviewed();
    const find = (id: string) => organizer.state.job.proposal!.assignments.find((a) => a.bookmarkId === id)!;

    organizer.setCategory('bm-misc-0', 'c2');
    expect(find('bm-misc-0')).toEqual({ bookmarkId: 'bm-misc-0', categoryId: 'c2', confidence: 'high' });
    organizer.setCategory('bm-misc-1', 'c-nope'); // 未知类目 → 忽略
    expect(find('bm-misc-1').categoryId).toBe('uncategorized');
    organizer.setCategory('bm-gh-0', 'uncategorized');
    expect(find('bm-gh-0').categoryId).toBe('uncategorized');

    organizer.mergeCategories('c3', 'c2');
    expect(organizer.state.job.proposal!.categories.map((c) => c.id)).toEqual(['c1', 'c2', 'c4']);
    expect(find('bm-news-0').categoryId).toBe('c2');

    organizer.renameCategory('c2', '  买买买 ');
    expect(organizer.state.job.proposal!.categories.find((c) => c.id === 'c2')?.title).toBe('买买买');
    organizer.renameCategory('c1', '开发工具'); // 改名后不再指向已有文件夹
    expect(organizer.state.job.proposal!.categories.find((c) => c.id === 'c1')).toEqual({ id: 'c1', title: '开发工具' });
    organizer.renameCategory('c1', '工作'); // 改成已有文件夹的名字 → 重新匹配
    expect(organizer.state.job.proposal!.categories.find((c) => c.id === 'c1')?.existingFolderId).toBe('other-work');
    organizer.renameCategory('c1', '   '); // 空名字忽略
    expect(organizer.state.job.proposal!.categories.find((c) => c.id === 'c1')?.title).toBe('工作');

    organizer.excludeBookmark('bm-tb-0');
    organizer.excludeBookmark('bm-tb-0');
    expect(organizer.state.job.review?.excluded).toEqual(['bm-tb-0']);
    organizer.includeBookmark('bm-tb-0');
    expect(organizer.state.job.review?.excluded).toEqual([]);
    organizer.setIncludeUncategorized(true);
    organizer.setIncludeDuplicates(true);
    expect(organizer.state.job.review).toEqual({ excluded: [], includeUncategorized: true, includeDuplicates: true });

    await organizer.flush();
    const last = persisted[persisted.length - 1]!;
    expect(last.phase).toBe('review');
    expect(last.review?.includeDuplicates).toBe(true);
    expect(last.proposal?.categories.map((c) => c.title)).toEqual(['工作', '买买买', '生活']);
  });

  it('plannedMoves resolves existing folders on the same root, paths elsewhere, and honours exclusions / toggles', async () => {
    const { organizer, api } = await reviewed();
    const moves = () => organizer.plannedMoves();

    // 默认：uncategorized 与重复项不动；开发 → 复用同根已有文件夹 other-work
    let planned = moves();
    const ids = planned.map((m) => m.bookmarkId);
    expect(ids).not.toContain('bm-misc-0');
    expect(ids).not.toContain('bm-dup-1');
    expect(ids).not.toContain('bm-dup-2');
    expect(planned.find((m) => m.bookmarkId === 'bm-gh-1')).toEqual({ bookmarkId: 'bm-gh-1', toParentId: 'other-work', expectedParentId: '2' });
    expect(planned.find((m) => m.bookmarkId === 'bm-tb-1')).toEqual({ bookmarkId: 'bm-tb-1', toPath: ['购物'], expectedParentId: '2' });
    expect(planned).toHaveLength(30);

    organizer.excludeBookmark('bm-gh-1');
    organizer.setIncludeUncategorized(true);
    organizer.setIncludeDuplicates(true);
    planned = moves();
    expect(planned.map((m) => m.bookmarkId)).not.toContain('bm-gh-1');
    expect(planned.find((m) => m.bookmarkId === 'bm-misc-0')).toEqual({ bookmarkId: 'bm-misc-0', toPath: ['未分类'], expectedParentId: '2' });
    expect(planned.find((m) => m.bookmarkId === 'bm-dup-1')).toEqual({ bookmarkId: 'bm-dup-1', toParentId: 'other-work', expectedParentId: '2' });
    expect(planned).toHaveLength(35);

    // 交给 applySnapshot（第 3 轮的接法）也能直接跑通
    const result = await applySnapshot(api, planned, { persist: async () => {} });
    expect(result.ok).toBe(true);
    expect(result.skipped).toEqual([]);
    expect(api.getChildrenIds('other-work')).toEqual(['bm-in-work', ...planned.filter((m) => 'toParentId' in m).map((m) => m.bookmarkId)]);
    const otherChildren = api.getChildrenIds('2').map((id) => api.getNode(id)!);
    expect(otherChildren.filter((n) => n.url === undefined).map((n) => n.title)).toEqual(['工作', '购物', '资讯', '未分类']);
    expect(otherChildren.filter((n) => n.url !== undefined).map((n) => n.id)).toEqual(['bm-gh-1']); // 只剩被剔除的那条
  });

  it('edits are ignored outside review', async () => {
    const { organizer } = harness(4);
    organizer.setCategory('bm-gh-0', 'c1');
    organizer.setIncludeUncategorized(true);
    expect(organizer.state.job).toEqual(createIdleJob());
    expect(organizer.plannedMoves()).toEqual([]);
  });

  it('regenerate with a new hint goes back to proposing without re-reading the tree, and the hint reaches the model', async () => {
    const { organizer, api, phases, record } = await reviewed();
    organizer.setIncludeUncategorized(true);
    const treeReads = api.calls.getTree;

    await organizer.regenerate('不要按语言分');
    expect(phases.slice(-4)).toEqual(['review', 'proposing', 'assigning', 'review']);
    expect(api.calls.getTree).toBe(treeReads);
    const proposes = record.filter((r) => r.system === PROPOSE_SYSTEM);
    expect(proposes).toHaveLength(2);
    expect(JSON.parse(proposes[1]!.user)).toMatchObject({ userHint: '不要按语言分', seedCategories: ['生活'] });
    expect(organizer.state.job.input?.userHint).toBe('不要按语言分');
    expect(organizer.state.job.id).toBe('job-1');
    expect(organizer.state.job.review).toEqual({ excluded: [], includeUncategorized: false, includeDuplicates: false }); // 编辑被重置
  });
});

describe('Organizer – restore', () => {
  it('restores a persisted review job without calling the model, joining bookmarks from the tree', async () => {
    const first = harness(4);
    await first.organizer.start();
    await first.organizer.flush();
    const saved = structuredClone(first.persisted[first.persisted.length - 1]!);

    const record: Recorded[] = [];
    const throwing = (async (args: { system: string }) => {
      record.push({ system: args.system, user: '' });
      throw new Error('model must not be called on restore');
    }) as ChatFn;
    const second = harness(4, { chat: throwing, record });
    const restored = await second.organizer.restore(saved);

    expect(restored).toBe(true);
    expect(record).toHaveLength(0);
    expect(second.organizer.state.job).toEqual({ ...saved, review: saved.review });
    expect(second.organizer.state.bookmarks).toHaveLength(36);
    expect(second.organizer.state.existingFolders.map((f) => f.id)).toEqual(['other-work']);
    expect(second.organizer.plannedMoves()).toHaveLength(30);
    expect(second.persisted).toEqual([]); // 恢复本身不重写
  });

  it('drops assignments whose bookmarks vanished and records them in skipped', async () => {
    const first = harness(4);
    await first.organizer.start();
    const saved = structuredClone(first.organizer.state.job);

    const second = harness(4);
    await second.api.remove('bm-gh-0');
    await second.organizer.restore(saved);
    expect(second.organizer.state.bookmarks.map((b) => b.id)).not.toContain('bm-gh-0');
    expect(second.organizer.state.job.proposal?.assignments).toHaveLength(35);
    expect(second.organizer.state.job.skipped).toEqual([{ bookmarkId: 'bm-gh-0', reason: 'missing' }]);
  });

  it('discards jobs persisted mid-run (cannot resume a half-finished model call) and clears them', async () => {
    const { organizer, persisted } = harness(4);
    const midRun: OrganizeJob = { id: 'j', phase: 'assigning', total: 40, done: 20, skipped: [] };
    expect(await organizer.restore(midRun)).toBe(false);
    expect(organizer.state.job.phase).toBe('idle');
    expect(persisted).toEqual([null]);
    expect(await organizer.restore(null)).toBe(false);
  });

  it('restores an error job as-is', async () => {
    const { organizer } = harness(4);
    const failed: OrganizeJob = { id: 'j', phase: 'error', total: 0, done: 0, skipped: [], error: 'Key 无效（HTTP 401）' };
    expect(await organizer.restore(failed)).toBe(true);
    expect(organizer.state.job).toEqual(failed);
  });
});

describe('Organizer – payload leak check (§13)', () => {
  it('no request body contains real bookmark / folder ids, query strings, fragments, emails or the api key', async () => {
    const { organizer, record, api } = harness(12);
    await organizer.start();
    expect(organizer.state.job.phase).toBe('review');
    expect(record.length).toBeGreaterThan(5);

    const realIds = api.dump().flatMap(function collect(node): string[] {
      return [node.id, ...(node.children ?? []).flatMap(collect)];
    });
    expect(realIds).toContain('bm-gh-0');
    expect(realIds).toContain('other-work');

    for (const { system, user } of record) {
      const body = `${system}\n${user}`;
      for (const id of realIds) expect(body).not.toContain(`"${id}"`);
      expect(body).not.toMatch(/bm-[a-z]+-\d+/);
      expect(body).not.toContain('other-work');
      expect(body).not.toContain('bar-work');
      // URL 只出现在 user payload 里（system prompt 原文含 "parentId?"）
      expect(user).not.toContain('?');
      expect(user).not.toContain('#');
      expect(body).not.toContain('dev@example.com');
      expect(body).not.toContain(API_KEY);
      expect(body).not.toContain('sk-');
    }
    // 已有文件夹只以 f* + 路径出现
    const propose = JSON.parse(record.find((r) => r.system === PROPOSE_SYSTEM)!.user) as { existingFolders: unknown };
    expect(propose.existingFolders).toEqual([{ ref: 'f0', path: ['工作'] }]);
  });
});
