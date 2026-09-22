#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { printDevHint } from './print-ext-path.mjs';

await printDevHint();
const child = spawn('pnpm', ['exec', 'wxt', ...process.argv.slice(2)], {
  stdio: 'inherit',
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
