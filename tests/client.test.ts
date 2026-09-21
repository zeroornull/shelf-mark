import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AiError,
  chatCompletion,
  chatJson,
  completionsUrl,
  createChatFn,
  createQuirks,
  describeAiError,
  maskApiKey,
  parseJsonLoose,
  pingProvider,
  stripFences,
} from '../src/lib/ai/client';
import type { ProviderConfig } from '../src/lib/types';

const API_KEY = 'sk-secret-key-1234567890abcd';
const provider: ProviderConfig = { baseUrl: 'https://api.example.com/v1/', apiKey: API_KEY, model: 'test-model' };

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
type Handler = (call: Call, init: RequestInit) => Response | Promise<Response>;

/** 按调用顺序取 handler；超出时复用最后一个。 */
function fakeFetch(handlers: Handler[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const handler = handlers[calls.length - 1] ?? handlers[handlers.length - 1];
    if (!handler) throw new Error('no handler');
    return handler(call, init ?? {});
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const ok = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200 });
const http = (status: number, body: string) => new Response(body, { status });

const schema = z.object({ a: z.number() });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('url / header / body shape', () => {
  it('posts to {baseUrl}/chat/completions with Bearer auth, temperature 0.2 and json_object', async () => {
    const { fn, calls } = fakeFetch([() => ok('{"a":1}')]);
    await chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: fn });

    expect(completionsUrl('https://x.test/v1/')).toBe('https://x.test/v1/chat/completions');
    expect(calls[0]?.url).toBe('https://api.example.com/v1/chat/completions');
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(calls[0]?.body).toEqual({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'U' },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    });
  });
});

describe('fence stripping', () => {
  it('strips ``` and ```json fences and tolerates prose around the block', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('Here you go:\n```json\n{"a": 1}\n```\nDone.')).toBe('{"a": 1}');
    expect(stripFences('{"a":1}')).toBe('{"a":1}');
  });

  it('a ``` inside a JSON string value does not end the fence (closing fence = last ```)', () => {
    const inner = '{"title":"用法：```js\\nfoo()\\n```","n":1}';
    expect(stripFences(`\`\`\`json\n${inner}\n\`\`\``)).toBe(inner);
    expect(JSON.parse(stripFences(`\`\`\`json\n${inner}\n\`\`\`\n`))).toEqual({ title: '用法：```js\nfoo()\n```', n: 1 });
    // 没有闭合围栏：原样 trim，交给 parseJsonLoose 的 {…} 兜底
    expect(stripFences('```json\n{"a":1}')).toBe('```json\n{"a":1}');
    expect(parseJsonLoose('Sure! {"a":1} hope that helps')).toEqual({ a: 1 });
  });

  it('parses fenced model output through chatJson', async () => {
    const { fn } = fakeFetch([() => ok('```json\n{"a": 42}\n```')]);
    await expect(chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: fn })).resolves.toEqual({ a: 42 });
  });
});

describe('zod retry', () => {
  it('retries once with the validation error appended to the user message, then succeeds', async () => {
    const { fn, calls } = fakeFetch([() => ok('{"a":"not a number"}'), () => ok('{"a":2}')]);
    const result = await chatJson({ provider, system: 'S', user: 'ORIGINAL', schema, fetchImpl: fn });

    expect(result).toEqual({ a: 2 });
    expect(calls).toHaveLength(2);
    const retryUser = (calls[1]?.body.messages as Array<{ role: string; content: string }>)[1]!;
    expect(retryUser.role).toBe('user');
    expect(retryUser.content.startsWith('ORIGINAL')).toBe(true);
    expect(retryUser.content).toContain('校验错误');
    expect(retryUser.content).toMatch(/expected number/i);
  });

  it('fails with kind schema after the second invalid output', async () => {
    const { fn, calls } = fakeFetch([() => ok('{"a":"x"}')]);
    const error = await chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: fn }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).kind).toBe('schema');
    expect(calls).toHaveLength(2);
    expect(describeAiError(error)).toContain('模型没返回完整 JSON');
  });

  it('treats non-JSON output like a schema failure (one retry, then invalid-json)', async () => {
    const { fn, calls } = fakeFetch([() => ok('I cannot help with that.')]);
    const error = await chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: fn }).catch((e: unknown) => e);
    expect((error as AiError).kind).toBe('invalid-json');
    expect(calls).toHaveLength(2);
  });
});

describe('400 fallbacks', () => {
  it('drops response_format after a 400 mentioning it and remembers the decision via quirks', async () => {
    const quirks = createQuirks();
    const { fn, calls } = fakeFetch([
      () => http(400, '{"error":{"message":"response_format is not supported by this model"}}'),
      () => ok('{"a":1}'),
      () => ok('{"a":2}'),
    ]);

    await chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: fn, quirks });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toHaveProperty('response_format');
    expect(calls[1]?.body).not.toHaveProperty('response_format');
    expect(calls[1]?.body).toHaveProperty('temperature', 0.2);
    expect(quirks.responseFormat).toBe(false);

    // 第二次调用直接不发 response_format，不再吃 400
    await chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: fn, quirks });
    expect(calls).toHaveLength(3);
    expect(calls[2]?.body).not.toHaveProperty('response_format');
  });

  it('drops temperature after a 400 mentioning it', async () => {
    const { fn, calls } = fakeFetch([
      () => http(400, 'Unsupported value: "temperature" does not support 0.2 with this model.'),
      () => ok('{"a":1}'),
    ]);
    await chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: fn });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).not.toHaveProperty('temperature');
    expect(calls[1]?.body).toHaveProperty('response_format');
  });

  it('each fallback happens once: a 400 that keeps complaining is surfaced as HTTP 400', async () => {
    const { fn, calls } = fakeFetch([() => http(400, 'response_format bad'), () => http(400, 'response_format still bad')]);
    const error = await chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: fn }).catch((e: unknown) => e);
    expect((error as AiError).kind).toBe('http');
    expect((error as AiError).status).toBe(400);
    expect(calls).toHaveLength(2);
  });

  it('createChatFn shares quirks across calls', async () => {
    const { fn, calls } = fakeFetch([() => http(400, 'response_format unsupported'), () => ok('{"a":1}'), () => ok('{"a":1}')]);
    const chat = createChatFn(provider, { fetchImpl: fn });
    await chat({ system: 'S', user: 'U', schema });
    await chat({ system: 'S', user: 'U', schema });
    expect(calls).toHaveLength(3);
    expect(calls[2]?.body).not.toHaveProperty('response_format');
  });
});

describe('429 / 5xx backoff', () => {
  it('backs off exponentially (1s, 2s) and succeeds on the third attempt', async () => {
    vi.useFakeTimers();
    const { fn, calls } = fakeFetch([() => http(429, 'slow down'), () => http(503, 'busy'), () => ok('{"a":1}')]);

    const promise = chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: fn });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);

    await expect(promise).resolves.toEqual({ a: 1 });
  });

  it('gives up after 3 attempts and maps 429 to 「限速，请稍后」', async () => {
    const { fn, calls } = fakeFetch([() => http(429, 'rate limited')]);
    const error = await chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: fn, retryBaseMs: 1 }).catch((e: unknown) => e);
    expect(calls).toHaveLength(3);
    expect((error as AiError).status).toBe(429);
    expect(describeAiError(error)).toContain('限速，请稍后');
  });

  it('does not retry 4xx other than 429 / fallback-400', async () => {
    const { fn, calls } = fakeFetch([() => http(401, '{"error":"invalid api key"}')]);
    const error = await chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: fn }).catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(describeAiError(error)).toContain('Key 无效');
  });
});

describe('timeout and abort', () => {
  it('aborts the request after timeoutMs and reports a timeout', async () => {
    vi.useFakeTimers();
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });

    const promise = chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: hanging });
    const settled = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(179_999);
    await vi.advanceTimersByTimeAsync(1);
    const error = await settled;
    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).kind).toBe('timeout');
    expect(describeAiError(error)).toBe('请求超时：请求超时（180s）');
  });

  it('puts the configured timeoutMs in the error, not a hardcoded 60s', async () => {
    vi.useFakeTimers();
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });

    const promise = chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: hanging, timeoutMs: 90_000 });
    const settled = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(90_000);
    const error = await settled;
    expect((error as AiError).kind).toBe('timeout');
    expect(describeAiError(error)).toBe('请求超时：请求超时（90s）');
  });

  it('createChatFn forwards timeoutMs into chatJson', async () => {
    vi.useFakeTimers();
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const chat = createChatFn(provider, { fetchImpl: hanging, timeoutMs: 45_000 });
    const settled = chat({ system: 'S', user: 'U', schema }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(45_000);
    const error = await settled;
    expect((error as AiError).kind).toBe('timeout');
    expect(describeAiError(error)).toBe('请求超时：请求超时（45s）');
  });

  it('propagates an external AbortSignal as kind aborted', async () => {
    const controller = new AbortController();
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const promise = chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: hanging, signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    const error = await promise;
    expect((error as AiError).kind).toBe('aborted');
    expect(describeAiError(error)).toBe('已取消');
  });

  it('aborting during backoff sleep rejects immediately with aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const { fn } = fakeFetch([() => http(429, 'x')]);
    const promise = chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: fn, signal: controller.signal }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    const error = await promise;
    expect((error as AiError).kind).toBe('aborted');
  });
});

describe('secrets', () => {
  it('masks the api key', () => {
    expect(maskApiKey('sk-secret-key-1234567890abcd')).toBe('sk-…abcd');
    expect(maskApiKey('short')).toBe('…');
    expect(maskApiKey('')).toBe('(empty)');
  });

  it('never includes the apiKey in thrown errors, even when the provider echoes it', async () => {
    const { fn } = fakeFetch([() => http(401, `{"error":"invalid key ${API_KEY} rejected"}`)]);
    const error = (await chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: fn }).catch((e: unknown) => e)) as AiError;
    expect(error.message).not.toContain(API_KEY);
    expect(error.detail).not.toContain(API_KEY);
    expect(error.detail).toContain('sk-…abcd');
    expect(describeAiError(error)).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  it('masks the key inside network error messages too', async () => {
    const throwing: typeof fetch = () => Promise.reject(new TypeError(`Failed to fetch ${API_KEY}`));
    const error = (await chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: throwing }).catch((e: unknown) => e)) as AiError;
    expect(error.message).not.toContain(API_KEY);
  });
});

describe('Failed to fetch mapping', () => {
  it('maps TypeError: Failed to fetch to a network error with the CORS / origin hint', async () => {
    const throwing: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const error = (await chatJson({ provider, system: 'S', user: 'U', schema, fetchImpl: throwing }).catch((e: unknown) => e)) as AiError;
    expect(error.kind).toBe('network');
    expect(error.hint).toContain('CORS');
    const text = describeAiError(error);
    expect(text).toContain('CORS / 未授权 origin');
    expect(text).toContain('去设置页重新测试连接');
  });

  it('describeAiError also handles a raw TypeError from fetch', () => {
    expect(describeAiError(new TypeError('Failed to fetch'))).toContain('CORS / 未授权 origin');
  });
});

describe('chatCompletion / pingProvider', () => {
  it('ping sends only model, messages and max_tokens', async () => {
    const { fn, calls } = fakeFetch([() => ok('pong')]);
    const result = await pingProvider(provider, { fetchImpl: fn });
    expect(result.content).toBe('pong');
    expect(calls[0]?.body).toEqual({
      model: 'test-model',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 4,
    });
  });

  it('ping retries once without max_tokens when a 400 mentions it', async () => {
    const { fn, calls } = fakeFetch([() => http(400, '{"error":"Unsupported parameter: max_tokens"}'), () => ok('pong')]);
    await pingProvider(provider, { fetchImpl: fn });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).not.toHaveProperty('max_tokens');
  });

  it('ping times out at 20s, not the 180s chat default', async () => {
    vi.useFakeTimers();
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const settled = pingProvider(provider, { fetchImpl: hanging }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(19_999);
    await vi.advanceTimersByTimeAsync(1);
    const error = await settled;
    expect((error as AiError).kind).toBe('timeout');
    expect(describeAiError(error)).toBe('请求超时：请求超时（20s）');
  });

  it('ping does not swallow 429 into retries', async () => {
    const { fn, calls } = fakeFetch([() => http(429, 'nope')]);
    const error = await pingProvider(provider, { fetchImpl: fn }).catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect((error as AiError).status).toBe(429);
  });

  it('reports empty content as 「模型没返回完整 JSON」-class error', async () => {
    const { fn } = fakeFetch([() => new Response(JSON.stringify({ choices: [] }), { status: 200 })]);
    const error = await chatCompletion({ provider, messages: [{ role: 'user', content: 'x' }], fetchImpl: fn }).catch((e: unknown) => e);
    expect((error as AiError).kind).toBe('empty');
    expect(describeAiError(error)).toContain('模型没返回');
  });
});
