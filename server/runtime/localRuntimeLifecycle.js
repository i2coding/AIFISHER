// localRuntimeLifecycle.js — 本机后端服务生命周期。
//
// 监听目标由环境决定：
//   - 桌面模式：主进程传入 AIFISHER_BACKEND_PIPE（Windows 命名管道），
//     HTTP 流量通过命名管道由主进程代理（见 apps/desktop/src/appProtocol.mjs）。
//   - 独立/开发模式：监听 127.0.0.1:SERVER_PORT（默认 3001）。

import http from 'node:http';

export function resolveListenTarget() {
  const pipe = String(process.env.AIFISHER_BACKEND_PIPE || '').trim();
  if (pipe) return { path: pipe };
  const configuredPort = Number(process.env.SERVER_PORT || 3001);
  const port = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 3001;
  return { port };
}

export function describeListenTarget(target) {
  if (target?.path) return `named pipe ${target.path}`;
  return `port ${target?.port ?? 3001}`;
}

export function createLocalRuntimeLifecycle({
  app,
  listen,
  workflowStore,
  writeProjectSnapshot,
  codexService,
  canvasExternalService,
  stopOwnedComfy,
}) {
  let server = null;
  let ready = false;
  let stopping = false;

  function listenPromise(target) {
    return new Promise((resolve, reject) => {
      const created = http.createServer(app);
      server = created;
      const cleanup = () => {
        created.removeListener('error', onError);
        created.removeListener('listening', onListening);
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };
      created.once('error', onError);
      created.once('listening', onListening);
      if (target.path) {
        created.listen({ path: target.path });
      } else {
        created.listen(target.port, '127.0.0.1');
      }
    });
  }

  return {
    get ready() {
      return ready;
    },

    async start() {
      if (ready) return true;
      try {
        if (workflowStore && typeof workflowStore.init === 'function') {
          await workflowStore.init();
        }
        await listenPromise(listen);
        ready = true;
        console.log(`[Runtime] Backend listening on ${describeListenTarget(listen)}`);
        return true;
      } catch (error) {
        console.error('[Runtime] 本机服务启动失败:', error);
        ready = false;
        return false;
      }
    },

    async stop() {
      if (stopping) return;
      stopping = true;
      ready = false;
      const current = server;
      server = null;
      if (current) {
        try {
          if (typeof current.closeAllConnections === 'function') {
            current.closeAllConnections();
          } else if (typeof current.closeIdleConnections === 'function') {
            current.closeIdleConnections();
          }
          await new Promise((resolve) => current.close(() => resolve()));
        } catch (error) {
          console.error('[Runtime] 关闭 HTTP 服务失败:', error);
        }
      }
      if (workflowStore && typeof workflowStore.close === 'function') {
        try {
          await workflowStore.close();
        } catch (error) {
          console.error('[Runtime] 关闭 SQLite 失败:', error);
        }
      }
      if (typeof stopOwnedComfy === 'function') {
        try {
          await stopOwnedComfy();
        } catch (error) {
          console.error('[Runtime] 停止本机 ComfyUI 失败:', error);
        }
      }
      console.log('[Runtime] Backend stopped');
    },
  };
}
