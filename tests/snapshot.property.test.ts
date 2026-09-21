import { describe, expect, it } from 'vitest';
import type { BookmarksApi } from '../src/lib/bookmarks/api';
import { createFakeBookmarksApi, type DumpNode, type SeedNode } from '../src/lib/bookmarks/fake';
import { ensureFolder, normalizeTitle } from '../src/lib/bookmarks/mutate';
import { applySnapshot, restoreSnapshot, type PlannedMove } from '../src/lib/bookmarks/snapshot';
import type { Snapshot } from '../src/lib/types';

// ---------------------------------------------------------------------------
// 带种子的 PRNG（mulberry32）。失败时断言消息里带 seed，可复现。
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;

  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }

  /** [min, max] 闭区间整数。 */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick() from empty list');
    return items[this.int(0, items.length - 1)]!;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// 随机树：2 个根（bookmarks-bar + other），若干命名文件夹（部分嵌套）+ 若干散装书签。
// ---------------------------------------------------------------------------

type GenFolder = { id: string; parentId: string; rootId: string; title: string; depth: number };
type GenBookmark = { id: string; parentId: string; rootId: string };
type GenTree = {
  seed: SeedNode[];
  roots: Array<{ id: string; folderType: 'bookmarks-bar' | 'other' }>;
  folders: GenFolder[];
  bookmarks: GenBookmark[];
};

const FOLDER_WORDS = ['工作', '前端', '生活', '阅读', 'Dev', 'News', 'ＡＩ', 'Design'];

function genTree(rng: Rng): GenTree {
  let nextId = 100;
  const newId = () => String(nextId++);
  const folders: GenFolder[] = [];
  const bookmarks: GenBookmark[] = [];
  let folderCounter = 0;

  const genBookmark = (parentId: string, rootId: string): SeedNode => {
    const id = newId();
    bookmarks.push({ id, parentId, rootId });
    return { id, title: `b${id}`, url: `https://example.com/${id}` };
  };

  const genFolder = (parentId: string, rootId: string, depth: number): SeedNode => {
    const id = newId();
    let title = `${rng.pick(FOLDER_WORDS)} ${++folderCounter}`;
    if (rng.chance(0.15)) title = ` ${title} `; // 带空白的标题，normalize 必须能对上
    folders.push({ id, parentId, rootId, title, depth });
    const children: SeedNode[] = [];
    const count = rng.int(0, 4);
    for (let i = 0; i < count; i++) {
      children.push(depth < 1 && rng.chance(0.3) ? genFolder(id, rootId, depth + 1) : genBookmark(id, rootId));
    }
    return { id, title, children };
  };

  const roots: GenTree['roots'] = [
    { id: '1', folderType: 'bookmarks-bar' },
    { id: '2', folderType: 'other' },
  ];
  const seed: SeedNode[] = roots.map((root) => {
    const children: SeedNode[] = [];
    const count = rng.int(2, 9);
    for (let i = 0; i < count; i++) {
      children.push(rng.chance(0.35) ? genFolder(root.id, root.id, 0) : genBookmark(root.id, root.id));
    }
    return {
      id: root.id,
      title: root.folderType === 'bookmarks-bar' ? 'Bookmarks bar' : 'Other bookmarks',
      folderType: root.folderType,
      syncing: false,
      children,
    };
  });
  if (bookmarks.length === 0) seed[1]!.children!.push(genBookmark('2', '2'));

  return { seed, roots, folders, bookmarks };
}

// ---------------------------------------------------------------------------
// 随机 move 集：目标混合「已有文件夹 id」「全新路径」「已有文件夹下的新子文件夹」。
// 生成器保证每条都有效（书签不重复、目标 ≠ 当前 parent、不跨根），因此 items.length === moves.length。
// ---------------------------------------------------------------------------

const NEW_NAMES = ['New A', 'New B', 'New C'];

function genMoves(rng: Rng, tree: GenTree, options: { forceNewFolder?: boolean } = {}): PlannedMove[] {
  const count = rng.int(1, Math.min(12, tree.bookmarks.length));
  const chosen = rng.shuffle(tree.bookmarks).slice(0, count);
  const names = NEW_NAMES.slice(0, rng.int(1, NEW_NAMES.length));
  // 大小写 / 空白变体：normalize 后同名，ensureFolder 必须复用同一个文件夹
  const variant = (name: string) => (rng.chance(0.3) ? ` ${name.toUpperCase()} ` : name);
  const newPath = (): string[] =>
    rng.chance(0.3) ? [variant(rng.pick(names)), variant(rng.pick(names))] : [variant(rng.pick(names))];

  const moves: PlannedMove[] = chosen.map((bookmark) => {
    const base = { bookmarkId: bookmark.id, expectedParentId: bookmark.parentId };
    const rootFolders = tree.folders.filter((f) => f.rootId === bookmark.rootId);
    const existing = rootFolders.filter((f) => f.id !== bookmark.parentId);
    const topLevel = rootFolders.filter((f) => f.depth === 0);
    const roll = rng.int(1, 100);

    if (roll <= 40 && existing.length > 0) return { ...base, toParentId: rng.pick(existing).id };
    if (roll <= 80 || topLevel.length === 0) return { ...base, toPath: newPath() };
    return { ...base, toPath: [rng.pick(topLevel).title, variant(rng.pick(names))] };
  });

  if (options.forceNewFolder && !moves.some((m) => 'toPath' in m)) {
    const first = moves[0]!;
    moves[0] = { bookmarkId: first.bookmarkId, expectedParentId: first.expectedParentId, toPath: newPath() };
  }
  return moves;
}

function prune(nodes: DumpNode[], ids: ReadonlySet<string>): DumpNode[] {
  return nodes
    .filter((node) => !ids.has(node.id))
    .map((node) => (node.children ? { ...node, children: prune(node.children, ids) } : node));
}

const SEEDS = 200;

// ---------------------------------------------------------------------------
// 性质
// ---------------------------------------------------------------------------

describe('snapshot properties (200 seeds each)', () => {
  it('(a) apply → restore(undone) yields a tree deep-equal to the original', async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rng = new Rng(seed);
      const gen = genTree(rng);
      const fake = createFakeBookmarksApi(gen.seed);
      const original = fake.dump();
      const moves = genMoves(rng, gen);
      const msg = `seed=${seed}`;
      const journal: Snapshot[] = [];
      const persist = async (s: Snapshot) => {
        journal.push(s);
      };

      const result = await applySnapshot(fake, moves, { persist, now: () => 1 });
      expect(result.ok, msg).toBe(true);
      expect(result.skipped, msg).toEqual([]);
      expect(result.snapshot.status, msg).toBe('applied');
      expect(result.snapshot.items, msg).toHaveLength(moves.length);
      expect(result.snapshot.applied, msg).toEqual(result.snapshot.items.map((i) => i.bookmarkId));

      // 应用后每条书签都在目标文件夹里
      for (const item of result.snapshot.items) {
        expect(fake.getNode(item.bookmarkId)?.parentId, `${msg} bookmark=${item.bookmarkId}`).toBe(item.toParentId);
      }

      // journal：先 'applying' 且 applied 为空，之后每条 move 落盘一次，最后 'applied'
      expect(journal[0], msg).toMatchObject({ status: 'applying', applied: [] });
      expect(journal, msg).toHaveLength(moves.length + 2);
      journal.slice(1, -1).forEach((entry, i) => expect(entry.applied, `${msg} journal#${i + 1}`).toHaveLength(i + 1));
      expect(journal.at(-1)?.status, msg).toBe('applied');

      const restore = await restoreSnapshot(fake, result.snapshot, 'undone', persist);
      expect(restore.snapshot.status, msg).toBe('undone');
      expect(restore, msg).toMatchObject({
        total: moves.length,
        restored: moves.length,
        skipped: 0,
        relocated: 0,
        failed: 0,
        keptFolders: [],
      });
      expect(new Set(restore.removedFolders), msg).toEqual(new Set(result.snapshot.createdFolderIds));
      expect(journal.at(-1)?.status, msg).toBe('undone');

      expect(fake.dump(), msg).toEqual(original);
    }
  });

  it('(b) a throwing k-th move rolls back to the original tree with status rolled-back', async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rng = new Rng(seed);
      const gen = genTree(rng);
      const fake = createFakeBookmarksApi(gen.seed);
      const original = fake.dump();
      const moves = genMoves(rng, gen);
      const k = rng.int(1, moves.length);
      const msg = `seed=${seed} k=${k}`;
      const journal: Snapshot[] = [];
      const persist = async (s: Snapshot) => {
        journal.push(s);
      };

      let calls = 0;
      const failing: BookmarksApi = {
        getTree: () => fake.getTree(),
        create: (details) => fake.create(details),
        remove: (id) => fake.remove(id),
        move: (id, dest) => {
          calls += 1;
          if (calls === k) return Promise.reject(new Error(`injected failure at move #${k}`));
          return fake.move(id, dest);
        },
      };

      const result = await applySnapshot(failing, moves, { persist });
      expect(result.ok, msg).toBe(false);
      expect(String(result.error), msg).toContain('injected failure');
      expect(result.snapshot.status, msg).toBe('rolled-back');
      expect(result.snapshot.applied, msg).toHaveLength(k - 1);
      expect(result.rollback, msg).toMatchObject({
        total: k - 1,
        restored: k - 1,
        skipped: 0,
        relocated: 0,
        failed: 0,
        keptFolders: [],
      });
      expect(journal[0], msg).toMatchObject({ status: 'applying', applied: [] });
      expect(journal.at(-1)?.status, msg).toBe('rolled-back');

      expect(fake.dump(), msg).toEqual(original);
    }
  });

  it('(c) a bookmark the user adds to a new folder survives undo; everything else is restored', async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rng = new Rng(seed);
      const gen = genTree(rng);
      const fake = createFakeBookmarksApi(gen.seed);
      const original = fake.dump();
      const moves = genMoves(rng, gen, { forceNewFolder: true });
      const msg = `seed=${seed}`;
      const persist = async () => {};

      const result = await applySnapshot(fake, moves, { persist });
      expect(result.ok, msg).toBe(true);
      const created = result.snapshot.createdFolderIds;
      expect(created.length, msg).toBeGreaterThan(0);

      // 挑一个没有新建子文件夹的新文件夹（叶子），用户往里加一条书签
      const leaf = created.find((id) => !created.some((other) => fake.getNode(other)?.parentId === id))!;
      const added = await fake.create({ parentId: leaf, title: 'user added', url: 'https://user.example/added' });

      const restore = await restoreSnapshot(fake, result.snapshot, 'undone', persist);
      expect(restore.snapshot.status, msg).toBe('undone');
      expect(restore, msg).toMatchObject({ total: moves.length, restored: moves.length, skipped: 0, relocated: 0, failed: 0 });

      // 叶子文件夹保留，且只剩用户加的那条
      expect(fake.getChildrenIds(leaf), msg).toEqual([added.id]);

      // 它的新建祖先也都保留（非空），其余新建文件夹全部删除
      const chain: string[] = [];
      let current = fake.getNode(leaf);
      while (current && created.includes(current.id)) {
        chain.push(current.id);
        current = current.parentId !== undefined ? fake.getNode(current.parentId) : undefined;
      }
      expect(new Set(restore.keptFolders), msg).toEqual(new Set(chain));
      expect(restore.removedFolders.length + restore.keptFolders.length, msg).toBe(created.length);

      // 去掉新建文件夹后，其余结构与原树完全一致
      expect(prune(fake.dump(), new Set(created)), msg).toEqual(original);
    }
  });

  it('(d) siblings deleted by the user after apply: undo still puts every moved bookmark back (index clamped), nothing fails', async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rng = new Rng(seed);
      const gen = genTree(rng);
      const fake = createFakeBookmarksApi(gen.seed);
      const moves = genMoves(rng, gen);
      const msg = `seed=${seed}`;
      const persist = async () => {};

      const result = await applySnapshot(fake, moves, { persist });
      expect(result.ok, msg).toBe(true);

      // 用户删掉若干没被移动的书签（让 fromIndex 有机会超过当前 children.length）
      const moved = new Set(result.snapshot.items.map((i) => i.bookmarkId));
      const untouched = gen.bookmarks.filter((b) => !moved.has(b.id));
      const deleted = rng.shuffle(untouched).slice(0, rng.int(0, Math.min(3, untouched.length)));
      for (const b of deleted) await fake.remove(b.id);
      const deletedIds = new Set(deleted.map((b) => b.id));

      const restore = await restoreSnapshot(fake, result.snapshot, 'undone', persist);
      expect(restore, msg).toMatchObject({ total: moves.length, restored: moves.length, skipped: 0, relocated: 0, failed: 0, keptFolders: [] });

      // 每条都回到原文件夹；新建文件夹全部删除；其余节点 (id → parentId) 与原树一致（只少了用户删掉的）
      for (const item of result.snapshot.items) {
        expect(fake.getNode(item.bookmarkId)?.parentId, `${msg} bookmark=${item.bookmarkId}`).toBe(item.fromParentId);
      }
      for (const id of result.snapshot.createdFolderIds) expect(fake.getNode(id), `${msg} folder=${id}`).toBeUndefined();

      const parentMap = (nodes: DumpNode[], out = new Map<string, string>()): Map<string, string> => {
        for (const node of nodes) {
          out.set(node.id, node.parentId);
          if (node.children) parentMap(node.children, out);
        }
        return out;
      };
      const expected = parentMap(prune(createFakeBookmarksApi(gen.seed).dump(), deletedIds));
      expect(parentMap(fake.dump()), msg).toEqual(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// §5.3 升序理由 + ensureFolder normalize
// ---------------------------------------------------------------------------

describe('restore order rationale (§5.3)', () => {
  const seed: SeedNode[] = [
    { id: '1', title: 'Bookmarks bar', folderType: 'bookmarks-bar', syncing: false, children: [] },
    {
      id: '2',
      title: 'Other bookmarks',
      folderType: 'other',
      syncing: false,
      children: ['b0', 'b1', 'b2', 'b3'].map((id) => ({ id, title: id, url: `https://x/${id}` })),
    },
  ];

  it('[b0,b1,b2,b3] → all into new F → [F]; ascending undo yields [b0,b1,b2,b3] and removes F', async () => {
    const fake = createFakeBookmarksApi(seed);
    const persist = async () => {};
    const moves: PlannedMove[] = ['b0', 'b1', 'b2', 'b3'].map((id) => ({ bookmarkId: id, toPath: ['F'] }));

    const result = await applySnapshot(fake, moves, { persist });
    expect(result.ok).toBe(true);
    const [folderId] = result.snapshot.createdFolderIds;
    expect(folderId).toBeDefined();
    expect(fake.getChildrenIds('2')).toEqual([folderId]);
    expect(fake.getChildrenIds(folderId!)).toEqual(['b0', 'b1', 'b2', 'b3']);
    expect(result.snapshot.items.map((i) => i.fromIndex)).toEqual([0, 1, 2, 3]);

    const restore = await restoreSnapshot(fake, result.snapshot, 'undone', persist);
    expect(restore.restored).toBe(4);
    expect(fake.getChildrenIds('2')).toEqual(['b0', 'b1', 'b2', 'b3']);
    expect(fake.getNode(folderId!)).toBeUndefined();
  });

  it('descending would throw: moving b3 back to index 3 while the folder only holds [F]', async () => {
    const fake = createFakeBookmarksApi(seed);
    const result = await applySnapshot(
      fake,
      ['b0', 'b1', 'b2', 'b3'].map((id) => ({ bookmarkId: id, toPath: ['F'] })),
      { persist: async () => {} },
    );
    expect(result.ok).toBe(true);
    expect(fake.getChildrenIds('2')).toHaveLength(1);

    await expect(fake.move('b3', { parentId: '2', index: 3 })).rejects.toThrow(/out of bounds/i);
    // 升序 + clamp 则没问题
    await expect(fake.move('b0', { parentId: '2', index: Math.min(0, 1) })).resolves.toBeDefined();
  });

  it('clamps fromIndex to children.length when the user deleted siblings between apply and undo', async () => {
    const fake = createFakeBookmarksApi(seed);
    const persist = async () => {};
    const result = await applySnapshot(
      fake,
      [
        { bookmarkId: 'b2', toPath: ['F'] },
        { bookmarkId: 'b3', toPath: ['F'] },
      ],
      { persist },
    );
    expect(result.ok).toBe(true);
    const [folderId] = result.snapshot.createdFolderIds;
    expect(fake.getChildrenIds('2')).toEqual(['b0', 'b1', folderId]);

    // 用户删掉 b0、b1 → other 只剩 [F]，b2 / b3 的 fromIndex（2、3）都超过 children.length
    await fake.remove('b0');
    await fake.remove('b1');

    const restore = await restoreSnapshot(fake, result.snapshot, 'undone', persist);
    expect(restore).toMatchObject({ total: 2, restored: 2, failed: 0, skipped: 0 });
    expect(fake.getChildrenIds('2')).toEqual(['b2', 'b3']);
    expect(fake.getNode(folderId!)).toBeUndefined();
  });

  it('restores into a folder that also received bookmarks, keeping original order', async () => {
    // F 原本 [x, b]；apply：b → G（新建），y（散装）→ F。undo 后 F 必须回到 [x, b]，y 回到根。
    const fake = createFakeBookmarksApi([
      { id: '1', title: 'bar', folderType: 'bookmarks-bar', syncing: false, children: [] },
      {
        id: '2',
        title: 'other',
        folderType: 'other',
        syncing: false,
        children: [
          { id: 'y', title: 'y', url: 'https://y' },
          { id: 'F', title: 'F', children: [{ id: 'x', title: 'x', url: 'https://x' }, { id: 'b', title: 'b', url: 'https://b' }] },
        ],
      },
    ]);
    const original = fake.dump();
    const persist = async () => {};
    const result = await applySnapshot(
      fake,
      [
        { bookmarkId: 'b', toPath: ['G'] },
        { bookmarkId: 'y', toParentId: 'F' },
      ],
      { persist },
    );
    expect(result.ok).toBe(true);
    expect(fake.getChildrenIds('F')).toEqual(['x', 'y']);

    await restoreSnapshot(fake, result.snapshot, 'undone', persist);
    expect(fake.getChildrenIds('F')).toEqual(['x', 'b']);
    expect(fake.dump()).toEqual(original);
  });
});

describe('ensureFolder normalization', () => {
  const seed: SeedNode[] = [
    { id: '1', title: 'Bookmarks bar', folderType: 'bookmarks-bar', syncing: false, children: [] },
    { id: '2', title: 'Other bookmarks', folderType: 'other', syncing: false, children: [{ id: 'fe', title: '前端', children: [] }] },
  ];

  it('normalizeTitle applies NFKC, trim and case folding', () => {
    expect(normalizeTitle(' 前端 ')).toBe('前端');
    expect(normalizeTitle('\u3000前端\u3000')).toBe('前端');
    expect(normalizeTitle('Ｒｅａｃｔ')).toBe('react');
    expect(normalizeTitle('REACT')).toBe('react');
    expect(normalizeTitle('①')).toBe('1');
  });

  it('reuses the existing 前端 folder for whitespace / NFKC variants instead of creating 前端 (1)', async () => {
    const fake = createFakeBookmarksApi(seed);
    for (const variant of ['前端', ' 前端 ', '\u3000前端', '前端\u3000 ']) {
      const result = await ensureFolder(fake, '2', variant);
      expect(result, variant).toEqual({ id: 'fe', created: false });
    }
    expect(fake.getChildrenIds('2')).toEqual(['fe']);
    expect(fake.calls.create).toBe(0);
  });

  it('creates once (appended, trimmed title) and then reuses across case / fullwidth variants', async () => {
    const fake = createFakeBookmarksApi(seed);
    const first = await ensureFolder(fake, '2', '  React ');
    expect(first.created).toBe(true);
    expect(fake.getChildrenIds('2')).toEqual(['fe', first.id]);
    expect(fake.getNode(first.id)?.title).toBe('React');

    for (const variant of ['react', 'REACT', 'Ｒｅａｃｔ', ' rEaCt ']) {
      expect(await ensureFolder(fake, '2', variant), variant).toEqual({ id: first.id, created: false });
    }
    expect(fake.calls.create).toBe(1);
    expect(fake.getChildrenIds('2')).toEqual(['fe', first.id]);
  });

  it('rejects empty titles and non-folder parents', async () => {
    const fake = createFakeBookmarksApi(seed);
    await expect(ensureFolder(fake, '2', '   ')).rejects.toThrow(/empty/);
    await expect(ensureFolder(fake, 'nope', 'x')).rejects.toThrow(/does not exist/);
  });
});
