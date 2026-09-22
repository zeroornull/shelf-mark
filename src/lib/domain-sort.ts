import { UNCATEGORIZED } from './ai/taxonomy';
import { domainOf, findDuplicates } from './ai/sampling';
import { normalizeTitle } from './bookmarks/mutate';
import type { ReusableFolder } from './bookmarks/tree';
import type { Assignment, Category, FlatBookmark, Proposal } from './types';

/**
 * 按 eTLD+1 生成整理方案：够门槛的域名各建（或复用）一个文件夹，
 * 门槛以下的合法网址收进「其他站点」（会移动），解析不了的才进未分类。
 * 整理页的「按域名」固定门槛为 1：每个能解析的网站都单独建夹。
 * 已在用户自己起名的主题夹里的书签默认不拆出。纯函数，不打模型。
 */

export const ALL_DOMAINS_MIN_COUNT = 1;
export const DEFAULT_DOMAIN_MIN_COUNT = ALL_DOMAINS_MIN_COUNT;
export const MIN_DOMAIN_MIN_COUNT = 1;
export const MAX_DOMAIN_MIN_COUNT = 50;
export const OTHER_SITES_TITLE = '其他站点';

export function clampDomainMinCount(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_DOMAIN_MIN_COUNT;
  return Math.min(MAX_DOMAIN_MIN_COUNT, Math.max(MIN_DOMAIN_MIN_COUNT, Math.round(n)));
}

/** 用于和已有文件夹比：完整域名，以及足够长的首段（`github.com` ↔ `GitHub`）。 */
export function domainTitleKeys(domain: string): string[] {
  const keys = new Set<string>([normalizeTitle(domain)]);
  const first = domain.split('.')[0] ?? '';
  if (first.length > 2) keys.add(normalizeTitle(first));
  return [...keys];
}

export function titleMatchesDomain(title: string, domain: string): boolean {
  return domainTitleKeys(domain).includes(normalizeTitle(title));
}

/** 当前父夹是用户主题夹（路径非空，且夹名对不上这条书签的域名）。 */
export function isThematicFolder(bookmark: Pick<FlatBookmark, 'folderPath' | 'url'>): boolean {
  if (bookmark.folderPath.length === 0) return false;
  const parentTitle = bookmark.folderPath[bookmark.folderPath.length - 1] ?? '';
  return !titleMatchesDomain(parentTitle, domainOf(bookmark.url));
}

export type DomainProposeInput = {
  bookmarks: ReadonlyArray<FlatBookmark>;
  existingFolders: ReadonlyArray<Pick<ReusableFolder, 'id' | 'title' | 'path'>>;
  minCount?: number;
  keepThematic?: boolean;
};

export type DomainProposeResult = Proposal & {
  belowThreshold: number;
  thematicHeld: number;
  qualifyingDomains: string[];
};

export function proposeByDomain(input: DomainProposeInput): DomainProposeResult {
  const minCount = clampDomainMinCount(input.minCount);
  const keepThematic = input.keepThematic !== false;
  const { bookmarks } = input;

  const byDomain = new Map<string, FlatBookmark[]>();
  for (const bookmark of bookmarks) {
    const domain = domainOf(bookmark.url);
    const list = byDomain.get(domain);
    if (list) list.push(bookmark);
    else byDomain.set(domain, [bookmark]);
  }

  const qualifying = [...byDomain.entries()]
    .filter(([domain, items]) => isQualifyingDomain(domain) && items.length >= minCount)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const categories: Category[] = qualifying.map(([domain], i) => {
    const existingFolderId = matchDomainFolder(domain, input.existingFolders);
    return existingFolderId
      ? { id: `c${i + 1}`, title: domain, existingFolderId }
      : { id: `c${i + 1}`, title: domain };
  });
  const categoryByDomain = new Map(qualifying.map(([domain], i) => [domain, categories[i]!.id]));

  const leftovers = bookmarks.filter((bookmark) => {
    if (keepThematic && isThematicFolder(bookmark)) return false;
    const domain = domainOf(bookmark.url);
    return isQualifyingDomain(domain) && !categoryByDomain.has(domain);
  });
  let otherId: string | undefined;
  if (leftovers.length > 0) {
    const existingOther = input.existingFolders.find((folder) => normalizeTitle(folder.title) === normalizeTitle(OTHER_SITES_TITLE));
    otherId = `c${categories.length + 1}`;
    categories.push(
      existingOther
        ? { id: otherId, title: OTHER_SITES_TITLE, existingFolderId: existingOther.id }
        : { id: otherId, title: OTHER_SITES_TITLE },
    );
  }

  let belowThreshold = 0;
  let thematicHeld = 0;
  const assignments: Assignment[] = bookmarks.map((bookmark) => {
    if (keepThematic && isThematicFolder(bookmark)) {
      thematicHeld += 1;
      return { bookmarkId: bookmark.id, categoryId: UNCATEGORIZED, confidence: 'low' };
    }
    const domain = domainOf(bookmark.url);
    const categoryId = categoryByDomain.get(domain);
    if (categoryId) return { bookmarkId: bookmark.id, categoryId, confidence: 'high' };
    if (otherId && isQualifyingDomain(domain)) {
      belowThreshold += 1;
      return { bookmarkId: bookmark.id, categoryId: otherId, confidence: 'medium' };
    }
    return { bookmarkId: bookmark.id, categoryId: UNCATEGORIZED, confidence: 'low' };
  });

  return {
    categories,
    assignments,
    duplicates: findDuplicates(bookmarks),
    warnings: { unknownCategory: 0, missingIndex: 0 },
    belowThreshold,
    thematicHeld,
    qualifyingDomains: qualifying.map(([domain]) => domain),
  };
}

function isQualifyingDomain(domain: string): boolean {
  if (domain === 'unknown' || domain.includes(':')) return false;
  // eTLD+1 / hostname 都带点；`javascript`、`chrome` 这类 scheme 名不建夹
  return domain.includes('.') || domain === 'localhost';
}

/** 同名优先完整域名，其次首段；同档取路径更浅的。 */
function matchDomainFolder(
  domain: string,
  folders: ReadonlyArray<Pick<ReusableFolder, 'id' | 'title' | 'path'>>,
): string | undefined {
  const exact = normalizeTitle(domain);
  const keys = new Set(domainTitleKeys(domain));
  let best: { id: string; score: number; depth: number } | undefined;
  for (const folder of folders) {
    const title = normalizeTitle(folder.title);
    let score: number | undefined;
    if (title === exact) score = 0;
    else if (keys.has(title)) score = 1;
    if (score === undefined) continue;
    const depth = folder.path.length;
    if (!best || score < best.score || (score === best.score && depth < best.depth)) {
      best = { id: folder.id, score, depth };
    }
  }
  return best?.id;
}
