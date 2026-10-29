/**
 * 后端日志环形缓冲。
 *
 * 为什么需要它：后端日志本来就落在 logs/*.log 里，但那是纯文本、无级别、只能读文件尾部。
 * 终端面板想看到「刚刚这条 error」时，读文件既慢又分不清 stdout/stderr 的先后。
 * 这里在内存里留最近 N 条，按写入顺序、带级别、带时间戳，面板直接取。
 *
 * 脱敏策略用 redactSecretsOnly：去掉 API Key / 令牌 / 本机用户名，但保留绝对路径。
 * 这里的数据只经回环地址给本机用户自己看，路径正是"文件找不到""模型缺失"这类问题
 * 最需要的信息；而对外分享用的诊断包走的是 redactSensitive（路径也会被抹掉）。
 * 缓冲是纯内存的，进程重启即清空；文件日志仍然完整保留，重启前的历史从文件读。
 */

import { redactSecretsOnly } from '../security/redaction.js';

const DEFAULT_MAX = 300;
const MAX_MESSAGE = 2000;

function formatValue(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return String(value);
  try {
    const text = JSON.stringify(value);
    return text ?? String(value);
  } catch {
    return String(value);
  }
}

/** console 的方法名 → 面板里的级别。 */
function levelOf(method) {
  if (method === 'error') return 'error';
  if (method === 'warn') return 'warn';
  return 'info';
}

export function createLogRingBuffer(max = DEFAULT_MAX) {
  const entries = [];

  return {
    push(method, values) {
      const joined = (Array.isArray(values) ? values : [values]).map(formatValue).join(' ');
      const clipped = joined.length > MAX_MESSAGE ? `${joined.slice(0, MAX_MESSAGE)}…` : joined;
      const message = redactSecretsOnly(clipped);
      entries.push({ ts: Date.now(), level: levelOf(method), message });
      if (entries.length > max) entries.splice(0, entries.length - max);
    },
    list() {
      return entries.slice();
    },
  };
}
