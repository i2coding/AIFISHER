// backendLifecycleDiagnostics.js — 后端生命周期诊断。
//
// 记录服务启动、关闭请求等生命周期事件到日志目录，便于定位
// “本机服务未能启动 / 自动重启”等桌面运行时问题。

import fs from 'node:fs';
import path from 'node:path';

export function installBackendLifecycleDiagnostics({ logsDirectory } = {}) {
  const logFile = path.join(String(logsDirectory || '.'), 'backend-lifecycle.log');

  function append(line) {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`, { encoding: 'utf8' });
    } catch {
      // 日志写入失败不影响服务运行。
    }
  }

  append('runtime started');

  return {
    // 记录一次关闭请求（internal-request / desktop-stop / controller-exited / signal）。
    shutdownRequested(reason) {
      append(`shutdown requested: ${String(reason ?? 'unknown')}`);
    },

    // 供诊断页读取最近生命周期事件的辅助（非必须接口，保留以便扩展）。
    logFile,
  };
}
