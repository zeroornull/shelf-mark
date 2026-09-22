import { folderDisplayPaths, formatFolderPath } from '../bookmarks/tree';
import type { BookmarkTree } from '../bookmarks/tree';
import type { HeldBackItem, MoveReportItem, Snapshot } from '../types';
import { listApplyCandidates, type ResolveMovesInput } from './resolve';

const MISSING = '（位置已不存在）';

/** 用应用后的树 + snapshot journal 还原「从哪到哪」。只含实际 move 成功的条目。 */
export function buildMoveReport(tree: BookmarkTree, snapshot: Snapshot): MoveReportItem[] {
  const paths = folderDisplayPaths(tree);
  const applied = new Set(snapshot.applied);
  const out: MoveReportItem[] = [];
  for (const item of snapshot.items) {
    if (!applied.has(item.bookmarkId)) continue;
    out.push({
      bookmarkId: item.bookmarkId,
      title: item.title,
      url: item.url,
      fromPath: paths.get(item.fromParentId) ?? [MISSING],
      toPath: paths.get(item.toParentId) ?? [MISSING],
    });
  }
  return out;
}

/** 应用时勾掉的条目（有去处但没写入）。 */
export function buildHeldBack(input: ResolveMovesInput): HeldBackItem[] {
  return listApplyCandidates(input)
    .filter((row) => row.excluded && !row.keepStill)
    .map((row) => ({ bookmarkId: row.bookmarkId, title: row.title, destLabel: row.destLabel }));
}

export function groupMoveReport(items: ReadonlyArray<MoveReportItem>): Array<{
  toLabel: string;
  fromGroups: Array<{ fromLabel: string; items: MoveReportItem[] }>;
}> {
  const byTo = new Map<string, MoveReportItem[]>();
  for (const item of items) {
    const key = formatFolderPath(item.toPath);
    const list = byTo.get(key) ?? [];
    list.push(item);
    byTo.set(key, list);
  }
  return [...byTo.entries()].map(([toLabel, rows]) => {
    const byFrom = new Map<string, MoveReportItem[]>();
    for (const item of rows) {
      const key = formatFolderPath(item.fromPath);
      const list = byFrom.get(key) ?? [];
      list.push(item);
      byFrom.set(key, list);
    }
    return {
      toLabel,
      fromGroups: [...byFrom.entries()].map(([fromLabel, groupItems]) => ({ fromLabel, items: groupItems })),
    };
  });
}
