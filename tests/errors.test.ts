import { describe, expect, it } from 'vitest';
import { AiError, describeAiError } from '../src/lib/ai/client';
import { describeBookmarkError, describeSkipReason } from '../src/lib/bookmarks/errors';
import { describeRestoreSummary, restoreAnomalies } from '../src/lib/jobs/recovery';

/** §13 的错误文案表：每种错误 → 用户看到的中文。 */
describe('describeAiError table (§13)', () => {
  const http = (status: number, detail = '') => new AiError('http', `HTTP ${status}${detail ? `：${detail}` : ''}`, { status, detail });

  it.each<[string, unknown, RegExp]>([
    ['401', http(401, 'invalid api key'), /^Key 无效（HTTP 401）：invalid api key$/],
    ['403', http(403), /^没有权限（HTTP 403）$/],
    ['404', http(404), /接口不存在（HTTP 404）：检查 baseUrl 是否以 \/v1 结尾/],
    ['429', http(429, 'slow down'), /^限速，请稍后（HTTP 429）：slow down$/],
    ['500', http(500), /^服务商错误（HTTP 500）$/],
    ['502', http(502, 'bad gateway'), /^服务商错误（HTTP 502）：bad gateway$/],
    ['other 4xx', http(418), /^HTTP 418$/],
    ['network (Failed to fetch)', new AiError('network', 'TypeError: Failed to fetch', { hint: '可能是 CORS 或未授权该 origin，去设置页重新测试连接' }), /^CORS \/ 未授权 origin：可能是 CORS 或未授权该 origin，去设置页重新测试连接（TypeError: Failed to fetch）$/],
    ['raw TypeError from fetch', new TypeError('Failed to fetch'), /^CORS \/ 未授权 origin：.*去设置页重新测试连接（Failed to fetch）$/],
    ['timeout', new AiError('timeout', '请求超时（180s）'), /^请求超时：请求超时（180s）$/],
    ['aborted', new AiError('aborted', '已取消'), /^已取消$/],
    ['empty content', new AiError('empty', '模型没返回内容（choices[0].message.content 为空）'), /^模型没返回完整 JSON：模型没返回内容/],
    ['invalid json', new AiError('invalid-json', '模型没返回完整 JSON：Unexpected token'), /^模型没返回完整 JSON：Unexpected token$/],
    ['schema', new AiError('schema', 'categories: expected array'), /^模型没返回完整 JSON：categories: expected array$/],
    ['plain Error', new Error('整理范围内没有散装书签'), /^整理范围内没有散装书签$/],
    ['string', 'boom', /^boom$/],
  ])('%s', (_label, error, expected) => {
    expect(describeAiError(error)).toMatch(expected);
  });
});

describe('describeBookmarkError', () => {
  it.each<[string, string]>([
    ["Can't find bookmark for id 42.", '书签或文件夹不存在（可能已被删除）（Can\'t find bookmark for id 42.）'],
    ["Can't modify managed bookmarks.", '企业策略书签不可修改（Can\'t modify managed bookmarks.）'],
    ["Can't modify the root bookmark folders.", '不能修改书签根节点（Can\'t modify the root bookmark folders.）'],
    ['Index out of bounds: 7 (children.length = 3).', '目标位置越界（Index out of bounds: 7 (children.length = 3).）'],
    ['Bookmark editing is disabled.', '浏览器策略禁止编辑书签（Bookmark editing is disabled.）'],
    ["Can't remove non-empty folder (use recursive to force).", '文件夹非空，未删除（Can\'t remove non-empty folder (use recursive to force).）'],
    ["Can't move a folder to itself or its descendant.", '不能把文件夹移到自己或子文件夹里（Can\'t move a folder to itself or its descendant.）'],
    ['something else entirely', 'something else entirely'],
  ])('%s', (message, expected) => {
    expect(describeBookmarkError(new Error(message))).toBe(expected);
  });

  it('accepts non-Error values', () => {
    expect(describeBookmarkError('Invalid URL.')).toBe('网址无效（Invalid URL.）');
    expect(describeBookmarkError(42)).toBe('42');
  });
});

describe('describeSkipReason', () => {
  it('translates every SkipReason and passes unknown reasons through', () => {
    for (const reason of ['duplicate', 'missing', 'not-a-bookmark', 'managed', 'no-root', 'parent-changed', 'target-missing', 'cross-root', 'same-parent']) {
      const text = describeSkipReason(reason);
      expect(text).not.toBe(reason);
      expect(text).toMatch(/[\u4e00-\u9fff]/);
    }
    expect(describeSkipReason('missing')).toBe('书签已不存在（预览后被删除）');
    expect(describeSkipReason('whatever')).toBe('whatever');
  });
});

describe('describeRestoreSummary', () => {
  const base = { total: 10, restored: 10, skipped: 0, relocated: 0, failed: 0, removedFolders: 2, keptFolders: 0 } as const;

  it('leads with the reason and appends only the non-zero anomalies', () => {
    expect(describeRestoreSummary({ ...base, reason: 'undo' })).toBe('已撤销 10/10');
    expect(describeRestoreSummary({ ...base, reason: 'cancel' })).toBe('已取消并回滚 10/10');
    expect(describeRestoreSummary({ ...base, reason: 'failure' })).toBe('已回滚 10/10');
    expect(describeRestoreSummary({ ...base, reason: 'interrupted', restored: 7, skipped: 1, relocated: 1, failed: 1, keptFolders: 1 })).toBe(
      '已回滚 7/10；1 条原文件夹已不存在，移到了根目录末尾；1 条书签已被删除，跳过；1 条恢复失败，留在原地；1 个新建文件夹因非空而保留',
    );
  });

  it('accepts a head override (结果页统一「已恢复 N/M」) and exposes the anomalies separately', () => {
    expect(describeRestoreSummary({ ...base, reason: 'undo' }, '已恢复')).toBe('已恢复 10/10');
    expect(restoreAnomalies({ ...base, reason: 'undo' })).toEqual([]);
    expect(restoreAnomalies({ ...base, reason: 'failure', keptFolders: 2, failed: 1 })).toEqual(['1 条恢复失败，留在原地', '2 个新建文件夹因非空而保留']);
  });
});
