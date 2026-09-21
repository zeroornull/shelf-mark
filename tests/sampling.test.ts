import { describe, expect, it } from 'vitest';
import { detectLanguage, domainHistogram, domainOf, duplicateKey, findDuplicates } from '../src/lib/ai/sampling';

const bm = (id: string, url: string, title = id) => ({ id, url, title });

describe('domainOf', () => {
  it('uses eTLD+1, treating private suffixes (github.io) as sites', () => {
    expect(domainOf('https://www.github.com/a/b')).toBe('github.com');
    expect(domainOf('https://docs.google.com/x')).toBe('google.com');
    expect(domainOf('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
    expect(domainOf('https://pax.github.io/blog')).toBe('pax.github.io');
  });

  it('falls back to hostname for localhost / IPs and to the scheme for the rest', () => {
    expect(domainOf('http://localhost:11434/v1')).toBe('localhost');
    expect(domainOf('http://192.168.1.10/admin')).toBe('192.168.1.10');
    expect(domainOf('chrome://settings/')).toBe('settings');
    expect(domainOf('javascript:void(0)')).toBe('javascript');
    expect(domainOf('not a url')).toBe('unknown');
  });
});

describe('domainHistogram', () => {
  it('aggregates by eTLD+1 with counts, ≤ 2 redacted sample titles, sorted by count desc', () => {
    const hist = domainHistogram([
      bm('1', 'https://github.com/a', 'Repo A'),
      bm('2', 'https://gist.github.com/b', 'Gist B contact me@x.com'),
      bm('3', 'https://github.com/c', 'Repo C'),
      bm('4', 'https://example.com/', 'Example'),
      bm('5', 'https://news.ycombinator.com/', 'HN'),
      bm('6', 'https://news.ycombinator.com/item?id=1', 'HN'),
    ]);

    expect(hist.map((h) => [h.domain, h.count])).toEqual([
      ['github.com', 3],
      ['ycombinator.com', 2],
      ['example.com', 1],
    ]);
    expect(hist[0]?.sampleTitles).toEqual(['Repo A', 'Gist B contact [email]']);
    // 相同标题只算一个样例
    expect(hist[1]?.sampleTitles).toEqual(['HN']);
  });

  it('keeps the first-seen order among equal counts and caps at the limit (150 by default)', () => {
    const many = Array.from({ length: 200 }, (_, i) => bm(String(i), `https://site${i}.com/`, `t${i}`));
    const hist = domainHistogram(many);
    expect(hist).toHaveLength(150);
    expect(hist[0]?.domain).toBe('site0.com');
    expect(hist[149]?.domain).toBe('site149.com');
    expect(domainHistogram(many, 10)).toHaveLength(10);
  });

  it('skips empty titles when sampling', () => {
    const hist = domainHistogram([bm('1', 'https://a.com/', ''), bm('2', 'https://a.com/x', '  '), bm('3', 'https://a.com/y', 'Y')]);
    expect(hist[0]?.sampleTitles).toEqual(['Y']);
  });
});

describe('findDuplicates', () => {
  it('groups by url without fragment and trailing slash, only groups of ≥ 2', () => {
    const dups = findDuplicates([
      bm('a', 'https://example.com/page/'),
      bm('b', 'https://example.com/page#section'),
      bm('c', 'https://example.com/page'),
      bm('d', 'https://example.com/other'),
      bm('e', 'https://example.com/page?x=1'), // query 不同就是不同 URL
      bm('f', 'https://unique.com/'),
      bm('g', 'https://example.com/other/#'),
    ]);
    expect(dups).toEqual([
      { url: 'https://example.com/page', bookmarkIds: ['a', 'b', 'c'] },
      { url: 'https://example.com/other', bookmarkIds: ['d', 'g'] },
    ]);
    expect(duplicateKey('https://x.com///#frag')).toBe('https://x.com');
  });

  it('returns [] when nothing repeats', () => {
    expect(findDuplicates([bm('a', 'https://a.com'), bm('b', 'https://b.com')])).toEqual([]);
    expect(findDuplicates([])).toEqual([]);
  });
});

describe('detectLanguage', () => {
  it("returns 'zh' when CJK characters exceed 30% of non-whitespace characters", () => {
    expect(detectLanguage(['前端 周刊', 'Vue 文档', 'GitHub'])).toBe('zh');
    expect(detectLanguage(['日本語のタイトル', '한국어 제목'])).toBe('zh');
  });

  it("returns 'en' otherwise, including for empty input", () => {
    expect(detectLanguage(['Hacker News', 'GitHub - vuejs/core', 'MDN Web Docs 文档'])).toBe('en');
    expect(detectLanguage([])).toBe('en');
    expect(detectLanguage(['', '   '])).toBe('en');
  });
});
