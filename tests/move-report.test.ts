import { describe, expect, it } from 'vitest';
import { buildBookmarkTree } from '../src/lib/bookmarks/tree';
import { createFakeBookmarksApi } from '../src/lib/bookmarks/fake';
import { applySnapshot } from '../src/lib/bookmarks/snapshot';
import { buildMoveReport, groupMoveReport } from '../src/lib/jobs/move-report';

describe('move report', () => {
  it('records fromPath → toPath after apply', async () => {
    const api = createFakeBookmarksApi([
      {
        id: '2',
        title: '其他书签',
        folderType: 'other',
        syncing: false,
        children: [
          { id: 'a', title: 'Repo', url: 'https://github.com/a' },
          { id: 'b', title: 'Shop', url: 'https://taobao.com/b' },
        ],
      },
    ]);
    const result = await applySnapshot(
      api,
      [
        { bookmarkId: 'a', toPath: ['github.com'], expectedParentId: '2' },
        { bookmarkId: 'b', toPath: ['github.com'], expectedParentId: '2' },
      ],
      { persist: async () => {}, now: () => 1 },
    );
    expect(result.ok).toBe(true);
    const report = buildMoveReport(buildBookmarkTree(await api.getTree()), result.snapshot);
    expect(report).toHaveLength(2);
    expect(report[0]).toMatchObject({ title: 'Repo', fromPath: ['其他书签'], toPath: ['其他书签', 'github.com'] });
    const grouped = groupMoveReport(report);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.toLabel).toBe('其他书签 / github.com');
    expect(grouped[0]?.fromGroups[0]?.fromLabel).toBe('其他书签');
  });
});
