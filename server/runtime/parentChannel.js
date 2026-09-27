// parentChannel.js — 后端与 Electron 主进程的通信通道。
//
// 协议由 apps/desktop/src/backendSupervisor.mjs 定义：
//   后端 → 主进程：{ type: 'ready' }                （就绪通知）
//                    { type: 'access-token-request', id } （请求访问令牌）
//   主进程 → 后端：{ type: 'stop' }                 （要求优雅退出）
//                    { type: 'access-token', id, token }  （令牌响应，token 可为 null）
//
// 后端由 utilityProcess.fork 启动时使用 process.parentPort；
// 以普通 Node 进程独立运行（无父通道）时自动降级为 no-op。

function hasParentPort() {
  return typeof process !== 'undefined' && Boolean(process.parentPort);
}

function hasNodeIpc() {
  return (
    typeof process !== 'undefined' &&
    typeof process.on === 'function' &&
    typeof process.send === 'function'
  );
}

export function createParentChannel() {
  const parentPort = hasParentPort() ? process.parentPort : null;
  const stopListeners = new Set();
  const tokenWaiters = new Map();
  let tokenSequence = 0;

  function send(message) {
    try {
      if (parentPort) {
        parentPort.postMessage(message);
      } else if (hasNodeIpc()) {
        process.send(message);
      }
    } catch {
      // 父进程已退出，忽略发送失败。
    }
  }

  function handleMessage(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    if (payload.type === 'stop') {
      for (const listener of [...stopListeners]) {
        try {
          listener();
        } catch (error) {
          console.error('[parentChannel] stop 监听器执行失败:', error);
        }
      }
    } else if (payload.type === 'access-token' && payload.id !== undefined) {
      const waiter = tokenWaiters.get(payload.id);
      if (waiter) {
        tokenWaiters.delete(payload.id);
        waiter.resolve(payload.token ?? null);
      }
    }
  }

  if (parentPort) {
    parentPort.on('message', (event) => handleMessage(event?.data));
  } else if (hasNodeIpc()) {
    process.on('message', handleMessage);
  }

  return {
    // 通知主进程后端已就绪（backendSupervisor 收到后进入 ready 状态）。
    notifyReady() {
      send({ type: 'ready' });
    },

    // 向主进程请求访问令牌；未配置通道或超时返回 null。
    requestAccessToken(timeoutMs = 30_000) {
      if (!parentPort && !hasNodeIpc()) return Promise.resolve(null);
      const id = ++tokenSequence;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          tokenWaiters.delete(id);
          resolve(null);
        }, timeoutMs);
        tokenWaiters.set(id, {
          resolve: (token) => {
            clearTimeout(timer);
            resolve(token);
          },
        });
        send({ type: 'access-token-request', id });
      });
    },

    // 注册主进程 stop 指令回调，返回取消注册函数。
    onStop(listener) {
      stopListeners.add(listener);
      return () => stopListeners.delete(listener);
    },
  };
}
