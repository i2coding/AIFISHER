/**
 * 日志自动采集：把那些"平时一闪而过、出问题才发现没有"的报错沉淀到日志总线。
 *
 * 三个来源：
 *  1. fetch —— 所有请求失败（4xx/5xx/网络中断）都记一条。生成失败、保存失败最常见的
 *     真相就在这里，而界面上通常只弹一个 toast 就消失了；
 *  2. 未捕获异常 / 未处理的 Promise rejection —— 前端崩溃、组件抛错；
 *  3. console.error / console.warn —— 库和框架层面打出来的错误。
 *
 * 三条硬约束（改这块务必保住）：
 *  - **绝不改变原行为**：包装后的 fetch 必须原样返回原 Response、原样抛出原异常；
 *    读错误体只能用 clone()，而且要有超时 —— 流式响应的 body 读一次就没了。
 *  - **用户主动取消不算错误**：AbortError 记 debug，否则每次切页面都会刷一片红。
 *  - **防递归**：面板自己出错会走 console.error，用 logging 标记挡住。
 */
import { logBus } from './logBus';

let installed = false;
let logging = false;

const MAX_CONSOLE_MESSAGE = 3000;

/** 把任意错误值转成一句话；带堆栈首行的位置信息，但控制长度。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const frame = error.stack?.split('\n')[1]?.trim();
    const suffix = frame && !error.message.includes(frame) ? ` (${frame})` : '';
    return `${error.name}: ${error.message}${suffix}`.slice(0, 1200);
  }
  if (typeof error === 'string') return error.slice(0, 1200);
  try {
    return JSON.stringify(error).slice(0, 1200);
  } catch {
    return String(error).slice(0, 1200);
  }
}

/** 从响应体里挖出最有信息量的一句（优先 error/message 字段），失败则给原文片段。 */
function summarizeBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      for (const key of ['error', 'message', 'detail', 'reason']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 600);
        if (value && typeof value === 'object') {
          const nested = (value as Record<string, unknown>).message;
          if (typeof nested === 'string' && nested.trim()) return nested.trim().slice(0, 600);
        }
      }
      return trimmed.slice(0, 400);
    }
  } catch {
    /* 不是 JSON（HTML 错误页、纯文本）就走原文。 */
  }
  return trimmed.replace(/\s+/g, ' ').slice(0, 400);
}

async function readFailureBody(response: Response): Promise<string> {
  // 流式响应（SSE）的 body 是一次性的，clone 后读会一直等不到结尾，直接放弃。
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) return '';
  try {
    // clone 之后再读：原响应体必须留给业务代码。流式响应若长时间不给数据，超时放弃。
    const text = await Promise.race([
      response.clone().text(),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 2000)),
    ]);
    return summarizeBody(text);
  } catch {
    return '';
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input && typeof input === 'object' && 'url' in input) return String(input.url);
  return '';
}

/** 只报路径，去掉查询串：查询里常有 key、签名，面板里也没必要看。 */
function shortPath(url: string): string {
  try {
    return new URL(url, window.location.origin).pathname;
  } catch {
    return url.slice(0, 200);
  }
}

function installFetchCapture() {
  const originalFetch = window.fetch;
  if (typeof originalFetch !== 'function') return;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let response: Response;
    try {
      response = await originalFetch.call(window, input, init);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const path = shortPath(requestUrl(input));
      if (name === 'AbortError') logBus.debug(`请求已取消 ${path}`, 'net');
      else logBus.error(`请求未送达 ${path}：${describeError(error)}`, 'net');
      throw error;
    }
    if (!response.ok) {
      const detail = await readFailureBody(response);
      const line = `${response.status} ${shortPath(requestUrl(input))}${detail ? ` → ${detail}` : ''}`;
      // 5xx 是服务端/上游真出问题；4xx 多半是参数或权限问题，标 warn 免得淹没真正的错误。
      if (response.status >= 500) logBus.error(line, 'net');
      else logBus.warn(line, 'net');
    }
    return response;
  };
}

function installGlobalErrorCapture() {
  window.addEventListener('error', (event) => {
    // 资源加载失败（img/script 404）也会触发 error，但没有 error 对象，没信息量。
    if (!event.error) return;
    logBus.error(describeError(event.error), 'runtime');
  });
  window.addEventListener('unhandledrejection', (event) => {
    logBus.error(`未处理的 Promise 拒绝：${describeError(event.reason)}`, 'runtime');
  });
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === 'string') return value;
      if (value instanceof Error) return describeError(value);
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(' ')
    .slice(0, MAX_CONSOLE_MESSAGE);
}

function installConsoleCapture() {
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    originalError(...args);
    if (logging) return;
    logging = true;
    try {
      logBus.error(formatConsoleArgs(args), 'console');
    } finally {
      logging = false;
    }
  };

  console.warn = (...args: unknown[]) => {
    originalWarn(...args);
    if (logging) return;
    logging = true;
    try {
      logBus.warn(formatConsoleArgs(args), 'console');
    } finally {
      logging = false;
    }
  };
}

/** 幂等：重复调用只装一次（StrictMode 下 effect 会跑两遍）。 */
export function installLogCapture() {
  if (installed) return;
  installed = true;
  installFetchCapture();
  installGlobalErrorCapture();
  installConsoleCapture();
}
