import type { ChatFn } from '../../src/lib/ai/client';
import { ASSIGN_SYSTEM, PROPOSE_SYSTEM, REFINE_SYSTEM } from '../../src/lib/ai/prompts';
import type { BookmarksApi, BookmarkTreeNode } from '../../src/lib/bookmarks/api';
import { createFakeBookmarksApi, type FakeBookmarksApi, type SeedNode } from '../../src/lib/bookmarks/fake';
import { Organizer, type OrganizerDeps } from '../../src/lib/jobs/organizer';
import type { JobPhase, OrganizeJob, Settings, Snapshot } from '../../src/lib/types';

/**
 * organizer 测试共用：固定设置、一棵可预测的树、按 system prompt 分流的脚本化 chat、带记录器的 Organizer。
 * 不是测试文件（vitest 只收 `tests/**\/*.test.ts`）。
 */

export const API_KEY = 'sk-test-key-abcdef1234567890';

export const settings = (overrides: Partial<Settings> = {}): Settings => ({
  provider: { baseUrl: 'https://api.example.com/v1', apiKey: API_KEY, model: 'm' },
  scope: 'loose-other',
  includeFoldered: false,
  maxDepth: 2,
  batchSize: 10,
  concurrency: 2,
  requestTimeoutMs: 180_000,
  language: 'zh',
  domainOnly: false,
  autoBackup: true,
  seedCategories: ['生活'],
  userHint: '',
  ...overrides,
});

/** 「其他书签」下：10 github、10 淘宝、10 HN、miscCount 个杂项、1 对重复、1 个已有文件夹「工作」。 */
export function makeSeed(miscCount: number): SeedNode[] {
  const other: SeedNode[] = [];
  for (let i = 0; i < 10; i += 1) other.push({ id: `bm-gh-${i}`, title: `Repo ${i} by dev@example.com`, url: `https://github.com/org${i}/repo?tab=readme#readme` });
  for (let i = 0; i < 10; i += 1) other.push({ id: `bm-tb-${i}`, title: `淘宝商品 ${i}`, url: `https://item.taobao.com/item.htm?id=${i}` });
  for (let i = 0; i < 10; i += 1) other.push({ id: `bm-news-${i}`, title: `HN ${i}`, url: `https://news.ycombinator.com/item?id=${i}` });
  for (let i = 0; i < miscCount; i += 1) other.push({ id: `bm-misc-${i}`, title: `Misc ${i}`, url: `https://misc${i}.example.org/page/a/b/c/d#x` });
  other.push({ id: 'bm-dup-1', title: 'Dup A', url: 'https://github.com/dup/repo' });
  other.push({ id: 'bm-dup-2', title: 'Dup B', url: 'https://github.com/dup/repo/' });
  other.push({ id: 'other-work', title: '工作', children: [{ id: 'bm-in-work', title: 'inside', url: 'https://work.example.com/' }] });
  return [
    {
      id: '1',
      title: 'Bookmarks bar',
      folderType: 'bookmarks-bar',
      syncing: false,
      children: [{ id: 'bm-bar-1', title: 'bar loose', url: 'https://github.com/bar' }, { id: 'bar-work', title: '工作', children: [] }],
    },
    { id: '2', title: 'Other bookmarks', folderType: 'other', syncing: false, children: other },
  ];
}

export type Recorded = { system: string; user: string };
export type AssignPayload = { categories: Array<{ id: string; title: string; path: string[] }>; bookmarks: Array<{ i: number; title: string; url: string }> };

/** 按 system prompt 分流的脚本化 chat。 */
export function scriptedChat(
  record: Recorded[] = [],
  hooks: { onAssign?: (payload: AssignPayload, signal?: AbortSignal) => Promise<void> | void; failPropose?: unknown } = {},
): ChatFn {
  return (async (args: { system: string; user: string; signal?: AbortSignal }) => {
    record.push({ system: args.system, user: args.user });
    if (args.system === PROPOSE_SYSTEM) {
      if (hooks.failPropose !== undefined) throw hooks.failPropose;
      return {
        categories: [
          { id: 'a', title: '开发', existingFolderRef: 'f0' },
          { id: 'b', title: '购物' },
          { id: 'c', title: '资讯' },
          { id: 'd', title: '生活' },
        ],
      };
    }
    if (args.system === REFINE_SYSTEM) {
      return { categories: [{ id: 'r', title: '工具' }] };
    }
    if (args.system === ASSIGN_SYSTEM) {
      const payload = JSON.parse(args.user) as AssignPayload;
      await hooks.onAssign?.(payload, args.signal);
      const idOf = (title: string) => payload.categories.find((c) => c.title === title)?.id;
      return {
        items: payload.bookmarks.map((b) => {
          let categoryId: string | undefined;
          if (b.url.includes('github.com')) categoryId = idOf('开发');
          else if (b.url.includes('taobao.com')) categoryId = idOf('购物');
          else if (b.url.includes('ycombinator.com')) categoryId = idOf('资讯');
          else categoryId = idOf('工具');
          return categoryId ? { i: b.i, categoryId, confidence: 'high' } : { i: b.i, categoryId: 'uncategorized', confidence: 'low' };
        }),
      };
    }
    throw new Error(`unexpected system prompt: ${args.system.slice(0, 20)}`);
  }) as ChatFn;
}

export type HarnessOptions = {
  settings?: Settings;
  chat?: ChatFn;
  record?: Recorded[];
  /** 包一层 fake api（注入失败 / 门控）。 */
  wrapApi?: (api: FakeBookmarksApi) => BookmarksApi;
  /** 覆盖 backup 依赖；默认记录调用并返回 `backup-N.html`。传 null 表示不注入。 */
  backup?: OrganizerDeps['backup'] | null;
};

export type Harness = {
  api: FakeBookmarksApi;
  organizer: Organizer;
  persisted: Array<OrganizeJob | null>;
  /** 每次 persistSnapshot 收到的值（深拷贝）。 */
  snapshots: Array<Snapshot | null>;
  /** backup 依赖每次收到的树 + 当时 fake 的 move 次数。 */
  backups: Array<{ tree: BookmarkTreeNode[]; movesSoFar: number }>;
  phases: JobPhase[];
  record: Recorded[];
  /** 最新持久化的 snapshot（undo 用）。 */
  currentSnapshot: () => Snapshot | null;
};

export function harness(miscCount: number, options: HarnessOptions = {}): Harness {
  const api = createFakeBookmarksApi(makeSeed(miscCount));
  const persisted: Array<OrganizeJob | null> = [];
  const snapshots: Array<Snapshot | null> = [];
  const backups: Harness['backups'] = [];
  const phases: JobPhase[] = [];
  const record = options.record ?? [];
  let ids = 0;
  const currentSnapshot = () => snapshots[snapshots.length - 1] ?? null;
  const backup: OrganizerDeps['backup'] | undefined =
    options.backup === null
      ? undefined
      : options.backup ??
        (async (tree) => {
          backups.push({ tree, movesSoFar: api.calls.move });
          return `backup-${backups.length}.html`;
        });
  const organizer = new Organizer({
    bookmarksApi: options.wrapApi ? options.wrapApi(api) : api,
    chat: options.chat ?? scriptedChat(record),
    persistJob: async (job) => {
      persisted.push(job);
    },
    persistSnapshot: async (snapshot) => {
      snapshots.push(snapshot === null ? null : structuredClone(snapshot));
    },
    loadSnapshot: async () => currentSnapshot(),
    ...(backup ? { backup } : {}),
    settings: options.settings ?? settings(),
    now: () => 1_700_000_000_000,
    newId: () => `job-${++ids}`,
  });
  organizer.subscribe(({ job }) => {
    if (phases[phases.length - 1] !== job.phase) phases.push(job.phase);
  });
  return { api, organizer, persisted, snapshots, backups, phases, record, currentSnapshot };
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
