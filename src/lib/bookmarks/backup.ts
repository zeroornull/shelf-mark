import type { BookmarkTreeNode } from './api';
import { isManagedNode } from './tree';

/**
 * Netscape Bookmark File 备份（计划 §5.4）。
 *
 * - `renderNetscapeHtml`：纯函数，输入 `getTree()` 的原始结果，输出 Chrome 书签管理器能「导入」的 HTML。
 *   结构对齐 Chrome 自己的导出器：书签栏是带 `PERSONAL_TOOLBAR_FOLDER="true"` 的文件夹（导入时映射回书签栏），
 *   「其他书签」的子节点直接平铺在最外层 `<DL>`，移动书签是普通文件夹；managed 子树整体跳过；标题 / URL 做 HTML 转义。
 * - `downloadBackup`：只碰 DOM（Blob + `<a download>`），扩展页里这样下载不需要 `downloads` 权限。
 *   拆成独立函数是为了让渲染器能在 node 里测试。
 */

const INDENT = '    ';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Chrome 的时间是毫秒，Netscape 格式是秒。 */
function seconds(ms: number | undefined, fallbackMs: number): string {
  const value = ms !== undefined && Number.isFinite(ms) ? ms : fallbackMs;
  return String(Math.floor(value / 1000));
}

function isFolder(node: BookmarkTreeNode): boolean {
  return node.url === undefined;
}

/**
 * `getTree()` 返回 `[不可见树根]`，树根的 children 才是各顶层文件夹；也兼容直接传入顶层文件夹数组。
 */
function topLevelFolders(tree: BookmarkTreeNode[]): BookmarkTreeNode[] {
  const out: BookmarkTreeNode[] = [];
  for (const node of tree) {
    const isInvisibleRoot = node.parentId === undefined && node.folderType === undefined && node.url === undefined;
    if (isInvisibleRoot) out.push(...(node.children ?? []));
    else out.push(node);
  }
  return out;
}

export function renderNetscapeHtml(tree: BookmarkTreeNode[], now: number = Date.now()): string {
  const lines: string[] = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file.',
    '     It will be read and overwritten.',
    '     DO NOT EDIT! -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
  ];

  const writeBookmark = (node: BookmarkTreeNode & { url: string }, depth: number) => {
    const indent = INDENT.repeat(depth);
    lines.push(`${indent}<DT><A HREF="${escapeHtml(node.url)}" ADD_DATE="${seconds(node.dateAdded, now)}">${escapeHtml(node.title)}</A>`);
  };

  const writeChildren = (children: BookmarkTreeNode[] | undefined, depth: number) => {
    for (const child of children ?? []) {
      if (isManagedNode(child)) continue;
      if (child.url !== undefined) writeBookmark(child as BookmarkTreeNode & { url: string }, depth);
      else writeFolder(child, depth, false);
    }
  };

  const writeFolder = (node: BookmarkTreeNode, depth: number, toolbar: boolean) => {
    const indent = INDENT.repeat(depth);
    const added = seconds(node.dateAdded, now);
    const modified = seconds(node.dateGroupModified ?? node.dateAdded, now);
    const toolbarAttr = toolbar ? ' PERSONAL_TOOLBAR_FOLDER="true"' : '';
    lines.push(`${indent}<DT><H3 ADD_DATE="${added}" LAST_MODIFIED="${modified}"${toolbarAttr}>${escapeHtml(node.title)}</H3>`);
    lines.push(`${indent}<DL><p>`);
    writeChildren(node.children, depth + 1);
    lines.push(`${indent}</DL><p>`);
  };

  for (const top of topLevelFolders(tree)) {
    if (isManagedNode(top)) continue;
    if (!isFolder(top)) {
      writeBookmark(top as BookmarkTreeNode & { url: string }, 1);
      continue;
    }
    if (top.folderType === 'other') {
      // 与 Chrome 导出器一致：「其他书签」的内容直接平铺在最外层
      writeChildren(top.children, 1);
      continue;
    }
    writeFolder(top, 1, top.folderType === 'bookmarks-bar');
  }

  lines.push('</DL><p>', '');
  return lines.join('\n');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `shelfmark-backup-YYYYMMDD-HHmm.html`（本地时间）。 */
export function backupFileName(now: number | Date = Date.now()): string {
  const d = now instanceof Date ? now : new Date(now);
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  return `shelfmark-backup-${stamp}.html`;
}

/**
 * 触发浏览器下载。Blob URL 在点击后延迟释放：下载请求一发出就不再依赖它，
 * 但立刻 revoke 在个别情况下会让下载拿到空内容。
 */
export function downloadBackup(html: string, fileName: string, doc: Document = document): void {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  doc.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
