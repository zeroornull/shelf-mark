/**
 * 发送前脱敏（计划 §6.2）。纯函数，无依赖。
 */

export const MAX_URL_LENGTH = 120;
export const MAX_TITLE_LENGTH = 120;
export const MAX_FOLDER_HINT_LENGTH = 80;
const MAX_PATH_SEGMENTS = 3;

/**
 * 去掉 query 和 fragment、用户名密码；路径最多保留前 3 段；总长 ≤ 120。
 * `domainOnly` 时只保留 hostname。
 * 不是合法 URL 的字符串：按文本切掉 `?` / `#` 之后的部分再截断。
 */
export function sanitizeUrl(url: string, domainOnly = false): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    const cut = url.trim().split(/[?#]/, 1)[0] ?? '';
    return truncate(cut, MAX_URL_LENGTH);
  }

  // javascript: / data: 这类没有 host 的 URL，"路径" 就是脚本 / 数据本身，只留协议名
  if (!parsed.host) return parsed.protocol;
  if (domainOnly) return truncate(parsed.hostname, MAX_URL_LENGTH);

  const segments = parsed.pathname.split('/').filter((s) => s !== '').slice(0, MAX_PATH_SEGMENTS);
  const path = segments.length > 0 ? `/${segments.join('/')}` : '';
  // `host` 含端口、不含 userinfo
  return truncate(`${parsed.protocol}//${parsed.host}${path}`, MAX_URL_LENGTH);
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** 邮箱 → `[email]`；压缩空白；长度 ≤ 120。 */
export function redactTitle(title: string): string {
  const redacted = title.replace(EMAIL_RE, '[email]').replace(/\s+/g, ' ').trim();
  return truncate(redacted, MAX_TITLE_LENGTH);
}

/** 各段标题按 title 脱敏后用 `/` 拼接，总长 ≤ 80；空路径返回 undefined。 */
export function redactFolderHint(folderPath: readonly string[] | undefined): string | undefined {
  if (!folderPath || folderPath.length === 0) return undefined;
  const joined = folderPath.map((title) => redactTitle(title)).join('/');
  return truncate(joined, MAX_FOLDER_HINT_LENGTH);
}

function truncate(text: string, max: number): string {
  // 按 code point 截断，避免把 emoji / 生僻字切成半个
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}
