import { describe, expect, it } from 'vitest';
import { redactTitle, sanitizeUrl } from '../src/lib/ai/privacy';

describe('sanitizeUrl', () => {
  it('drops query, fragment and credentials', () => {
    expect(sanitizeUrl('https://user:pw@example.com/a/b?token=secret#frag')).toBe('https://example.com/a/b');
    expect(sanitizeUrl('https://example.com/?q=1')).toBe('https://example.com');
    expect(sanitizeUrl('https://example.com/#top')).toBe('https://example.com');
  });

  it('keeps at most 3 path segments', () => {
    expect(sanitizeUrl('https://github.com/owner/repo/blob/main/src/file.ts')).toBe('https://github.com/owner/repo/blob');
    expect(sanitizeUrl('https://example.com/a/b/c/')).toBe('https://example.com/a/b/c');
    expect(sanitizeUrl('https://example.com/a')).toBe('https://example.com/a');
  });

  it('caps the total length at 120 characters', () => {
    const long = `https://example.com/${'x'.repeat(200)}`;
    const out = sanitizeUrl(long);
    expect(out.length).toBe(120);
    expect(out.startsWith('https://example.com/xxx')).toBe(true);
  });

  it('keeps the port but never userinfo', () => {
    expect(sanitizeUrl('http://localhost:11434/v1/models?x=1')).toBe('http://localhost:11434/v1/models');
    expect(sanitizeUrl('http://alice:secret@127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
  });

  it('domainOnly keeps only the hostname', () => {
    expect(sanitizeUrl('https://sub.example.com:8443/a/b?c=1', true)).toBe('sub.example.com');
    expect(sanitizeUrl('https://example.com', true)).toBe('example.com');
  });

  it('handles non-URL strings by cutting at ? or # and truncating', () => {
    expect(sanitizeUrl('not a url?with=query#frag')).toBe('not a url');
    expect(sanitizeUrl('x'.repeat(300))).toHaveLength(120);
    expect(sanitizeUrl('')).toBe('');
  });

  it('handles odd schemes without a host', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('javascript:');
    expect(sanitizeUrl('chrome://settings/passwords?x=1')).toBe('chrome://settings/passwords');
  });
});

describe('redactTitle', () => {
  it('replaces emails with [email]', () => {
    expect(redactTitle('Login for john.doe+tag@example.co.uk - Dashboard')).toBe('Login for [email] - Dashboard');
    expect(redactTitle('a@b.c and d_e@f-g.hi')).toBe('[email] and [email]');
  });

  it('collapses whitespace and trims', () => {
    expect(redactTitle('  Hello \n  World\t!  ')).toBe('Hello World !');
  });

  it('caps at 120 characters without splitting surrogate pairs', () => {
    const emoji = '😀'.repeat(130);
    const out = redactTitle(emoji);
    expect(Array.from(out)).toHaveLength(120);
    expect(redactTitle('a'.repeat(121))).toHaveLength(120);
    expect(redactTitle('short')).toBe('short');
  });
});
