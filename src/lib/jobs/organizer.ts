import { assignBookmarks, selectWeakAssignments, shouldRefine } from '../ai/assign';
import { AiError, describeAiError, type ChatFn } from '../ai/client';
import { detectLanguage, findDuplicates } from '../ai/sampling';
import { proposeTaxonomy, refineTaxonomy } from '../ai/taxonomy';
import type { BookmarksApi, BookmarkTreeNode } from '../bookmarks/api';
import { describeBookmarkError } from '../bookmarks/errors';
import { ApplySnapshotError, applySnapshot, type ApplyResult, type PlannedMove } from '../bookmarks/snapshot';
import {
  listEmptiedUserFolders,
  listReusableFolders,
  readBookmarkTree,
  selectBookmarksInScope,
  type BookmarkTree,
  type ReusableFolder,
  type RootInfo,
} from '../bookmarks/tree';
import type { BookmarkOrigin, FlatBookmark, JobInput, OrganizeJob, Proposal, RestoreSummary, ReviewState, Settings, Snapshot } from '../types';
import { rollbackInterruptedSnapshot, summarizeRestore, undoSnapshot } from './recovery';
import { resolveMoves } from './resolve';
import * as review from './review';

/**
 * 整理状态机（计划 §7），跑在 organize 页，不跑在 background。
 *
 * idle → loading-tree → proposing → assigning → (refining) → review → applying → done
 *                                                             ↘ error（任何阶段失败；apply 失败 / 取消时已回滚）
 *
 * - 所有外部依赖注入：`bookmarksApi` / `chat` / `persistJob` / `persistSnapshot` / `backup` / `settings` / `now`，
 *   单测用 fake api + 脚本化 chat + 记录器
 * - 每次 phase 变化、每批 assign 完成、每条 move 完成后 `persistJob`；刷新页面用 `restore()` 回到 review，不重打模型
 * - `cancel()`：生成阶段 abort 在途请求、丢弃部分结果、回到 idle；applying 阶段不打断正在进行的 move，
 *   在下一条之前停下并对 `applied` 子集回滚（§7），结果是 `error` + 「已取消，已回滚 N/M」
 * - review 之前本类从不调用 create / move / remove；`apply()` 之后写入全部走 `applySnapshot`（备份 → snapshot 落盘 → 串行 move）
 * - review 编辑是 `./review` 里的纯函数，这里只做「应用 + 持久化 + 通知」
 */

export type OrganizerDeps = {
  bookmarksApi: BookmarksApi;
  chat: ChatFn;
  /** null → 清掉持久化的 job。 */
  persistJob: (job: OrganizeJob | null) => Promise<void>;
  /** snapshot / journal 落盘（apply 每条 move 后一次，undo / 回滚后一次）；null → 清掉。 */
  persistSnapshot: (snapshot: Snapshot | null) => Promise<void>;
  /** 读当前持久化的 snapshot（`undo()` 不传参时用）。 */
  loadSnapshot?: () => Promise<Snapshot | null>;
  /** §5.3 第 0 步：生成并下载 HTML 备份，返回文件名。`settings.autoBackup` 为 false 时不会调用。 */
  backup?: (tree: BookmarkTreeNode[]) => Promise<string>;
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

/**
 * 正在读树 / 打模型 / 写书签的阶段；这些阶段刷新页面后不可恢复，`restore()` 不会恢复它们。
 * 生成阶段的 job 会被清掉；`applying` 的 job **原样留在存储里**（可能是另一个 organize 页正在写），
 * 被中断的 apply 由持久化的 snapshot（`status: 'applying'`）驱动回滚横幅（§5.3）。
 */
export const RUNNING_PHASES: ReadonlySet<OrganizeJob['phase']> = new Set(['loading-tree', 'proposing', 'assigning', 'refining', 'applying']);

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
  /** 在途的 apply；`cancel()` 在 applying 阶段等它（含回滚）结束。 */
  private applying: Promise<void> | null = null;
  /** `applySnapshot` 的 `shouldStop` 读它：true → 下一条 move 之前停下并回滚。 */
  private stopRequested = false;
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
    const includeFoldered = input.includeFoldered ?? settings.includeFoldered ?? true;
    const jobInput: JobInput = {
      seedCategories: input.seedCategories ?? settings.seedCategories,
      userHint: input.userHint ?? settings.userHint,
      includeFoldered,
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
      this.bookmarks = selectBookmarksInScope(tree, settings.scope, settings.debugLimit, includeFoldered);
      this.existingFolders = this.scopeRoots(tree, settings).flatMap((root) => listReusableFolders(tree, root.id));
      this.job = { ...this.job, origins: originsFrom(this.bookmarks) };
      if (this.bookmarks.length === 0) {
        throw new Error('整理范围内没有书签');
      }
      await this.generate(token, signal, settings, jobInput);
    });
  }

  /** 「带提示重新生成」：沿用当前范围的书签，回到 proposing。 */
  async regenerate(userHint: string): Promise<void> {
    if (this.isRunning) throw new Error('Organizer is already running.');
    const input: JobInput = {
      seedCategories: this.job.input?.seedCategories ?? this.settings().seedCategories,
      userHint,
      includeFoldered: this.job.input?.includeFoldered ?? this.settings().includeFoldered ?? true,
    };
    if (this.bookmarks.length === 0 || this.tree === null) {
      await this.start(input);
      return;
    }
    const settings = this.settings();
    this.job = { ...this.job, input, proposal: undefined, review: undefined, error: undefined, skipped: [] };
    await this.execute((token, signal) => this.generate(token, signal, settings, input));
  }

  /**
   * 取消。
   * - 生成阶段：abort 在途请求，丢弃部分结果，回到 idle；不写任何书签。
   * - applying 阶段（§7）：不打断正在进行的 move；置停止标志，`applySnapshot` 在下一条之前停下并对 `applied`
   *   子集回滚，本方法等回滚结束才返回。结果 phase 是 `error`，`job.error` = 「已取消，已回滚 N/M」，
   *   `job.restore.reason === 'cancel'`；proposal 仍在，可 `backToReview()` 后再次应用。
   */
  async cancel(): Promise<void> {
    if (this.job.phase === 'applying' && this.applying) {
      this.stopRequested = true;
      await this.applying;
      return;
    }
    this.runToken += 1;
    this.controller?.abort();
    this.controller = null;
    this.job = createIdleJob();
    this.emit();
    await this.persist(null);
  }

  /** 回到 idle 并清掉持久化的 job（review 之后放弃、done / error 后重来）。applying 阶段会先取消并回滚。 */
  async reset(): Promise<void> {
    await this.cancel();
    if (this.job.phase !== 'idle') {
      this.job = createIdleJob();
      this.emit();
      await this.persist(null);
    }
  }

  /**
   * 页面加载时恢复持久化的 job。review / done / error 原样恢复（有 proposal 时重新读树 join 出书签，
   * 不重打模型；review 只保留 parentId 仍等于制定计划时 origins 的书签，其余记入 skipped）；
   * 生成阶段的 job 没法续跑，丢弃并清掉存储；`applying` 的 job 不恢复也不清（可能是另一个页面正在写，
   * 被中断的情况由 snapshot 横幅处理）。返回是否恢复了一个 job。
   */
  async restore(saved: OrganizeJob | null): Promise<boolean> {
    if (!saved || saved.phase === 'idle') return false;
    if (saved.phase === 'applying') {
      // 可能是另一个 organize 页正在写（多开标签）——绝不能清掉它的 job；真被中断的情况由 snapshot 横幅处理
      return false;
    }
    if (RUNNING_PHASES.has(saved.phase)) {
      await this.persist(null);
      return false;
    }
    this.job = saved;
    if (saved.proposal) {
      const settings = this.settings();
      const tree = await readBookmarkTree(this.deps.bookmarksApi);
      this.tree = tree;
      const scopeRootIds = new Set(this.scopeRoots(tree, settings).map((root) => root.id));
      this.existingFolders = [...scopeRootIds].flatMap((rootId) => listReusableFolders(tree, rootId));
      const byId = new Map(tree.bookmarks.map((b) => [b.id, b]));
      const bookmarks: FlatBookmark[] = [];
      const dropped: OrganizeJob['skipped'] = [];
      for (const assignment of saved.proposal.assignments) {
        const bookmark = byId.get(assignment.bookmarkId);
        if (!bookmark) {
          dropped.push({ bookmarkId: assignment.bookmarkId, reason: 'missing' });
          continue;
        }
        // review：只保留「还在制定计划时的父文件夹」且根仍在范围内的书签。
        // 不能用「仍是散装」——范围内本来就可以有文件夹里的书签；用户中途挪走过的必须跳过。
        if (saved.phase === 'review') {
          const origin = saved.origins?.[bookmark.id];
          // 有 origins（新 job）：parentId 必须仍是制定计划时的值。没有 origins 的旧 job 仍按「还在范围内的根下」判断。
          const parentOk = saved.origins
            ? origin !== undefined && bookmark.parentId === origin.parentId
            : bookmark.parentId === bookmark.rootId;
          if (!parentOk || !scopeRootIds.has(bookmark.rootId)) {
            dropped.push({ bookmarkId: bookmark.id, reason: 'parent-changed' });
            continue;
          }
        }
        bookmarks.push(bookmark);
      }
      this.bookmarks = bookmarks;
      // 只有 review 才把这些书签剔出计划；done / error 是历史结果，原样展示（书签列表仍按现存的 join）
      if (saved.phase === 'review' && dropped.length > 0) {
        const gone = new Set(dropped.map((d) => d.bookmarkId));
        this.job = {
          ...saved,
          proposal: { ...saved.proposal, assignments: saved.proposal.assignments.filter((a) => !gone.has(a.bookmarkId)) },
          skipped: [...saved.skipped, ...dropped],
        };
      }
      if (!this.job.review) this.job = { ...this.job, review: review.defaultReviewState() };
    }
    this.emit();
    return true;
  }

  // ---------------------------------------------------------------- apply / undo / rollback

  /**
   * 应用（§5.3）：review → applying → done | error。
   *
   * 0. `settings.autoBackup` → `backup(tree)`，文件名记到 `job.backupFileName`；备份失败则回到 review，不碰书签
   * 1–8. `applySnapshot`：校验（变了的进 `job.skipped`）→ 建文件夹 → snapshot 以 'applying' 落盘 → 串行 move + journal
   *   - 全部成功 → `done`，`job.snapshotId`，`done / total` = 移动条数
   *   - 第 k 条失败 → 已回滚，`error` + 「写入失败，已回滚 N/M：原因」，`job.restore.reason === 'failure'`
   *   - `cancel()` → 已回滚，`error` + 「已取消，已回滚 N/M」，`job.restore.reason === 'cancel'`
   * 前置条件不满足（不在 review、没有可移动的条目）直接 reject，不改状态。
   */
  async apply(): Promise<void> {
    if (this.job.phase !== 'review' || !this.job.proposal) throw new Error('只能在预览阶段应用。');
    if (this.applying) throw new Error('正在应用中。');
    const moves = this.plannedMoves();
    if (moves.length === 0) throw new Error('没有需要移动的书签。');

    const token = ++this.runToken;
    this.stopRequested = false;
    // 标记必须在 runApply 同步 commit('applying') 并通知监听者之前就位：监听者里同步调用 cancel() 也要走停止分支
    let settle!: () => void;
    const marker = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.applying = marker;
    try {
      await this.runApply(token, this.settings(), moves);
    } finally {
      settle();
      if (this.applying === marker) this.applying = null;
    }
  }

  /**
   * 撤销最近一次整理：要求 phase 为 done、snapshot `status: 'applied'` 且 id 与本次 job 一致。
   * 结果记到 `job.restore`（phase 仍是 done；UI 据 snapshot 状态禁用撤销按钮）。
   */
  async undo(snapshot?: Snapshot): Promise<RestoreSummary> {
    if (this.job.phase !== 'done') throw new Error('当前没有可撤销的整理。');
    const current = snapshot ?? (await this.deps.loadSnapshot?.()) ?? null;
    if (!current) throw new Error('没有可撤销的 snapshot。');
    if (this.job.snapshotId !== undefined && current.id !== this.job.snapshotId) {
      throw new Error('snapshot 与本次整理不匹配（可能已在其他页面重新整理过）。');
    }
    const summary = await undoSnapshot(this.deps.bookmarksApi, current, (s) => this.deps.persistSnapshot(s));
    await this.commit({ restore: summary });
    return summary;
  }

  /**
   * 页面死在 apply 中途后的回滚（§5.3「中断保护」）：对 `status: 'applying'` 的 snapshot 恢复 `applied` 子集
   * （含 move 成功但 journal 未落盘的那一条），状态 → 'rolled-back'。不改 job（中断的 job 已在 restore 时丢弃）。
   */
  async rollbackInterrupted(snapshot: Snapshot): Promise<RestoreSummary> {
    if (this.job.phase === 'applying') throw new Error('正在应用中，不能回滚。');
    return rollbackInterruptedSnapshot(this.deps.bookmarksApi, snapshot, (s) => this.deps.persistSnapshot(s));
  }

  /** apply 失败 / 取消并回滚之后回到预览（proposal 仍在），可以改完再次应用。 */
  async backToReview(): Promise<void> {
    if (this.job.phase !== 'error' || !this.job.proposal) throw new Error('当前没有可返回的预览。');
    await this.commit({
      phase: 'review',
      error: undefined,
      restore: undefined,
      snapshotId: undefined,
      backupFileName: undefined,
      done: this.bookmarks.length,
      total: this.bookmarks.length,
      review: this.job.review ?? review.defaultReviewState(),
      skipped: this.job.skipped.filter((s) => s.reason === 'missing'),
    });
  }

  /** 清掉非 error 阶段附带的提示文案（例如备份失败后回到 review）；error 阶段请用 `reset()`。 */
  clearError(): void {
    if (this.job.phase === 'error' || this.job.error === undefined) return;
    this.job = { ...this.job, error: undefined };
    this.emit();
    void this.persist(this.job);
  }

  // ---------------------------------------------------------------- review edits

  /** 当前 review 状态解析出的移动计划（`applySnapshot` 的输入）。非 review 阶段返回 []。 */
  plannedMoves(): PlannedMove[] {
    const { proposal, review: state } = this.job;
    if (!proposal || !state) return [];
    const rootByFolder = new Map(this.existingFolders.map((f) => [f.id, f.rootId]));
    return resolveMoves({
      proposal,
      review: state,
      bookmarks: this.bookmarks,
      folderRoot: (id) => rootByFolder.get(id),
      origins: this.job.origins,
    });
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

  private async runApply(token: number, settings: Settings, moves: PlannedMove[]): Promise<void> {
    const api = this.deps.bookmarksApi;
    await this.commit(
      { phase: 'applying', done: 0, total: moves.length, error: undefined, snapshotId: undefined, backupFileName: undefined, restore: undefined },
      token,
    );

    // 第 0 步：备份。失败就不碰书签，回到 review
    if (settings.autoBackup && this.deps.backup) {
      let fileName: string;
      try {
        fileName = await this.deps.backup(await api.getTree());
      } catch (error) {
        await this.commit({ phase: 'review', error: `备份失败，未改动任何书签：${describeBookmarkError(error)}` }, token);
        return;
      }
      await this.commit({ backupFileName: fileName }, token);
    }
    if (this.stopRequested) {
      // 备份期间被取消：还没碰书签，直接回到 review
      await this.commit({ phase: 'review' }, token);
      return;
    }

    // 第 1–8 步
    let result: ApplyResult;
    try {
      result = await applySnapshot(api, moves, {
        persist: (snapshot) => this.deps.persistSnapshot(snapshot),
        now: this.deps.now,
        shouldStop: () => this.stopRequested,
        onProgress: (done, total) => this.progress(token, done, total),
      });
    } catch (error) {
      // applySnapshot 只会在 prepare 阶段抛（校验 / 建文件夹 / 首次落盘），此时没 move 任何书签、空文件夹已收回
      const untouched = error instanceof ApplySnapshotError && error.stage === 'prepare';
      const text = untouched ? '写入失败，未移动任何书签' : '写入过程中出错，书签状态未知，请检查书签管理器';
      await this.commit({ phase: 'error', error: `${text}：${describeBookmarkError(error)}` }, token);
      return;
    }

    const skipped = [...this.job.skipped, ...result.skipped];
    if (result.nothingToDo) {
      // 校验后一条都不用动：没有落盘 snapshot（上一份可撤销的 snapshot 原样保留），回到预览
      await this.commit({ phase: 'review', error: '没有可移动的书签，未改动任何书签', skipped }, token);
      return;
    }

    const counts = { done: result.snapshot.applied.length, total: result.snapshot.items.length };
    if (result.ok) {
      const live = await readBookmarkTree(api);
      const emptiedFolders = listEmptiedUserFolders(
        live,
        result.snapshot.items.map((item) => item.fromParentId),
        new Set(result.snapshot.createdFolderIds),
      );
      await this.commit({ phase: 'done', snapshotId: result.snapshot.id, skipped, emptiedFolders, ...counts }, token);
      return;
    }

    if (!result.rollback) {
      // 回滚本身也失败：snapshot 留在 'applying'，中断横幅（本页 / sidepanel）可以再次回滚
      const head = result.stopped ? '已取消，但回滚失败' : `写入失败：${describeBookmarkError(result.error)}；回滚也失败`;
      const error = `${head}（已移动的 ${counts.done}/${counts.total} 条仍在新位置）：${describeBookmarkError(result.rollbackError)}。可用「上次整理被中断」横幅重试回滚。`;
      await this.commit({ phase: 'error', error, snapshotId: result.snapshot.id, skipped, ...counts }, token);
      return;
    }

    const restore = summarizeRestore(result.rollback, result.stopped ? 'cancel' : 'failure');
    const ratio = `${restore.restored}/${restore.total}`;
    const error = result.stopped
      ? `已取消，已回滚 ${ratio}`
      : `写入失败，已回滚 ${ratio}：${describeBookmarkError(result.error)}`;
    await this.commit({ phase: 'error', error, snapshotId: result.snapshot.id, skipped, restore, ...counts }, token);
  }

  /** applying 阶段的进度（moves done / total）。 */
  private progress(token: number, done: number, total: number): void {
    if (token !== this.runToken) return;
    this.job = { ...this.job, done, total };
    this.emit();
    void this.persist(this.job);
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

function originsFrom(bookmarks: ReadonlyArray<Pick<FlatBookmark, 'id' | 'parentId' | 'rootId'>>): Record<string, BookmarkOrigin> {
  return Object.fromEntries(bookmarks.map((bookmark) => [bookmark.id, { parentId: bookmark.parentId, rootId: bookmark.rootId }]));
}
