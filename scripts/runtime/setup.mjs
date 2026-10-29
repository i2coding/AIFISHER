// 本地替代实现（原版未随公开源码提供）。runtime:setup 的职责是准备源码运行环境：
// 确认 Node 版本、安装 apps/desktop 的 Electron 运行时。首次执行需要联网。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const meta = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const required = String(meta.engines?.node || '').trim();
const current = process.versions.node;

function run(file, args) {
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`命令失败（${result.status}）：${file} ${args.join(' ')}`);
}

if (process.platform !== 'win32') throw new Error('本项目的源码运行环境面向 Windows x64。');
if (current !== required) {
  throw new Error(
    `需要 Node ${required}，当前是 ${current}。请用 npm run runtime:npm -- setup 或在对应版本下执行。`,
  );
}

const electronDir = path.join(root, 'apps', 'desktop', 'node_modules', 'electron');
const electronExe = path.join(electronDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
if (!existsSync(electronDir)) {
  throw new Error('缺少 apps/desktop 依赖，请先执行：npm --prefix apps/desktop ci');
}
if (!existsSync(electronExe)) {
  console.log('[setup] 下载 Electron 运行时（首次需要联网）…');
  run(process.execPath, [path.join(electronDir, 'install.js')]);
}

console.log(`[setup] Node ${current} 就绪`);
console.log(`[setup] Electron ${existsSync(electronExe) ? '就绪' : '缺失'} → ${electronExe}`);
console.log('[setup] 启动源码版：npm run desktop:dev');
