#!/usr/bin/env node
/**
 * WSL 里 WXT 不会自动打开 Chrome。打印一次加载路径，并把 UNC 路径复制到剪贴板。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.output', 'chrome-mv3-dev');

function windowsUncPath(linuxPath) {
  const distro = process.env.WSL_DISTRO_NAME;
  if (!distro) return null;
  return `\\\\wsl.localhost\\${distro}${linuxPath.replaceAll('/', '\\')}`;
}

function runDetached(command, args, stdinText) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: stdinText === undefined ? 'ignore' : ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
    if (stdinText !== undefined) child.stdin.end(stdinText);
  });
}

async function copyToClipboard(text) {
  return runDetached('clip.exe', [], text);
}

async function openInExplorer(unc) {
  // explorer.exe 即使打开成功也常返回 1
  const child = spawn('explorer.exe', [unc], { stdio: 'ignore', detached: true });
  child.unref();
  return new Promise((resolve) => {
    child.on('error', () => resolve(false));
    child.on('spawn', () => resolve(true));
  });
}

export async function printDevHint(options = {}) {
  const unc = windowsUncPath(outDir);
  console.log('');
  console.log('── 验收不用每次 build ──');
  console.log('保持 pnpm dev 运行。改 Vue / CSS 会热更新；改 background / manifest 后到 chrome://extensions 点一下刷新。');
  if (unc) {
    console.log('');
    console.log('WSL 不会自动打开 Chrome（那条 WARN 可以忽略）。在 Windows Chrome 里：');
    console.log('  1. 打开 chrome://extensions');
    console.log('  2. 打开「开发者模式」→「加载已解压的扩展程序」');
    console.log(`  3. 选这个目录：`);
    console.log(`     ${unc}`);
    console.log('不要加载 chrome-mv3（那是 pnpm build 的产物）。');
    if (await copyToClipboard(unc)) console.log('路径已复制到剪贴板。');
    if (options.open) {
      const ok = await openInExplorer(unc);
      console.log(ok ? '已用资源管理器打开该目录。' : '无法打开资源管理器，请手动粘贴上面的路径。');
    } else {
      console.log('也可以跑 pnpm ext:open，用资源管理器打开这个目录。');
    }
  } else {
    console.log(`加载目录：${outDir}`);
  }
  console.log('');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await printDevHint({ open: process.argv.includes('--open') });
}
