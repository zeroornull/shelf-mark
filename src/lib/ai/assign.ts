import type { Assignment, Category, FlatBookmark } from '../types';
import { AiError, type ChatFn } from './client';
import { redactTitle, sanitizeUrl } from './privacy';
import { ASSIGN_SYSTEM, buildAssignUser, type AssignCategory } from './prompts';
import { assignSchema } from './schema';
import { UNCATEGORIZED, categoryPath, indexCategories } from './taxonomy';

/**
 * 批量归类（计划 §6.4）：每批 `batchSize` 条，`concurrency` 路 worker 从同一个队列取批次。
 *
 * - 模型只看到批次内序号 `i` + 脱敏后的 title / url，映射回 `bookmarkId` 在本地做
 * - 本地兜底不重跑整批：未知 categoryId → uncategorized（unknownCategory++）；漏掉的 i → uncategorized（missingIndex++）；
 *   多余 / 重复 / 越界的 i 忽略
 * - 任一批次重试后仍失败 → 取消其余批次，整个任务失败（反正还没写任何书签）
 * - `signal` 取消 → 立刻停止取新批次，在途请求 abort
 */

export type AssignWarnings = { unknownCategory: number; missingIndex: number };

export type AssignInput = {
  bookmarks: ReadonlyArray<Pick<FlatBookmark, 'id' | 'title' | 'url'>>;
  /** 可分配的类目（maxDepth=2 时只传叶子）。 */
  categories: Category[];
  /** 全部类目，用来拼 path（父类目标题）；默认与 `categories` 相同。 */
  allCategories?: Category[];
  batchSize: number;
  concurrency: number;
  domainOnly: boolean;
  signal?: AbortSignal;
  /** 每完成一批调用一次：done = 已处理书签数。 */
  onProgress?: (done: number, total: number) => void;
};

export type AssignResult = {
  /** 与 `input.bookmarks` 同序，每条书签恰好一条。 */
  assignments: Assignment[];
  warnings: AssignWarnings;
};

export type AssignDeps = { chat: ChatFn };

export const DEFAULT_BATCH_SIZE = 30;
export const DEFAULT_CONCURRENCY = 2;

export function chunk<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

export function assignCategoriesPayload(categories: Category[], allCategories: Category[] = categories): AssignCategory[] {
  const byId = indexCategories(allCategories.length > 0 ? allCategories : categories);
  return categories.map((c) => ({ id: c.id, title: c.title, path: categoryPath(c, byId) }));
}

export async function assignBookmarks(input: AssignInput, deps: AssignDeps): Promise<AssignResult> {
  const total = input.bookmarks.length;
  const warnings: AssignWarnings = { unknownCategory: 0, missingIndex: 0 };
  if (total === 0) return { assignments: [], warnings };

  const batches = chunk(input.bookmarks, input.batchSize || DEFAULT_BATCH_SIZE);
  const categoriesPayload = assignCategoriesPayload(input.categories, input.allCategories);
  const assignableIds = new Set(input.categories.map((c) => c.id));

  // 内部 controller：任一批失败或外部取消时，让其余在途请求一起停
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  input.signal?.addEventListener('abort', onExternalAbort, { once: true });

  const results: Assignment[][] = Array.from({ length: batches.length }, () => []);
  let next = 0;
  let done = 0;

  const processBatch = async (index: number): Promise<void> => {
    const batch = batches[index]!;
    const user = buildAssignUser({
      categories: categoriesPayload,
      bookmarks: batch.map((b, i) => ({ i, title: redactTitle(b.title), url: sanitizeUrl(b.url, input.domainOnly) })),
    });
    console.debug('[shelfmark] assign batch', index + 1, '/', batches.length, `(${batch.length} bookmarks)`);
    const raw = await deps.chat({ system: ASSIGN_SYSTEM, user, schema: assignSchema, signal: controller.signal });
    results[index] = mapBatch(batch, raw.items, assignableIds, warnings);
    done += batch.length;
    input.onProgress?.(done, total);
  };

  const worker = async (): Promise<void> => {
    while (true) {
      if (controller.signal.aborted) throw new AiError('aborted', '已取消');
      const index = next++;
      if (index >= batches.length) return;
      try {
        await processBatch(index);
      } catch (error) {
        controller.abort();
        throw error;
      }
    }
  };

  const workerCount = Math.max(1, Math.min(Math.floor(input.concurrency) || DEFAULT_CONCURRENCY, batches.length));
  const settled = await Promise.allSettled(Array.from({ length: workerCount }, () => worker()));
  input.signal?.removeEventListener('abort', onExternalAbort);

  const failures = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected').map((s) => s.reason as unknown);
  if (failures.length > 0) {
    if (input.signal?.aborted) throw new AiError('aborted', '已取消');
    // 优先报出真正的错误，而不是被连带取消的那些
    throw failures.find((e) => !(e instanceof AiError && e.kind === 'aborted')) ?? failures[0];
  }

  return { assignments: results.flat(), warnings };
}

/** 单批结果 → Assignment[]（与 batch 同序），本地兜底。 */
export function mapBatch(
  batch: ReadonlyArray<Pick<FlatBookmark, 'id'>>,
  items: ReadonlyArray<{ i: number; categoryId: string; confidence: Assignment['confidence'] }>,
  assignableIds: ReadonlySet<string>,
  warnings: AssignWarnings,
): Assignment[] {
  // 显式填 undefined：稀疏数组的空位会被 map 跳过，漏掉的 i 就补不上了
  const out: Array<Assignment | undefined> = Array.from({ length: batch.length }, () => undefined);
  for (const item of items) {
    if (!Number.isInteger(item.i) || item.i < 0 || item.i >= batch.length || out[item.i] !== undefined) continue;
    const bookmarkId = batch[item.i]!.id;
    if (assignableIds.has(item.categoryId)) {
      out[item.i] = { bookmarkId, categoryId: item.categoryId, confidence: item.confidence };
    } else {
      if (item.categoryId !== UNCATEGORIZED) warnings.unknownCategory += 1;
      out[item.i] = { bookmarkId, categoryId: UNCATEGORIZED, confidence: item.categoryId === UNCATEGORIZED ? item.confidence : 'low' };
    }
  }
  return out.map((assignment, i) => {
    if (assignment) return assignment;
    warnings.missingIndex += 1;
    return { bookmarkId: batch[i]!.id, categoryId: UNCATEGORIZED, confidence: 'low' };
  });
}

/** refine 的候选：uncategorized 或 low。 */
export function selectWeakAssignments(assignments: ReadonlyArray<Assignment>): Assignment[] {
  return assignments.filter((a) => a.categoryId === UNCATEGORIZED || a.confidence === 'low');
}

export const REFINE_MIN_COUNT = 10;
export const REFINE_MIN_RATIO = 0.2;

/** §6.5 触发条件：(uncategorized + low) / total > 20% 且条数 ≥ 10。 */
export function shouldRefine(weakCount: number, total: number): boolean {
  return total > 0 && weakCount >= REFINE_MIN_COUNT && weakCount / total > REFINE_MIN_RATIO;
}
