import { assignBookmarks, selectWeakAssignments, shouldRefine } from '../ai/assign';
import { AiError, describeAiError, type ChatFn } from '../ai/client';
import { detectLanguage, findDuplicates } from '../ai/sampling';
import { proposeTaxonomy, refineTaxonomy } from '../ai/taxonomy';
import type { BookmarksApi } from '../bookmarks/api';
import type { PlannedMove } from '../bookmarks/snapshot';
import {
  listReusableFolders,
  readBookmarkTree,
  selectBookmarksInScope,
  type BookmarkTree,
  type ReusableFolder,
  type RootInfo,
} from '../bookmarks/tree';
import type { FlatBookmark, JobInput, OrganizeJob, Proposal, ReviewState, Settings } from '../types';
import { resolveMoves } from './resolve';
import * as review from './review';

/**
 * 整理状态机（计划 §7），跑在 organize 页，不跑在 background。
 *
 * idle → loading-tree → proposing → assigning → (refining) → review → [applying → done：第 3 轮接 applySnapshot]
 *                                                             ↘ error（任何阶段失败，job.error = describeAiError）
 *
 * - 所有外部依赖注入：`bookmarksApi` / `chat` / `persistJob` / `settings` / `now`，单测用 fake api + 脚本化 chat
 * - 每次 phase 变化、每批 assign 完成后 `persistJob`；刷新页面用 `restore()` 回到 review，不重打模型
 * - `cancel()`：abort 在途请求，丢弃部分结果，回到 idle，不写任何书签；review 之前本类从不调用 create / move / remove
 * - review 编辑是 `./review` 里的纯函数，这里只做「应用 + 持久化 + 通知」
 */

export type OrganizerDeps = {
  bookmarksApi: BookmarksApi;
  chat: ChatFn;
  /** null → 清掉持久化的 job。 */
  persistJob: (job: OrganizeJob | null) => Promise<void>;
  settings: Settings | (() => Settings);
  now?: () => number;
  /** 生成 job id（测试用）。 */
  newId?: () => string;
};

export type OrganizerState = {
  job: OrganizeJob;
  /** 整理范围内的书签（review 恢复时按 assignments 从树里 join 出来）。 */
  bookmarks: FlatBookmark[];
  roots: RootInfo[];
  /** 范围内各根的可复用文件夹（存在 rootId，`resolveMoves` 用它判断同根）。 */
  existingFolders: ReusableFolder[];
};

export type OrganizerListener = (state: OrganizerState) => void;

/** 正在打模型 / 读树的阶段；这些阶段刷新页面后不可恢复，直接丢弃。 */
export const RUNNING_PHASES: ReadonlySet<OrganizeJob['phase']> = new Set(['loading-tree', 'proposing', 'assigning', 'refining']);

export function createIdleJob(id = 'idle'): OrganizeJob {
  return { id, phase: 'idle', total: 0, done: 0, skipped: [] };
}

export class Organizer {
  private job: OrganizeJob = createIdleJob();
  private bookmarks: FlatBookmark[] = [];
  private tree: BookmarkTree | null = null;
  private existingFolders: ReusableFolder[] = [];
  private controller: AbortController | null = null;
  private runToken = 0;
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<OrganizerListener>();

  constructor(private readonly deps: OrganizerDeps) {}

  // ---------------------------------------------------------------- state

  get state(): OrganizerState {
    return {
      job: this.job,
      bookmarks: this.bookmarks,
      roots: this.tree?.roots ?? [],
      existingFolders: this.existingFolders,
    };
  }

  get isRunning(): boolean {
    return RUNNING_PHASES.has(this.job.phase);
  }

  subscribe(listener: OrganizerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 等待所有已排队的 persistJob 完成（测试 / 关页前用）。 */
  flush(): Promise<void> {
    return this.persistQueue;
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * 从头开始：读树 → propose → assign → (refine) → review。
   * `input` 不传时取 settings 里的 seedCategories / userHint。
   */
  async start(input: Partial<JobInput> = {}): Promise<void> {
    if (this.isRunning) throw new Error('Organizer is already running.');
    const settings = this.settings();
    const jobInput: JobInput = {
      seedCategories: input.seedCategories ?? settings.seedCategories,
      userHint: input.userHint ?? settings.userHint,
    };
    this.job = { ...createIdleJob(this.newId()), input: jobInput };
    this.bookmarks = [];
    this.tree = null;
    this.existingFolders = [];

    if (settings.provider.apiKey.trim() === '') {
      await this.commit({ phase: 'error', error: '未配置 Key：先在设置页填写 apiKey 并测试连接' });
      return;
    }

    await this.execute(async (token, signal) => {
      await this.commit({ phase: 'loading-tree' }, token);
      const tree = await readBookmarkTree(this.deps.bookmarksApi);
      this.checkpoint(token, signal);
      this.tree = tree;
      this.bookmarks = selectBookmarksInScope(tree, settings.scope, settings.debugLimit);
      this.existingFolders = this.scopeRoots(tree, settings).flatMap((root) => listReusableFolders(tree, root.id));
      if (this.bookmarks.length === 0) {
        throw new Error('整理范围内没有散装书签');
      }
      await this.generate(token, signal, settings, jobInput);
    });
  }

  /** 「带提示重新生成」：沿用当前范围的书签，回到 proposing。 */
  async regenerate(userHint: string): Promise<void> {
    if (this.isRunning) throw new Error('Organizer is already running.');
    const input: JobInput = { seedCategories: this.job.input?.seedCategories ?? this.settings().seedCategories, userHint };
    if (this.bookmarks.length === 0 || this.tree === null) {
      await this.start(input);
      return;
    }
    const settings = this.settings();
    this.job = { ...this.job, input, proposal: undefined, review: undefined, error: undefined, skipped: [] };
    await this.execute((token, signal) => this.generate(token, signal, settings, input));
  }

  /** 取消：abort 在途请求，丢弃部分结果，回到 idle；不写任何书签。 */
  async cancel(): Promise<void> {
    this.runToken += 1;
    this.controller?.abort();
    this.controller = null;
    this.job = createIdleJob();
    this.emit();
    await this.persist(null);
  }

  /** 回到 idle 并清掉持久化的 job（review 之后放弃、或 error 后重来）。 */
  async reset(): Promise<void> {
    await this.cancel();
  }

  /**
   * 页面加载时恢复持久化的 job。review / done / error / applying 原样恢复（review 会重新读树 join 出书签，
   * 不重打模型）；正在运行中的阶段没法续跑，直接丢弃并清掉存储。返回是否恢复了一个 job。
   */
  async restore(saved: OrganizeJob | null): Promise<boolean> {
    if (!saved || saved.phase === 'idle' || RUNNING_PHASES.has(saved.phase)) {
      if (saved) await this.persist(null);
      return false;
    }
    this.job = saved;
    if (saved.proposal) {
      const tree = await readBookmarkTree(this.deps.bookmarksApi);
      this.tree = tree;
      this.existingFolders = this.scopeRoots(tree, this.settings()).flatMap((root) => listReusableFolders(tree, root.id));
      const byId = new Map(tree.bookmarks.map((b) => [b.id, b]));
      const bookmarks: FlatBookmark[] = [];
      const missing: string[] = [];
      for (const assignment of saved.proposal.assignments) {
        const bookmark = byId.get(assignment.bookmarkId);
        if (bookmark) bookmarks.push(bookmark);
        else missing.push(assignment.bookmarkId);
      }
      this.bookmarks = bookmarks;
      if (missing.length > 0) {
        const gone = new Set(missing);
        this.job = {
          ...saved,
          proposal: { ...saved.proposal, assignments: saved.proposal.assignments.filter((a) => !gone.has(a.bookmarkId)) },
          skipped: [...saved.skipped, ...missing.map((bookmarkId) => ({ bookmarkId, reason: 'missing' }))],
        };
      }
      if (!this.job.review) this.job = { ...this.job, review: review.defaultReviewState() };
    }
    this.emit();
    return true;
  }

  /** 第 3 轮接 `applySnapshot`（备份 → snapshot 落盘 → 串行 move → done）。 */
  apply(): Promise<never> {
    return Promise.reject(new Error('Organizer.apply() is not implemented in this round (round 3 wires applySnapshot).'));
  }

  // ---------------------------------------------------------------- review edits

  /** 当前 review 状态解析出的移动计划（`applySnapshot` 的输入）。非 review 阶段返回 []。 */
  plannedMoves(): PlannedMove[] {
    const { proposal, review: state } = this.job;
    if (!proposal || !state) return [];
    const rootByFolder = new Map(this.existingFolders.map((f) => [f.id, f.rootId]));
    return resolveMoves({ proposal, review: state, bookmarks: this.bookmarks, folderRoot: (id) => rootByFolder.get(id) });
  }

  setCategory(bookmarkId: string, categoryId: string): void {
    this.editProposal((p) => review.setAssignmentCategory(p, bookmarkId, categoryId));
  }

  mergeCategories(fromId: string, intoId: string): void {
    this.editProposal((p) => review.mergeCategories(p, fromId, intoId));
  }

  renameCategory(categoryId: string, title: string): void {
    this.editProposal((p) => review.renameCategory(p, categoryId, title, this.existingFolders));
  }

  excludeBookmark(bookmarkId: string): void {
    this.editReview((r) => review.excludeBookmark(r, bookmarkId));
  }

  includeBookmark(bookmarkId: string): void {
    this.editReview((r) => review.includeBookmark(r, bookmarkId));
  }

  setIncludeUncategorized(value: boolean): void {
    this.editReview((r) => review.setIncludeUncategorized(r, value));
  }

  setIncludeDuplicates(value: boolean): void {
    this.editReview((r) => review.setIncludeDuplicates(r, value));
  }

  // ---------------------------------------------------------------- internals

  private settings(): Settings {
    const { settings } = this.deps;
    return typeof settings === 'function' ? settings() : settings;
  }

  private newId(): string {
    if (this.deps.newId) return this.deps.newId();
    const now = (this.deps.now ?? Date.now)();
    const random = globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
    return `job-${now}-${random}`;
  }

  private scopeRoots(tree: BookmarkTree, settings: Settings): RootInfo[] {
    const allowed = settings.scope === 'loose-bar-and-other' ? ['bookmarks-bar', 'other'] : ['other'];
    return tree.roots.filter((root) => allowed.includes(root.folderType));
  }

  private emit(): void {
    const state = this.state;
    for (const listener of this.listeners) listener(state);
  }

  private persist(job: OrganizeJob | null): Promise<void> {
    // 串行化：进度写入很密，不能让旧值覆盖新值
    const snapshot = job === null ? null : structuredClone(job);
    this.persistQueue = this.persistQueue.then(() => this.deps.persistJob(snapshot)).catch((error) => {
      console.debug('[shelfmark] persistJob failed', error instanceof Error ? error.message : String(error));
    });
    return this.persistQueue;
  }

  /** 改 job 并通知 + 落盘；带 token 时先确认本次运行没被取消。 */
  private async commit(patch: Partial<OrganizeJob>, token?: number): Promise<void> {
    if (token !== undefined && token !== this.runToken) throw new AiError('aborted', '已取消');
    this.job = { ...this.job, ...patch };
    this.emit();
    await this.persist(this.job);
  }

  private checkpoint(token: number, signal: AbortSignal): void {
    if (token !== this.runToken || signal.aborted) throw new AiError('aborted', '已取消');
  }

  private async execute(body: (token: number, signal: AbortSignal) => Promise<void>): Promise<void> {
    const token = ++this.runToken;
    const controller = new AbortController();
    this.controller = controller;
    try {
      await body(token, controller.signal);
    } catch (error) {
      // 被 cancel() 取代：cancel 已经把状态置回 idle，这里什么都不做
      if (token !== this.runToken) return;
      if (controller.signal.aborted || (error instanceof AiError && error.kind === 'aborted')) return;
      await this.commit({ phase: 'error', error: describeAiError(error) });
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  private async generate(token: number, signal: AbortSignal, settings: Settings, input: JobInput): Promise<void> {
    const bookmarks = this.bookmarks;
    const total = bookmarks.length;
    const language = settings.language === 'auto' ? detectLanguage(bookmarks.map((b) => b.title)) : settings.language;
    const common = {
      existingFolders: this.existingFolders,
      seedCategories: input.seedCategories,
      userHint: input.userHint,
      maxDepth: settings.maxDepth,
      language,
      signal,
    };
    const deps = { chat: this.deps.chat };

    await this.commit({ phase: 'proposing', total, done: 0, proposal: undefined, review: undefined, error: undefined }, token);
    const taxonomy = await proposeTaxonomy({ bookmarks, ...common }, deps);
    this.checkpoint(token, signal);

    await this.commit({ phase: 'assigning', done: 0, total }, token);
    const onProgress = (done: number, batchTotal: number) => {
      if (token !== this.runToken) return;
      this.job = { ...this.job, done, total: batchTotal };
      this.emit();
      void this.persist(this.job);
    };
    const first = await assignBookmarks(
      {
        bookmarks,
        categories: taxonomy.leafCategories,
        allCategories: taxonomy.categories,
        batchSize: settings.batchSize,
        concurrency: settings.concurrency,
        domainOnly: settings.domainOnly,
        signal,
        onProgress,
      },
      deps,
    );
    this.checkpoint(token, signal);

    let categories = taxonomy.categories;
    let assignments = first.assignments;
    const warnings = { ...first.warnings };

    // §6.5 二轮补类目：只对 uncategorized / low 的那批，最多 1 轮
    const weak = selectWeakAssignments(assignments);
    if (shouldRefine(weak.length, total)) {
      const weakIds = new Set(weak.map((a) => a.bookmarkId));
      const weakBookmarks = bookmarks.filter((b) => weakIds.has(b.id));
      await this.commit({ phase: 'refining', done: 0, total: weakBookmarks.length }, token);
      const refined = await refineTaxonomy({ bookmarks: weakBookmarks, categories, ...common }, deps);
      this.checkpoint(token, signal);
      if (refined.added.length > 0) {
        categories = refined.categories;
        const second = await assignBookmarks(
          {
            bookmarks: weakBookmarks,
            categories: refined.leafCategories,
            allCategories: categories,
            batchSize: settings.batchSize,
            concurrency: settings.concurrency,
            domainOnly: settings.domainOnly,
            signal,
            onProgress,
          },
          deps,
        );
        this.checkpoint(token, signal);
        const replaced = new Map(second.assignments.map((a) => [a.bookmarkId, a]));
        assignments = assignments.map((a) => replaced.get(a.bookmarkId) ?? a);
        warnings.unknownCategory += second.warnings.unknownCategory;
        warnings.missingIndex += second.warnings.missingIndex;
      }
    }

    const proposal: Proposal = { categories, assignments, duplicates: findDuplicates(bookmarks), warnings };
    await this.commit({ phase: 'review', proposal, done: total, total, review: review.defaultReviewState() }, token);
  }

  private editProposal(edit: (proposal: Proposal) => Proposal): void {
    if (this.job.phase !== 'review' || !this.job.proposal) return;
    const next = edit(this.job.proposal);
    if (next === this.job.proposal) return;
    this.job = { ...this.job, proposal: next };
    this.emit();
    void this.persist(this.job);
  }

  private editReview(edit: (state: ReviewState) => ReviewState): void {
    if (this.job.phase !== 'review') return;
    const current = this.job.review ?? review.defaultReviewState();
    const next = edit(current);
    if (next === current && this.job.review) return;
    this.job = { ...this.job, review: next };
    this.emit();
    void this.persist(this.job);
  }
}
