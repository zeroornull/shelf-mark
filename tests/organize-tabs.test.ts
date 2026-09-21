import { describe, expect, it } from 'vitest';
import { isSameContext, pickOrganizeTab, presenceOf } from '../src/lib/jobs/organize-tabs';
import { isRequestableOrigin } from '../src/lib/origins';

describe('[H1/M5] organize page presence', () => {
  it('unknown when contexts cannot be listed (fail closed: treated as possibly open by callers)', () => {
    expect(presenceOf(null)).toBe('unknown');
    expect(presenceOf(null, { tabId: 1 })).toBe('unknown');
  });

  it('open / closed from the sidepanel perspective', () => {
    expect(presenceOf([])).toBe('closed');
    expect(presenceOf([{ tabId: 7, documentId: 'd7' }])).toBe('open');
  });

  it('excludes the current tab when the organize page checks for *other* organize pages', () => {
    const self = { tabId: 7, documentId: 'd7' };
    expect(presenceOf([{ tabId: 7, documentId: 'd7' }], self)).toBe('closed');
    expect(presenceOf([{ tabId: 7, documentId: 'd7' }, { tabId: 9, documentId: 'd9' }], self)).toBe('open');
    // 只有 tabId 时按 tabId 比
    expect(presenceOf([{ tabId: 7 }], { tabId: 7 })).toBe('closed');
    expect(presenceOf([{ tabId: 8 }], { tabId: 7 })).toBe('open');
  });

  it('isSameContext prefers documentId, falls back to tabId, and never matches without either', () => {
    expect(isSameContext({ tabId: 1, documentId: 'a' }, { tabId: 2, documentId: 'a' })).toBe(true);
    expect(isSameContext({ tabId: 1, documentId: 'a' }, { tabId: 1, documentId: 'b' })).toBe(false);
    expect(isSameContext({ tabId: 1 }, { tabId: 1, documentId: 'b' })).toBe(true);
    expect(isSameContext({}, {})).toBe(false);
  });

  it('pickOrganizeTab returns the first tab with an id (windowId optional)', () => {
    expect(pickOrganizeTab([])).toBeNull();
    expect(pickOrganizeTab([{ windowId: 3 }])).toBeNull();
    expect(pickOrganizeTab([{ windowId: 3 }, { id: 12, windowId: 4 }, { id: 13 }])).toEqual({ id: 12, windowId: 4 });
    expect(pickOrganizeTab([{ id: 13 }])).toEqual({ id: 13 });
  });
});

describe('[L5] isRequestableOrigin mirrors optional_host_permissions', () => {
  it.each<[string, boolean]>([
    ['https://api.openai.com', true],
    ['https://192.168.1.10:8080', true],
    ['http://localhost:11434', true],
    ['http://127.0.0.1:1234', true],
    ['http://192.168.1.10:11434', false],
    ['http://ollama.lan', false],
    ['ftp://x', false],
    ['not a url', false],
  ])('%s → %s', (origin, expected) => {
    expect(isRequestableOrigin(origin)).toBe(expected);
  });
});
