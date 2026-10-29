// 本地替代实现。公开源码快照未附带作者原版的 scripts/runtime/run.mjs，
// 该脚本的职责是把 package.json 里的命令交给 engines.node 指定的 Node 执行，
// 因为 vite.stable.config.ts 会硬校验 Node 版本，npm 自带的 Node 不一定是 24.20.0。
//
// 用法与原版一致：
//   node scripts/runtime/run.mjs <脚本或二进制> [参数...]
//   node scripts/runtime/run.mjs --check      仅报告选中的 Node 与关键路径
//   node scripts/runtime/run.mjs --npm <...>  用选中的 Node 执行 npm
//
// 查找顺序：AIFISHER_NODE（绝对路径）→ 当前 Node（版本匹配时）→
// AIFISHER_NODE_DIRS 里的目录 → 常见安装根目录下的一层子目录。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const meta = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const required = String(meta.engines?.node || '').trim();
if (!required) throw new Error('package.json 缺少 engines.node，无法确定构建用 Node。');

const exeName = process.platform === 'win32' ? 'node.exe' : 'node';

function probe(candidate) {
  if (!candidate || !existsSync(candidate)) return null;
  const result = spawnSync(candidate, ['-v'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return { path: candidate, version: String(result.stdout || '').trim().replace(/^v/, '') };
}

function searchRoots() {
  const roots = [];
  const extra = String(process.env.AIFISHER_NODE_DIRS || '')
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  roots.push(...extra);
  roots.push(path.join(os.homedir(), '.workbuddy', 'binaries', 'node', 'versions'));
  roots.push(path.join(os.homedir(), '.nvm', 'versions', 'node'));
  if (process.platform === 'win32') {
    roots.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs'));
    roots.push(path.join(process.env.LOCALAPPDATA || '', 'nvm'));
    roots.push('D:\\environment');
  }
  return roots;
}

function candidates() {
  const direct = [process.env.AIFISHER_NODE, path.join(path.dirname(process.execPath), exeName)];
  const nested = [];
  for (const base of searchRoots()) {
    if (!base || !existsSync(base)) continue;
    let entries = [];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // 版本子目录的常见形态：v24.20.0 / 24.20.0-6 / node-v24.20.0 / nodejs
      if (!/\d+\.\d+\.\d+/.test(entry.name) && entry.name !== 'nodejs') continue;
      for (const relative of [exeName, path.join('bin', exeName)]) {
        const exe = path.join(base, entry.name, relative);
        if (existsSync(exe)) nested.push(exe);
      }
    }
    const directExe = path.join(base, exeName);
    if (existsSync(directExe)) nested.push(directExe);
  }
  return [...direct, ...nested.filter(Boolean)];
}

function resolveNode() {
  const seen = new Set();
  const rejected = [];
  for (const candidate of candidates()) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const found = probe(candidate);
    if (!found) continue;
    if (found.version === required) return { node: candidate, version: found.version };
    rejected.push(`${candidate} (${found.version})`);
  }
  const hint = rejected.length ? `\n已检查但版本不符：\n  ${rejected.join('\n  ')}` : '';
  throw new Error(
    `需要 Node ${required}，未在本机找到。请安装该版本，或用 AIFISHER_NODE 指向 node.exe。${hint}`,
  );
}

const args = process.argv.slice(2);
if (args.length === 0) {
  throw new Error('用法：node scripts/runtime/run.mjs <脚本> [参数...]（或 --check / --npm）');
}

const { node, version } = resolveNode();
if (!meta.engines?.node || version !== required) throw new Error('Node 版本校验失败。');

if (args[0] === '--check') {
  const checks = [
    ['dist/index.html', path.join(root, 'dist', 'index.html')],
    ['apps/desktop/src/main.mjs', path.join(root, 'apps', 'desktop', 'src', 'main.mjs')],
    ['electron', path.join(root, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe')],
    ['vite', path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')],
  ];
  console.log(`Node ${version} → ${node}`);
  for (const [label, target] of checks) {
    console.log(`  ${existsSync(target) ? 'ok  ' : '缺失'} ${label}`);
  }
  process.exit(0);
}

function npmCliPath() {
  const base = path.dirname(node);
  const candidatesList = [
    path.join(base, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(base, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(base, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidatesList.find((candidate) => existsSync(candidate)) || null;
}

let command = node;
let commandArgs = args;
if (args[0] === '--npm') {
  const cli = npmCliPath();
  if (!cli) throw new Error(`未在 ${path.dirname(node)} 附近找到 npm-cli.js。`);
  commandArgs = [cli, ...args.slice(1)];
} else if (!existsSync(path.join(root, args[0]))) {
  throw new Error(`目标不存在：${args[0]}`);
}

const child = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit' });
if (child.error) throw child.error;
process.exit(child.status ?? 1);
