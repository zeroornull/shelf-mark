import { describe, expect, it } from 'vitest';
import type { ChatFn } from '../src/lib/ai/client';
import { PROPOSE_SYSTEM, REFINE_SYSTEM } from '../src/lib/ai/prompts';
import type { RawCategory } from '../src/lib/ai/schema';
import {
  buildFolderRefs,
  categoryPath,
  finalizeTaxonomy,
  indexCategories,
  leafCategoriesOf,
  proposeTaxonomy,
  refineTaxonomy,
  type ExistingFolder,
  type FinalizeContext,
} from '../src/lib/ai/taxonomy';
import type { Category } from '../src/lib/types';

const folders: ExistingFolder[] = [
  { id: 'real-work', title: '工作', path: ['工作'] },
  { id: 'real-fe', title: '前端', path: ['工作', '前端'] },
  { id: 'real-life', title: 'Life ', path: ['Life '] },
];

function ctx(overrides: Partial<FinalizeContext> = {}): FinalizeContext {
  return {
    existing: [],
    refs: buildFolderRefs(folders).byRef,
    existingFolders: folders,
    seedCategories: [],
    maxDepth: 2,
    ...overrides,
  };
}

describe('finalizeTaxonomy – renumbering and parentId rewrite', () => {
  it('renumbers categories to c1..cN in output order and rewrites parentId', () => {
    const raw: RawCategory[] = [
      { id: 'dev', title: '开发' },
      { id: 'x-9', title: '框架', parentId: 'dev' },
      { id: 'news', title: '资讯' },
      { id: 'ai', title: 'AI', parentId: 'news' },
    ];
    const { categories } = finalizeTaxonomy(raw, ctx());
    expect(categories).toEqual([
      { id: 'c1', title: '开发' },
      { id: 'c2', title: '框架', parentId: 'c1' },
      { id: 'c3', title: '资讯' },
      { id: 'c4', title: 'AI', parentId: 'c3' },
    ]);
  });

  it('drops parentIds that point nowhere or to itself', () => {
    const raw: RawCategory[] = [
      { id: 'a', title: 'A', parentId: 'ghost' },
      { id: 'b', title: 'B', parentId: 'b' },
      { id: 'c', title: 'C', parentId: 'a' },
    ];
    const { categories } = finalizeTaxonomy(raw, ctx());
    expect(categories).toEqual([
      { id: 'c1', title: 'A' },
      { id: 'c2', title: 'B' },
      { id: 'c3', title: 'C', parentId: 'c1' },
    ]);
  });

  it('drops empty titles and merges duplicate titles (redirecting parent references)', () => {
    const raw: RawCategory[] = [
      { id: 'a', title: '开发' },
      { id: 'a2', title: ' 开发 ' },
      { id: 'blank', title: '   ' },
      { id: 'child', title: '前端框架', parentId: 'a2' },
    ];
    const { categories } = finalizeTaxonomy(raw, ctx());
    expect(categories.map((c) => c.title)).toEqual(['开发', '前端框架']);
    expect(categories[1]?.parentId).toBe('c1');
  });
});

describe('finalizeTaxonomy – seeds', () => {
  it('appends missing seedCategories as top-level categories, skipping ones the model kept', () => {
    const raw: RawCategory[] = [{ id: 'a', title: '工作' }, { id: 'b', title: '娱乐' }];
    const { categories } = finalizeTaxonomy(raw, ctx({ seedCategories: ['工作', '生活', ' 生活', '', '学习'] }));
    expect(categories.map((c) => [c.id, c.title])).toEqual([
      ['c1', '工作'],
      ['c2', '娱乐'],
      ['c3', '生活'],
      ['c4', '学习'],
    ]);
    expect(categories.every((c) => c.parentId === undefined)).toBe(true);
  });

  it('forces a seed the model nested under something else back to the top level', () => {
    const raw: RawCategory[] = [{ id: 'a', title: '生活' }, { id: 'b', title: '工作', parentId: 'a' }];
    const { categories } = finalizeTaxonomy(raw, ctx({ seedCategories: ['工作'] }));
    expect(categories.find((c) => c.title === '工作')?.parentId).toBeUndefined();
  });
});

describe('finalizeTaxonomy – existing folders', () => {
  it('maps existingFolderRef f* to the real folder id (model never sees real ids)', () => {
    const { payload, byRef } = buildFolderRefs(folders);
    expect(payload).toEqual([
      { ref: 'f0', path: ['工作'] },
      { ref: 'f1', path: ['工作', '前端'] },
      { ref: 'f2', path: ['Life '] },
    ]);
    expect(JSON.stringify(payload)).not.toContain('real-');

    const raw: RawCategory[] = [
      { id: 'a', title: '办公', existingFolderRef: 'f0' },
      { id: 'b', title: '前端开发', existingFolderRef: 'f1', parentId: 'a' },
      { id: 'c', title: '其它', existingFolderRef: 'f99' },
    ];
    const { categories } = finalizeTaxonomy(raw, ctx({ refs: byRef }));
    expect(categories).toEqual([
      { id: 'c1', title: '办公', existingFolderId: 'real-work' },
      { id: 'c2', title: '前端开发', parentId: 'c1', existingFolderId: 'real-fe' },
      { id: 'c3', title: '其它' },
    ]);
  });

  it('auto-fills existingFolderId when a normalized title equals an existing folder title', () => {
    const raw: RawCategory[] = [{ id: 'a', title: 'life' }, { id: 'b', title: '前端' }, { id: 'c', title: '购物' }];
    const { categories } = finalizeTaxonomy(raw, ctx());
    expect(categories.map((c) => c.existingFolderId)).toEqual(['real-life', 'real-fe', undefined]);
  });

  it('also auto-fills for backfilled seeds', () => {
    const raw: RawCategory[] = [{ id: 'a', title: 'A' }];
    const { categories } = finalizeTaxonomy(raw, ctx({ seedCategories: ['工作'] }));
    expect(categories[1]).toEqual({ id: 'c2', title: '工作', existingFolderId: 'real-work' });
  });
});

describe('finalizeTaxonomy – maxDepth and leaves', () => {
  it('maxDepth=1 flattens everything and makes every category assignable', () => {
    const raw: RawCategory[] = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B', parentId: 'a' }];
    const { categories, leafCategories } = finalizeTaxonomy(raw, ctx({ maxDepth: 1 }));
    expect(categories.every((c) => c.parentId === undefined)).toBe(true);
    expect(leafCategories.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('maxDepth=2: only leaves are assignable; deeper chains are re-parented to the top ancestor; cycles are broken', () => {
    const raw: RawCategory[] = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B', parentId: 'a' },
      { id: 'c', title: 'C', parentId: 'b' }, // depth 3 → under A
      { id: 'x', title: 'X', parentId: 'y' },
      { id: 'y', title: 'Y', parentId: 'x' }, // cycle
      { id: 'z', title: 'Z' },
    ];
    const { categories, leafCategories } = finalizeTaxonomy(raw, ctx());
    const byId = indexCategories(categories);
    expect(byId.get('c3')?.parentId).toBe('c1');
    expect(byId.get('c2')?.parentId).toBe('c1');
    const x = byId.get('c4')!;
    const y = byId.get('c5')!;
    expect([x.parentId, y.parentId].filter((p) => p !== undefined)).toHaveLength(1);
    expect(leafCategories.map((c) => c.id)).toEqual(expect.arrayContaining(['c2', 'c3', 'c6']));
    expect(leafCategories.map((c) => c.id)).not.toContain('c1');
    expect(leafCategoriesOf(categories)).toEqual(leafCategories);
    expect(categoryPath(byId.get('c3')!, byId)).toEqual(['A', 'C']);
    expect(categoryPath(byId.get('c1')!, byId)).toEqual(['A']);
  });
});

describe('finalizeTaxonomy – refine numbering', () => {
  const existing: Category[] = [
    { id: 'c1', title: '开发' },
    { id: 'c2', title: '前端', parentId: 'c1', existingFolderId: 'real-fe' },
    { id: 'c3', title: '资讯' },
  ];

  it('continues numbering from cN+1, may reference existing c* as parent, caps at maxNew and skips duplicates of existing titles', () => {
    const raw: RawCategory[] = [
      { id: 'n1', title: '后端', parentId: 'c1' },
      { id: 'n2', title: '资讯' }, // 与已有重复 → 丢弃
      { id: 'n3', title: '数据库', parentId: 'n1' }, // 深度 3 → 挂到 c1
      { id: 'n4', title: '设计' },
      { id: 'n5', title: '视频' },
      { id: 'n6', title: '购物' },
      { id: 'n7', title: '游戏' },
      { id: 'n8', title: '多余的' },
      { id: 'n9', title: '更多余的' },
    ];
    const { categories, added, leafCategories } = finalizeTaxonomy(raw, ctx({ existing, maxNew: 6 }));

    expect(categories.slice(0, 3)).toEqual(existing);
    expect(added.map((c) => [c.id, c.title, c.parentId])).toEqual([
      ['c4', '后端', 'c1'],
      ['c5', '数据库', 'c1'],
      ['c6', '设计', undefined],
      ['c7', '视频', undefined],
      ['c8', '购物', undefined],
      ['c9', '游戏', undefined],
    ]);
    expect(leafCategories.map((c) => c.id)).not.toContain('c1');
    expect(leafCategories.map((c) => c.id)).toEqual(expect.arrayContaining(['c2', 'c3', 'c4', 'c5']));
  });

  it('does not mutate the caller’s existing categories', () => {
    const snapshot = structuredClone(existing);
    finalizeTaxonomy([{ id: 'n', title: 'New', parentId: 'c2' }], ctx({ existing }));
    expect(existing).toEqual(snapshot);
  });

  it('handles non-numeric existing ids by starting from c1', () => {
    const { added } = finalizeTaxonomy([{ id: 'n', title: 'New' }], ctx({ existing: [{ id: 'legacy', title: 'L' }] }));
    expect(added[0]?.id).toBe('c1');
  });
});

describe('proposeTaxonomy / refineTaxonomy with an injected chat', () => {
  const bookmarks = [
    { title: 'Vue 文档', url: 'https://vuejs.org/guide/?x=1#intro' },
    { title: 'GitHub', url: 'https://github.com/vuejs/core' },
    { title: '淘宝 my@mail.com', url: 'https://taobao.com/item?id=1' },
  ];

  it('sends the §6.3 payload shape without real ids and post-processes the answer', async () => {
    const seen: Array<{ system: string; user: string }> = [];
    const chat: ChatFn = async (args) => {
      seen.push({ system: args.system, user: args.user });
      return {
        categories: [
          { id: 'k1', title: '前端', existingFolderRef: 'f1' },
          { id: 'k2', title: '购物' },
          { id: 'k3', title: '开源', parentId: 'k1' },
          { id: 'k4', title: '资讯' },
        ],
      } as never;
    };

    const result = await proposeTaxonomy(
      { bookmarks, existingFolders: folders, seedCategories: ['生活'], userHint: ' 不要按语言分 ', maxDepth: 2, language: 'zh' },
      { chat },
    );

    expect(seen[0]?.system).toBe(PROPOSE_SYSTEM);
    const payload = JSON.parse(seen[0]!.user) as Record<string, unknown>;
    expect(payload).toMatchObject({
      seedCategories: ['生活'],
      userHint: '不要按语言分',
      existingFolders: [
        { ref: 'f0', path: ['工作'] },
        { ref: 'f1', path: ['工作', '前端'] },
        { ref: 'f2', path: ['Life '] },
      ],
      totalBookmarks: 3,
      maxDepth: 2,
      language: 'zh',
    });
    expect(Array.isArray(payload.domains)).toBe(true);
    expect(seen[0]!.user).not.toContain('real-');
    expect(seen[0]!.user).not.toContain('?x=1');
    expect(seen[0]!.user).not.toContain('#intro');
    expect(seen[0]!.user).not.toContain('my@mail.com');
    expect(seen[0]!.user).toContain('[email]');

    expect(result.categories).toEqual([
      { id: 'c1', title: '前端', existingFolderId: 'real-fe' },
      { id: 'c2', title: '购物' },
      { id: 'c3', title: '开源', parentId: 'c1' },
      { id: 'c4', title: '资讯' },
      { id: 'c5', title: '生活' },
    ]);
    expect(result.leafCategories.map((c) => c.id)).toEqual(['c2', 'c3', 'c4', 'c5']);
  });

  it('refine sends existing categories and continues numbering', async () => {
    const seen: Array<{ system: string; user: string }> = [];
    const chat: ChatFn = async (args) => {
      seen.push({ system: args.system, user: args.user });
      return { categories: [{ id: 'r1', title: '论文', parentId: 'c1' }, { id: 'r2', title: '前端' }] } as never;
    };
    const existing: Category[] = [{ id: 'c1', title: '学习' }, { id: 'c2', title: '前端' }];
    const result = await refineTaxonomy(
      { bookmarks, existingFolders: folders, seedCategories: [], userHint: '', maxDepth: 2, language: 'en', categories: existing },
      { chat },
    );

    expect(seen[0]?.system).toBe(REFINE_SYSTEM);
    const payload = JSON.parse(seen[0]!.user) as Record<string, unknown>;
    expect(payload.existingCategories).toEqual([{ id: 'c1', title: '学习' }, { id: 'c2', title: '前端' }]);
    expect(payload.uncategorizedCount).toBe(3);
    expect(result.added).toEqual([{ id: 'c3', title: '论文', parentId: 'c1' }]);
    expect(result.categories).toHaveLength(3);
    expect(result.leafCategories.map((c) => c.id)).toEqual(['c2', 'c3']);
  });
});
