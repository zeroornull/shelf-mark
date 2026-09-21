import { z, type ZodType } from 'zod';
import type { ProviderConfig } from '../types';

/**
 * OpenAI-compatible chat client（计划 §6.1）。不装官方 SDK，不 import `browser` / `wxt/*`：
 * `fetch` 作为参数注入（默认 `globalThis.fetch`），vitest 在 node 里直接跑。
 *
 * - `chatCompletion`：一次 `POST {baseUrl}/chat/completions`，含 429 / 5xx 退避、60s 超时、
 *   以及「服务商不支持 `response_format` / `temperature` / `max_tokens`（400 里提到）→ 去掉重试」。
 *   去掉过的字段记在 `ProviderQuirks` 里，同一次运行内后续请求不再发送，避免每批都吃一次 400。
 * - `chatJson`：system + user → 剥围栏 → `JSON.parse` → zod；校验失败重试 1 次并附上错误。
 * - `describeAiError`：面向用户的中文文案（§13）。
 *
 * apiKey 绝不出现在抛出的错误、日志里：所有来自响应体 / 异常的文本都先 `maskSecrets`。
 */

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatMessage = { role: ChatRole; content: string };

/** 同一次运行内记住服务商的能力，避免每个批次都先吃一次 400。字段为 true 表示「可以发」。 */
export type ProviderQuirks = {
  responseFormat: boolean;
  temperature: boolean;
  maxTokens: boolean;
};

export function createQuirks(): ProviderQuirks {
  return { responseFormat: true, temperature: true, maxTokens: true };
}

export type AiErrorKind =
  | 'http'          // 非 2xx 且不可（再）重试
  | 'network'       // fetch 本身失败（CORS / 未授权 origin / 断网）
  | 'timeout'       // 60s 超时
  | 'aborted'       // 调用方 signal 取消
  | 'empty'         // 2xx 但没有 choices[0].message.content
  | 'invalid-json'  // 剥围栏后仍不是 JSON
  | 'schema';       // zod 校验失败（已重试）

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly status?: number;
  /** 响应体片段（已打码、截断），只用于展示。 */
  readonly detail?: string;
  /** 面向用户的额外提示。 */
  readonly hint?: string;

  constructor(kind: AiErrorKind, message: string, extra: { status?: number; detail?: string; hint?: string; cause?: unknown } = {}) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined);
    this.name = 'AiError';
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.detail !== undefined) this.detail = extra.detail;
    if (extra.hint !== undefined) this.hint = extra.hint;
  }
}

export const FETCH_FAILED_HINT = '可能是 CORS 或未授权该 origin，去设置页重新测试连接';

/** `sk-…abcd`：只留前 3 位和后 4 位。 */
export function maskApiKey(apiKey: string): string {
  const key = apiKey.trim();
  if (key === '') return '(empty)';
  if (key.length <= 8) return '…';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** 把文本里出现的 apiKey 替换成打码版本（服务商偶尔会在错误里回显 key）。 */
export function maskSecrets(text: string, apiKey: string): string {
  const key = apiKey.trim();
  if (key.length < 6) return text;
  return text.split(key).join(maskApiKey(key));
}

export type CompletionArgs = {
  provider: ProviderConfig;
  messages: ChatMessage[];
  /** 传了才发送；服务商拒绝时自动去掉重试一次。 */
  temperature?: number;
  /** true → `response_format: { type: 'json_object' }`；服务商拒绝时自动去掉重试一次。 */
  jsonMode?: boolean;
  /** 传了才发送；服务商拒绝时自动去掉重试一次。 */
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** 默认 60s。 */
  timeoutMs?: number;
  /** 429 / 5xx 最多尝试次数（含首次），默认 3。 */
  maxAttempts?: number;
  /** 退避基数，默认 1000ms：1s → 2s。 */
  retryBaseMs?: number;
  /** 记住 400 fallback 的决定；不传则每次调用都从头试。 */
  quirks?: ProviderQuirks;
};

export type CompletionResult = {
  content: string;
  status: number;
  /** 本次调用实际发出的 HTTP 请求数（含重试）。 */
  requests: number;
};

export const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 1000;
const DETAIL_LIMIT = 300;

export function completionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
}

function abortedError(): AiError {
  return new AiError('aborted', '已取消');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortedError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 400 响应体是否提到某个请求字段（`response_format` / `response format` 两种写法都算）。 */
function mentions(text: string, field: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes(field) || lower.includes(field.replace(/_/g, ' ')) || lower.includes(field.replace(/_/g, ''));
}

function snippet(text: string, apiKey: string): string {
  const masked = maskSecrets(text, apiKey).replace(/\s+/g, ' ').trim();
  return masked.length > DETAIL_LIMIT ? `${masked.slice(0, DETAIL_LIMIT)}…` : masked;
}

/**
 * 一次 chat completion（含重试）。返回 `choices[0].message.content`。
 */
export async function chatCompletion(args: CompletionArgs): Promise<CompletionResult> {
  const {
    provider,
    messages,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    quirks = createQuirks(),
  } = args;
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new AiError('network', 'fetch is not available in this environment');

  const url = completionsUrl(provider.baseUrl);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${provider.apiKey}`,
  };

  const buildBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = { model: provider.model, messages };
    if (args.temperature !== undefined && quirks.temperature) body.temperature = args.temperature;
    if (args.jsonMode && quirks.responseFormat) body.response_format = { type: 'json_object' };
    if (args.maxTokens !== undefined && quirks.maxTokens) body.max_tokens = args.maxTokens;
    return body;
  };

  const doFetch = async (body: Record<string, unknown>): Promise<Response> => {
    if (signal?.aborted) throw abortedError();
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) throw abortedError();
      if (timedOut) throw new AiError('timeout', `请求超时（${Math.round(timeoutMs / 1000)}s）`, { cause: error });
      const text = error instanceof Error ? error.message : String(error);
      if (error instanceof TypeError) {
        throw new AiError('network', `TypeError: ${snippet(text, provider.apiKey)}`, { hint: FETCH_FAILED_HINT, cause: error });
      }
      throw new AiError('network', snippet(text, provider.apiKey), { cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };

  let requests = 0;
  let backoffs = 0;
  while (true) {
    const body = buildBody();
    requests += 1;
    const response = await doFetch(body);

    if (response.ok) {
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new AiError('empty', '模型没返回完整 JSON：响应体不是 JSON', { status: response.status, cause: error });
      }
      const content = extractContent(payload);
      if (content === undefined) {
        throw new AiError('empty', '模型没返回内容（choices[0].message.content 为空）', { status: response.status });
      }
      console.debug('[shelfmark] chat ok', { model: provider.model, status: response.status, requests });
      return { content, status: response.status, requests };
    }

    const text = snippet(await safeText(response), provider.apiKey);
    const { status } = response;

    if (status === 400) {
      if ('response_format' in body && mentions(text, 'response_format')) {
        quirks.responseFormat = false;
        console.debug('[shelfmark] provider rejected response_format, retrying without it');
        continue;
      }
      if ('temperature' in body && mentions(text, 'temperature')) {
        quirks.temperature = false;
        console.debug('[shelfmark] provider rejected temperature, retrying without it');
        continue;
      }
      if ('max_tokens' in body && mentions(text, 'max_tokens')) {
        quirks.maxTokens = false;
        console.debug('[shelfmark] provider rejected max_tokens, retrying without it');
        continue;
      }
    }

    if ((status === 429 || status >= 500) && backoffs < maxAttempts - 1) {
      const delay = retryBaseMs * 2 ** backoffs;
      backoffs += 1;
      console.debug('[shelfmark] chat retry', { status, attempt: backoffs + 1, delay });
      await sleep(delay, signal);
      continue;
    }

    throw new AiError('http', `HTTP ${status}${text ? `：${text}` : ''}`, { status, detail: text });
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function extractContent(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  if (typeof content === 'string') return content.length > 0 ? content : undefined;
  // 某些兼容实现把 content 拆成 parts
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('');
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

/**
 * 剥掉 ``` / ```json 围栏：从第一个开围栏到**最后一个** ``` 之间的内容（JSON 字符串里出现的 ``` 不会截断）。
 * 没有围栏、或没有闭合围栏时原样 trim；仍解析失败由 `parseJsonLoose` 退到「第一个 { 到最后一个 }」。
 */
export function stripFences(text: string): string {
  const opening = /```[A-Za-z]*[^\S\n]*\n?/.exec(text);
  if (!opening) return text.trim();
  const start = opening.index + opening[0].length;
  const end = text.lastIndexOf('```');
  if (end < start) return text.trim();
  return text.slice(start, end).trim();
}

export function parseJsonLoose(text: string): unknown {
  const stripped = stripFences(text);
  try {
    return JSON.parse(stripped);
  } catch (firstError) {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw firstError;
  }
}

export type ChatJsonArgs<T> = {
  provider: ProviderConfig;
  system: string;
  user: string;
  schema: ZodType<T>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  quirks?: ProviderQuirks;
  retryBaseMs?: number;
  maxAttempts?: number;
  /** 默认 0.2（§11 第 9 条）。 */
  temperature?: number;
};

export const DEFAULT_TEMPERATURE = 0.2;

/**
 * system + user → JSON → zod。剥围栏；校验 / 解析失败重试 1 次并把错误附在 user 后面。
 */
export async function chatJson<T>(args: ChatJsonArgs<T>): Promise<T> {
  const { provider, system, user, schema } = args;
  const quirks = args.quirks ?? createQuirks();
  let userContent = user;

  for (let attempt = 0; ; attempt += 1) {
    const { content } = await chatCompletion({
      provider,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      temperature: args.temperature ?? DEFAULT_TEMPERATURE,
      jsonMode: true,
      fetchImpl: args.fetchImpl,
      signal: args.signal,
      timeoutMs: args.timeoutMs,
      quirks,
      retryBaseMs: args.retryBaseMs,
      maxAttempts: args.maxAttempts,
    });

    let problem: { kind: 'invalid-json' | 'schema'; text: string };
    try {
      const parsed = parseJsonLoose(content);
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
      problem = { kind: 'schema', text: z.prettifyError(result.error) };
    } catch (error) {
      problem = { kind: 'invalid-json', text: error instanceof Error ? error.message : String(error) };
    }

    if (attempt === 0) {
      console.debug('[shelfmark] model output rejected, retrying once', { kind: problem.kind });
      userContent = `${user}\n\n上一次输出未通过校验，请修正后只输出 JSON，不要输出其他内容。校验错误：\n${problem.text}`;
      continue;
    }
    throw new AiError(problem.kind, `模型没返回完整 JSON：${maskSecrets(problem.text, provider.apiKey)}`);
  }
}

/** 注入给 taxonomy / assign / organizer 的 chat 函数：provider、fetch、quirks 都已绑定。 */
export type ChatFn = <T>(args: { system: string; user: string; schema: ZodType<T>; signal?: AbortSignal }) => Promise<T>;

export type ChatClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryBaseMs?: number;
  maxAttempts?: number;
};

/** 把 provider 绑定成 `ChatFn`；同一个 client 内共享 quirks（400 fallback 只付一次）。 */
export function createChatFn(provider: ProviderConfig, options: ChatClientOptions = {}): ChatFn {
  const quirks = createQuirks();
  return (args) => chatJson({ provider, quirks, ...options, ...args });
}

/** 用户点「测试连接」时的 ping（§4）：`{ model, messages:[ping], max_tokens: 4 }`，拒绝 max_tokens / temperature 时自动去掉重试。 */
export async function pingProvider(
  provider: ProviderConfig,
  options: ChatClientOptions & { signal?: AbortSignal; quirks?: ProviderQuirks } = {},
): Promise<CompletionResult> {
  return chatCompletion({
    provider,
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 4,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 20_000,
    // ping 不重试 429 / 5xx，直接把状态报给用户
    maxAttempts: options.maxAttempts ?? 1,
    retryBaseMs: options.retryBaseMs,
    quirks: options.quirks,
  });
}

/** 面向用户的中文文案（§13）。永远不会包含 apiKey（AiError 构造时已打码）。 */
export function describeAiError(error: unknown): string {
  if (error instanceof AiError) {
    switch (error.kind) {
      case 'aborted':
        return '已取消';
      case 'timeout':
        return `请求超时：${error.message}`;
      case 'network':
        return `CORS / 未授权 origin：${error.hint ?? FETCH_FAILED_HINT}（${error.message}）`;
      case 'empty':
      case 'invalid-json':
      case 'schema':
        return error.message.startsWith('模型没返回完整 JSON') ? error.message : `模型没返回完整 JSON：${error.message}`;
      case 'http':
        if (error.status === 401) return `Key 无效（HTTP 401）${error.detail ? `：${error.detail}` : ''}`;
        if (error.status === 403) return `没有权限（HTTP 403）${error.detail ? `：${error.detail}` : ''}`;
        if (error.status === 404) return `接口不存在（HTTP 404）：检查 baseUrl 是否以 /v1 结尾${error.detail ? `。${error.detail}` : ''}`;
        if (error.status === 429) return `限速，请稍后（HTTP 429）${error.detail ? `：${error.detail}` : ''}`;
        if (error.status !== undefined && error.status >= 500) return `服务商错误（HTTP ${error.status}）${error.detail ? `：${error.detail}` : ''}`;
        return error.message;
    }
  }
  if (error instanceof TypeError && /fetch/i.test(error.message)) {
    return `CORS / 未授权 origin：${FETCH_FAILED_HINT}（${error.message}）`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
