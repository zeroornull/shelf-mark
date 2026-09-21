import { describe, expect, it } from 'vitest';
import type { BookmarkTreeNode } from '../src/lib/bookmarks/api';
import { backupFileName, escapeHtml, renderNetscapeHtml } from '../src/lib/bookmarks/backup';
import { createFakeBookmarksApi } from '../src/lib/bookmarks/fake';

const T0 = 1_700_000_000_000; // 2023-11-14T22:13:20Z

/** 直接构造 getTree() 形状：[不可见树根 → 书签栏 / 其他书签 / 移动书签 / managed]。 */
function rawTree(): BookmarkTreeNode[] {
  return [
    {
      id: '0',
      title: '',
      children: [
        {
          id: '1',
          parentId: '0',
          index: 0,
          title: 'Bookmarks bar',
          folderType: 'bookmarks-bar',
          syncing: false,
          dateAdded: T0,
          dateGroupModified: T0 + 5_000,
          children: [
            { id: 'b1', parentId: '1', index: 0, title: 'Tom & "Jerry" <b>', url: 'https://x.example/?a=1&b=<2>&c="3"', dateAdded: T0 + 1_000 },
            {
              id: 'f1',
              parentId: '1',
              index: 1,
              title: 'Work',
              dateAdded: T0 + 2_000,
              children: [
                { id: 'b2', parentId: 'f1', index: 0, title: 'Second', url: 'https://second.example/', dateAdded: T0 + 3_000 },
                {
                  id: 'f2',
                  parentId: 'f1',
                  index: 1,
                  title: 'Nested',
                  children: [{ id: 'b3', parentId: 'f2', index: 0, title: 'Third', url: 'https://third.example/', dateAdded: T0 + 4_000 }],
                },
                { id: 'b4', parentId: 'f1', index: 2, title: 'Fourth', url: 'https://fourth.example/', dateAdded: T0 + 5_000 },
              ],
            },
          ],
        },
        {
          id: '2',
          parentId: '0',
          index: 1,
          title: 'Other bookmarks',
          folderType: 'other',
          syncing: false,
          dateAdded: T0,
          children: [
            { id: 'o1', parentId: '2', index: 0, title: 'Loose other', url: 'https://other.example/', dateAdded: T0 + 6_000 },
            { id: 'of', parentId: '2', index: 1, title: '生活', dateAdded: T0 + 7_000, children: [] },
          ],
        },
        {
          id: '3',
          parentId: '0',
          index: 2,
          title: 'Mobile bookmarks',
          folderType: 'mobile',
          syncing: false,
          dateAdded: T0,
          children: [{ id: 'm1', parentId: '3', index: 0, title: 'Phone', url: 'https://phone.example/', dateAdded: T0 + 8_000 }],
        },
        {
          id: '4',
          parentId: '0',
          index: 3,
          title: 'Managed bookmarks',
          folderType: 'managed',
          unmodifiable: 'managed',
          children: [{ id: 'mg1', parentId: '4', index: 0, title: 'Policy', url: 'https://policy.example/', unmodifiable: 'managed' }],
        },
      ],
    },
  ];
}

describe('renderNetscapeHtml', () => {
  const html = renderNetscapeHtml(rawTree(), T0);
  const lines = html.split('\n');

  it('starts with the Netscape doctype, meta, title and H1, and wraps everything in one root <DL><p>', () => {
    expect(lines[0]).toBe('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    expect(html).toContain('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">');
    expect(html).toContain('<TITLE>Bookmarks</TITLE>');
    expect(html).toContain('<H1>Bookmarks</H1>');
    expect(lines.filter((l) => l === '<DL><p>')).toHaveLength(1);
    expect(lines.filter((l) => l === '</DL><p>')).toHaveLength(1);
    expect(html.endsWith('</DL><p>\n')).toBe(true);
    // 每个 <DL><p> 都有配对的 </DL><p>
    expect(html.match(/<DL><p>/g)).toHaveLength(html.match(/<\/DL><p>/g)!.length);
  });

  it('marks the bookmarks-bar root with PERSONAL_TOOLBAR_FOLDER, inlines "other" children at the top level, keeps mobile as a plain folder', () => {
    const toolbar = lines.find((l) => l.includes('PERSONAL_TOOLBAR_FOLDER="true"'))!;
    expect(toolbar).toBe(`    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000005" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>`);
    expect(html.match(/PERSONAL_TOOLBAR_FOLDER/g)).toHaveLength(1);

    // 「其他书签」本身不出现为文件夹，它的子节点直接在最外层（缩进 1 级）
    expect(html).not.toContain('>Other bookmarks</H3>');
    expect(lines).toContain('    <DT><A HREF="https://other.example/" ADD_DATE="1700000006">Loose other</A>');
    expect(lines).toContain('    <DT><H3 ADD_DATE="1700000007" LAST_MODIFIED="1700000007">生活</H3>');

    expect(lines).toContain('    <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000000">Mobile bookmarks</H3>');
    expect(lines).toContain('        <DT><A HREF="https://phone.example/" ADD_DATE="1700000008">Phone</A>');
  });

  it('preserves nesting and sibling order (bookmark, folder(bookmark, folder(bookmark), bookmark))', () => {
    const titles = lines.map((l) => /<(?:A|H3)[^>]*>([^<]*)<\/(?:A|H3)>/.exec(l)?.[1]).filter((t): t is string => t !== undefined);
    expect(titles).toEqual(['Bookmarks bar', 'Tom &amp; &quot;Jerry&quot; &lt;b&gt;', 'Work', 'Second', 'Nested', 'Third', 'Fourth', 'Loose other', '生活', 'Mobile bookmarks', 'Phone']);

    // 缩进反映层级：Work 在 1 级里 → 2 个缩进，Third 在 Nested 里 → 4 个缩进
    const depth = (title: string) => (lines.find((l) => l.includes(`>${title}</`))!.match(/^ */)?.[0].length ?? 0) / 4;
    expect(depth('Bookmarks bar')).toBe(1);
    expect(depth('Work')).toBe(2);
    expect(depth('Second')).toBe(3);
    expect(depth('Nested')).toBe(3);
    expect(depth('Third')).toBe(4);
    expect(depth('Fourth')).toBe(3);
  });

  it('HTML-escapes <, &, " (and > \') in titles and urls', () => {
    expect(html).toContain('<DT><A HREF="https://x.example/?a=1&amp;b=&lt;2&gt;&amp;c=&quot;3&quot;" ADD_DATE="1700000001">Tom &amp; &quot;Jerry&quot; &lt;b&gt;</A>');
    expect(html).not.toContain('Tom & ');
    expect(html).not.toContain('<b>');
    expect(escapeHtml(`<a href="x">it's & done</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;it&#39;s &amp; done&lt;/a&gt;');
  });

  it('skips managed subtrees entirely', () => {
    expect(html).not.toContain('Managed bookmarks');
    expect(html).not.toContain('policy.example');
    // managed 节点混在普通文件夹里也跳过
    const tree = rawTree();
    tree[0]!.children![1]!.children!.push({ id: 'mg2', parentId: '2', title: 'Sneaky', url: 'https://sneaky.example/', unmodifiable: 'managed' });
    expect(renderNetscapeHtml(tree, T0)).not.toContain('sneaky');
  });

  it('converts ms timestamps to seconds and falls back to `now` when a node has no dateAdded', () => {
    expect(html).toContain('ADD_DATE="1700000001"'); // T0 + 1s
    // Nested 没有 dateAdded → 用 now
    expect(lines).toContain('            <DT><H3 ADD_DATE="1700000000" LAST_MODIFIED="1700000000">Nested</H3>');
  });

  it('renders a fake api tree (permanent folders passed directly also work) and empty folders keep an empty <DL>', () => {
    const fake = createFakeBookmarksApi([
      { id: '1', title: 'Bookmarks bar', folderType: 'bookmarks-bar', syncing: false, children: [{ id: 'e', title: 'Empty', children: [] }] },
      { id: '2', title: 'Other bookmarks', folderType: 'other', syncing: false, children: [{ id: 'x', title: 'x', url: 'https://x/' }] },
    ]);
    return fake.getTree().then((tree) => {
      const out = renderNetscapeHtml(tree, T0);
      expect(out).toContain('PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>');
      expect(out).toContain('>Empty</H3>\n        <DL><p>\n        </DL><p>');
      expect(out).toContain('<DT><A HREF="https://x/"');
      // 直接传顶层文件夹数组
      expect(renderNetscapeHtml(tree[0]!.children!, T0)).toBe(out);
    });
  });
});

describe('backupFileName', () => {
  it('formats as shelfmark-backup-YYYYMMDD-HHmm.html in local time', () => {
    expect(backupFileName(new Date(2026, 8, 21, 17, 5))).toBe('shelfmark-backup-20260921-1705.html');
    expect(backupFileName(new Date(2026, 0, 1, 0, 0))).toBe('shelfmark-backup-20260101-0000.html');
    expect(backupFileName(new Date(2026, 11, 31, 23, 59).getTime())).toBe('shelfmark-backup-20261231-2359.html');
    expect(backupFileName()).toMatch(/^shelfmark-backup-\d{8}-\d{4}\.html$/);
  });
});
