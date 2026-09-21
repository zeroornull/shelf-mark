import { getDomain, parse as parseDomain } from 'tldts';
import type { FlatBookmark } from '../types';
import { redactTitle } from './privacy';
import type { DomainStat } from './prompts';

/**
 * 域名直方图 / 重复 URL / 语言判定（计划 §6.2）。只依赖 tldts，纯函数。
 */

export const HISTOGRAM_LIMIT = 150;
export const SAMPLE_TITLES_PER_DOMAIN = 2;

/** eTLD+1（`allowPrivateDomains`：github.io / vercel.app 这类按站点算而不是整个平台）；IP / localhost 用 hostname；解析失败用 `unknown`。 */
export function domainOf(url: string): string {
  const domain = getDomain(url, { allowPrivateDomains: true });
  if (domain) return domain.toLowerCase();
  const hostname = parseDomain(url).hostname;
  if (hostname) return hostname.toLowerCase();
  try {
    return new URL(url).protocol.replace(/:$/, '') || 'unknown';
  } catch {
    return 'unknown';
  }
}

type Bucket = { domain: string; count: number; sampleTitles: string[]; order: number };

/**
 * 按 eTLD+1 聚合：`{ domain, count, sampleTitles }[]`，每域最多 2 个（脱敏后、去重、非空）标题，
 * count 降序（同 count 按首次出现顺序），取前 `limit`（默认 150）。
 */
export function domainHistogram(
  bookmarks: ReadonlyArray<Pick<FlatBookmark, 'title' | 'url'>>,
  limit = HISTOGRAM_LIMIT,
): DomainStat[] {
  const buckets = new Map<string, Bucket>();
  let order = 0;
  for (const bookmark of bookmarks) {
    const domain = domainOf(bookmark.url);
    let bucket = buckets.get(domain);
    if (!bucket) {
      bucket = { domain, count: 0, sampleTitles: [], order: order++ };
      buckets.set(domain, bucket);
    }
    bucket.count += 1;
    if (bucket.sampleTitles.length < SAMPLE_TITLES_PER_DOMAIN) {
      const title = redactTitle(bookmark.title);
      if (title !== '' && !bucket.sampleTitles.includes(title)) bucket.sampleTitles.push(title);
    }
  }
  return [...buckets.values()]
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .slice(0, Math.max(0, limit))
    .map(({ domain, count, sampleTitles }) => ({ domain, count, sampleTitles }));
}

/** 去 fragment、去尾部 `/` 后的完整 URL；用于重复检测。 */
export function duplicateKey(url: string): string {
  const withoutFragment = url.trim().split('#', 1)[0] ?? '';
  return withoutFragment.replace(/\/+$/, '');
}

export type DuplicateGroup = { url: string; bookmarkIds: string[] };

/** 同一 key 出现 ≥ 2 次的分组，按首次出现顺序；V1 只展示不删。 */
export function findDuplicates(bookmarks: ReadonlyArray<Pick<FlatBookmark, 'id' | 'url'>>): DuplicateGroup[] {
  const groups = new Map<string, string[]>();
  for (const bookmark of bookmarks) {
    const key = duplicateKey(bookmark.url);
    if (key === '') continue;
    const ids = groups.get(key);
    if (ids) ids.push(bookmark.id);
    else groups.set(key, [bookmark.id]);
  }
  const out: DuplicateGroup[] = [];
  for (const [url, bookmarkIds] of groups) {
    if (bookmarkIds.length >= 2) out.push({ url, bookmarkIds });
  }
  return out;
}

// 汉字、日文假名、韩文音节（中文书签里夹日韩标题也算 CJK）
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 标题里 CJK 字符占非空白字符的比例 > 30% → 'zh'，否则 'en'。空输入 → 'en'。 */
export function detectLanguage(titles: ReadonlyArray<string>): 'zh' | 'en' {
  let total = 0;
  let cjk = 0;
  for (const title of titles) {
    for (const char of title) {
      if (/\s/.test(char)) continue;
      total += 1;
      if (CJK_RE.test(char)) cjk += 1;
    }
  }
  return total > 0 && cjk / total > 0.3 ? 'zh' : 'en';
}
