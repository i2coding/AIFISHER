import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { redactSensitive } from './redaction.js';

const requestStorage = new AsyncLocalStorage();
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const CONSOLE_MARK = Symbol.for('fisherai.secure-console');

export function getRequestContext() {
  return requestStorage.getStore() || null;
}

function requestContext(request, requestId) {
  const body = request.body && typeof request.body === 'object' ? request.body : {};
  return {
    requestId,
    taskId: body.taskId || body.task?.id || null,
    nodeId: body.nodeId || body.node?.id || null,
    provider: body.provider || body.model?.provider || null,
    method: request.method,
    path: String(request.path || '').slice(0, 500),
  };
}

export function createSecureLogger({ sink = console, onLog = null } = {}) {
  const write = (method, args) => {
    const context = getRequestContext();
    const values = context ? [{ request: context }, ...args] : args;
    const redacted = values.map((value) => redactSensitive(value));
    sink[method](...redacted);
    // 终端面板的内存缓冲：传原始值而不是 redacted —— 面板是"本机用户自己看日志"，
    // 需要用 redactSecretsOnly（去掉 Key/令牌，但**保留路径**）才能真正帮上排错；
    // 而 redacted 已经把所有绝对路径换成了 [PATH]，恢复不回来。
    // sink（stdout/文件/诊断包）那条路仍然走完整脱敏，两者互不影响。
    if (onLog) {
      try {
        onLog(method, values);
      } catch {
        /* 采集失败绝不能影响正常日志输出。 */
      }
    }
  };
  return {
    log: (...args) => write('log', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  };
}

export function createRequestContextMiddleware({
  randomUUID = crypto.randomUUID,
  logger = console,
} = {}) {
  return (request, response, next) => {
    const supplied = String(request.headers['x-request-id'] || '');
    const requestId = REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
    const context = requestContext(request, requestId);
    response.setHeader('X-Request-Id', requestId);
    request.requestId = requestId;
    requestStorage.run(context, () => {
      response.once('finish', () => {
        if (response.statusCode >= 500) {
          logger.error('HTTP request failed', { ...context, status: response.statusCode });
        }
      });
      next();
    });
  };
}

export function installSecureConsole(target = console, options = {}) {
  if (target[CONSOLE_MARK]) return target;
  const originals = {
    log: target.log.bind(target),
    warn: target.warn.bind(target),
    error: target.error.bind(target),
  };
  const secure = createSecureLogger({ sink: originals, onLog: options.onLog });
  target.log = secure.log;
  target.warn = secure.warn;
  target.error = secure.error;
  Object.defineProperty(target, CONSOLE_MARK, { value: true });
  return target;
}
