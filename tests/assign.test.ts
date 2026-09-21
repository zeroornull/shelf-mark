import { describe, expect, it } from 'vitest';
import { assignBookmarks, chunk, mapBatch, selectWeakAssignments, shouldRefine } from '../src/lib/ai/assign';
import { AiError, type ChatFn } from '../src/lib/ai/client';
import { ASSIGN_SYSTEM } from '../src/lib/ai/prompts';
import type { Category } from '../src/lib/types';

const categories: Category[] = [
  { id: 'c1', title: '开发' },
  { id: 'c2', title: '前端', parentId: 'c1' },
  { id: 'c3', title: '购物' },
];
const leaves = categories.filter((c) => c.id !== 'c1');

const bookmarks = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `real-bm-${i}`,
    title: `Title ${i} owner@example.com`,
    url: `https://site${i % 4}.com/path/a/b/c/d?q=${i}#frag`,
  }));

type Payload = { categories: Array<{ id: string; title: string; path: string[] }>; bookmarks: Array<{ i: number; title: string; url: string }> };

/** 每批把所有 i 交替分到 c2 / c3；记录 payload。 */
function echoChat(record: Payload[] = []): ChatFn {
  return (async (args: { system: string; user: string }) => {
    const payload = JSON.parse(args.user) as Payload;
    record.push(payload);
    expect(args.system).toBe(ASSIGN_SYSTEM);
    return {
      items: payload.bookmarks.map((b) => ({ i: b.i, categoryId: b.i % 2 === 0 ? 'c2' : 'c3', confidence: 'high' })),
    };
  }) as ChatFn;
}

describe('chunk', () => {
  it('splits into batches of batchSize with a shorter tail', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe('assignBookmarks – batching and payload', () => {
  it('uses batches of batchSize, local i indices, sanitized title/url, category paths; never sends real ids', async () => {
    const record: Payload[] = [];
    const progress: Array<[number, number]> = [];
    const input = bookmarks(25);

    const result = await assignBookmarks(
      { bookmarks: input, categories: leaves, allCategories: categories, batchSize: 10, concurrency: 1, domainOnly: false, onProgress: (d, t) => progress.push([d, t]) },
      { chat: echoChat(record) },
    );

    expect(record.map((p) => p.bookmarks.length)).toEqual([10, 10, 5]);
    expect(record[0]?.bookmarks.map((b) => b.i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(record[2]?.bookmarks.map((b) => b.i)).toEqual([0, 1, 2, 3, 4]);
    expect(record[0]?.categories).toEqual([
      { id: 'c2', title: '前端', path: ['开发', '前端'] },
      { id: 'c3', title: '购物', path: ['购物'] },
    ]);
    const allText = record.map((p) => JSON.stringify(p)).join('\n');
    expect(allText).not.toContain('real-bm');
    expect(allText).not.toContain('?q=');
    expect(allText).not.toContain('#frag');
    expect(allText).not.toContain('owner@example.com');
    expect(record[0]?.bookmarks[0]?.url).toBe('https://site0.com/path/a/b');
    expect(record[0]?.bookmarks[0]?.title).toBe('Title 0 [email]');

    expect(progress).toEqual([
      [10, 25],
      [20, 25],
      [25, 25],
    ]);
    expect(result.assignments).toHaveLength(25);
    expect(result.assignments.map((a) => a.bookmarkId)).toEqual(input.map((b) => b.id));
    // 批内 i 映射回正确的 bookmarkId：第 2 批的 i=0 是第 10 条书签
    expect(result.assignments[10]).toEqual({ bookmarkId: 'real-bm-10', categoryId: 'c2', confidence: 'high' });
    expect(result.assignments[11]?.categoryId).toBe('c3');
    expect(result.warnings).toEqual({ unknownCategory: 0, missingIndex: 0 });
  });

  it('domainOnly sends hostnames only', async () => {
    const record: Payload[] = [];
    await assignBookmarks({ bookmarks: bookmarks(2), categories: leaves, batchSize: 30, concurrency: 2, domainOnly: true }, { chat: echoChat(record) });
    expect(record[0]?.bookmarks.map((b) => b.url)).toEqual(['site0.com', 'site1.com']);
  });

  it('returns empty result without calling the model for zero bookmarks', async () => {
    let calls = 0;
    const chat = (async () => {
      calls += 1;
      return { items: [] };
    }) as ChatFn;
    const result = await assignBookmarks({ bookmarks: [], categories: leaves, batchSize: 10, concurrency: 2, domainOnly: false }, { chat });
    expect(result).toEqual({ assignments: [], warnings: { unknownCategory: 0, missingIndex: 0 } });
    expect(calls).toBe(0);
  });
});

describe('assignBookmarks – concurrency', () => {
  function gatedChat() {
    let inFlight = 0;
    let maxInFlight = 0;
    const pending: Array<() => void> = [];
    const chat = (async (args: { user: string }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => pending.push(resolve));
      inFlight -= 1;
      const payload = JSON.parse(args.user) as Payload;
      return { items: payload.bookmarks.map((b) => ({ i: b.i, categoryId: 'c3', confidence: 'medium' })) };
    }) as ChatFn;
    // 一次放行一个并让出事件循环，worker 才来得及把下一批排进 pending
    const release = async (n = 1) => {
      for (let k = 0; k < n; k += 1) {
        pending.shift()?.();
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    return { chat, release, stats: () => ({ inFlight, maxInFlight, pendingCount: pending.length }) };
  }

  it('runs at most `concurrency` batches at once and keeps the pool busy', async () => {
    const gate = gatedChat();
    const promise = assignBookmarks({ bookmarks: bookmarks(50), categories: leaves, batchSize: 10, concurrency: 2, domainOnly: false }, { chat: gate.chat });

    await new Promise((r) => setTimeout(r, 0));
    expect(gate.stats().inFlight).toBe(2);
    await gate.release(1);
    expect(gate.stats().inFlight).toBe(2); // 释放一个，立刻补一个
    await gate.release(4);
    expect(gate.stats().pendingCount).toBe(0);
    const result = await promise;
    expect(gate.stats().maxInFlight).toBe(2);
    expect(result.assignments).toHaveLength(50);
  });

  it('never exceeds the batch count and honours concurrency 1 / 3', async () => {
    const gate1 = gatedChat();
    const p1 = assignBookmarks({ bookmarks: bookmarks(30), categories: leaves, batchSize: 10, concurrency: 1, domainOnly: false }, { chat: gate1.chat });
    await new Promise((r) => setTimeout(r, 0));
    expect(gate1.stats().inFlight).toBe(1);
    await gate1.release(3);
    await p1;
    expect(gate1.stats().maxInFlight).toBe(1);

    const gate3 = gatedChat();
    const p3 = assignBookmarks({ bookmarks: bookmarks(20), categories: leaves, batchSize: 10, concurrency: 3, domainOnly: false }, { chat: gate3.chat });
    await new Promise((r) => setTimeout(r, 0));
    expect(gate3.stats().inFlight).toBe(2); // 只有 2 批
    await gate3.release(2);
    await p3;
  });
});

describe('mapBatch / fallbacks', () => {
  const batch = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  const assignable = new Set(['c2', 'c3']);

  it('unknown category → uncategorized + unknownCategory++, missing i → uncategorized + missingIndex++, extra/duplicate i ignored', () => {
    const warnings = { unknownCategory: 0, missingIndex: 0 };
    const out = mapBatch(
      batch,
      [
        { i: 0, categoryId: 'c2', confidence: 'high' },
        { i: 1, categoryId: 'c99', confidence: 'high' }, // unknown
        { i: 1, categoryId: 'c3', confidence: 'high' }, // duplicate i → ignored
        { i: 7, categoryId: 'c3', confidence: 'high' }, // out of range → ignored
        { i: -1, categoryId: 'c3', confidence: 'high' }, // negative → ignored
        { i: 3, categoryId: 'uncategorized', confidence: 'medium' }, // explicit uncategorized is not a warning
        // i=2 missing
      ],
      assignable,
      warnings,
    );
    expect(out).toEqual([
      { bookmarkId: 'a', categoryId: 'c2', confidence: 'high' },
      { bookmarkId: 'b', categoryId: 'uncategorized', confidence: 'low' },
      { bookmarkId: 'c', categoryId: 'uncategorized', confidence: 'low' },
      { bookmarkId: 'd', categoryId: 'uncategorized', confidence: 'medium' },
    ]);
    expect(warnings).toEqual({ unknownCategory: 1, missingIndex: 1 });
  });

  it('rejects a parent (non-leaf) category id when only leaves are assignable', () => {
    const warnings = { unknownCategory: 0, missingIndex: 0 };
    const out = mapBatch([{ id: 'a' }], [{ i: 0, categoryId: 'c1', confidence: 'high' }], assignable, warnings);
    expect(out[0]?.categoryId).toBe('uncategorized');
    expect(warnings.unknownCategory).toBe(1);
  });

  it('accumulates warnings across batches through assignBookmarks', async () => {
    const chat = (async (args: { user: string }) => {
      const payload = JSON.parse(args.user) as Payload;
      // 每批：第 0 条给未知类目，其余漏掉
      return { items: [{ i: 0, categoryId: 'nope', confidence: 'high' }] };
    }) as ChatFn;
    const result = await assignBookmarks({ bookmarks: bookmarks(7), categories: leaves, batchSize: 3, concurrency: 2, domainOnly: false }, { chat });
    expect(result.warnings).toEqual({ unknownCategory: 3, missingIndex: 4 });
    expect(result.assignments.every((a) => a.categoryId === 'uncategorized')).toBe(true);
  });
});

describe('assignBookmarks – abort and failure', () => {
  it('stops taking new batches when the signal aborts and rejects with kind aborted', async () => {
    const controller = new AbortController();
    let started = 0;
    const chat = (async (args: { user: string; signal?: AbortSignal }) => {
      started += 1;
      await new Promise<void>((_resolve, reject) => {
        args.signal?.addEventListener('abort', () => reject(new AiError('aborted', '已取消')), { once: true });
      });
      return { items: [] };
    }) as ChatFn;

    const promise = assignBookmarks(
      { bookmarks: bookmarks(40), categories: leaves, batchSize: 10, concurrency: 2, domainOnly: false, signal: controller.signal },
      { chat },
    ).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    const error = await promise;
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).kind).toBe('aborted');
    expect(started).toBe(2);
  });

  it('a failing batch fails the whole job and cancels the other in-flight batches', async () => {
    let aborted = 0;
    let started = 0;
    const chat = (async (args: { user: string; signal?: AbortSignal }) => {
      started += 1;
      const payload = JSON.parse(args.user) as Payload;
      if (payload.bookmarks[0]?.title.startsWith('Title 10 ')) throw new AiError('http', 'HTTP 500', { status: 500 });
      await new Promise<void>((_resolve, reject) => {
        args.signal?.addEventListener(
          'abort',
          () => {
            aborted += 1;
            reject(new AiError('aborted', '已取消'));
          },
          { once: true },
        );
      });
      return { items: [] };
    }) as ChatFn;

    const error = await assignBookmarks({ bookmarks: bookmarks(40), categories: leaves, batchSize: 10, concurrency: 2, domainOnly: false }, { chat }).catch(
      (e: unknown) => e,
    );
    expect((error as AiError).kind).toBe('http');
    expect((error as AiError).status).toBe(500);
    expect(aborted).toBe(1);
    expect(started).toBe(2); // 第 3、4 批从未开始
  });
});

describe('refine trigger helpers', () => {
  it('selectWeakAssignments picks uncategorized or low', () => {
    const weak = selectWeakAssignments([
      { bookmarkId: 'a', categoryId: 'c1', confidence: 'high' },
      { bookmarkId: 'b', categoryId: 'uncategorized', confidence: 'high' },
      { bookmarkId: 'c', categoryId: 'c1', confidence: 'low' },
      { bookmarkId: 'd', categoryId: 'c1', confidence: 'medium' },
    ]);
    expect(weak.map((a) => a.bookmarkId)).toEqual(['b', 'c']);
  });

  it('shouldRefine requires > 20% and ≥ 10', () => {
    expect(shouldRefine(10, 40)).toBe(true); // 25%
    expect(shouldRefine(9, 20)).toBe(false); // 45% but < 10
    expect(shouldRefine(10, 50)).toBe(false); // exactly 20% is not > 20%
    expect(shouldRefine(11, 50)).toBe(true);
    expect(shouldRefine(0, 0)).toBe(false);
  });
});
