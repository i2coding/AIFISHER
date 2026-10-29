/**
 * 终端日志总线。
 *
 * 任意模块都可以写日志，终端面板订阅显示（见 dialogs/canvasTerminal.tsx）。
 * 项目里没有 zustand，所以用模块级快照 + 订阅实现：写日志不依赖 React，
 * 组件侧用 useState + useEffect 订阅即可。
 *
 * 设计要点（参考 T8-penguin-canvas 的 logs store）：
 * - 环形缓冲：内存只留最近 500 条，避免长时间运行吃内存；
 * - 持久化：最近 300 条写入 localStorage，**落盘前脱敏**（Key、Token、URL 查询串），
 *   这样重启后仍能回看上次的报错，而浏览器存储里不会留下凭据；
 * - 未读计数：面板关闭时的新增条数，顶部按钮上显示角标；
 * - 单条消息长度上限 4000 字符，超长截断（避免一坨 HTML 或堆栈把面板撑爆）。
 */

export type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';
export type LogChannel = 'frontend' | 'backend';

export interface LogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  channel: LogChannel;
  /** 来源标签：模块名或节点类型，如「生成」「画布同步」「net」。 */
  source?: string;
  message: string;
}

export interface LogSnapshot {
  entries: readonly LogEntry[];
  open: boolean;
  unread: number;
  /** 面板关闭期间新增的 error 条数，用来给顶部按钮加红点。 */
  errorUnread: number;
  revision: number;
}

const MAX_ENTRIES = 500;
const MAX_PERSISTED = 300;
const MAX_MESSAGE_LENGTH = 4000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'fisherai.terminal.logs.v1';
const LEVELS = new Set<LogLevel>(['info', 'success', 'warn', 'error', 'debug']);

const listeners = new Set<() => void>();
let entries: LogEntry[] = [];
let open = false;
let unread = 0;
let errorUnread = 0;
let revision = 0;
let snapshot: LogSnapshot = { entries, open, unread, errorUnread, revision };
let sequence = 0;
let emitScheduled = false;
let persistTimer: number | null = null;

function flushListeners() {
  emitScheduled = false;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* 订阅方自己出错不能影响写日志。 */
    }
  }
}

/**
 * 通知订阅者。合并到下一帧：console 警告刷屏时一次渲染只处理一批，
 * 否则每条日志都触发一次 500 行的重新渲染，面板会直接把主线程拖死。
 */
function emit() {
  revision += 1;
  snapshot = { entries, open, unread, errorUnread, revision };
  if (emitScheduled) return;
  emitScheduled = true;
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(flushListeners);
  } else {
    flushListeners();
  }
}

/** 持久化同理：1 秒内的多次写入只落盘一次（每次全量序列化 300 条并不便宜）。 */
function schedulePersist() {
  if (typeof window === 'undefined') return;
  if (persistTimer !== null) return;
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persist();
  }, 1000);
}

/**
 * 只用于持久化的脱敏。内存里的原文保留，方便在面板里直接排错。
 */
export function redactForStorage(message: unknown): string {
  let text = String(message ?? '');
  text = text.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, '$1[redacted]');
  text = text.replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}/gi, '[redacted-key]');
  text = text.replace(
    /((?:api[_-]?key|access[_-]?token|token|secret|signature|authorization)["']?\s*[:=]\s*["']?)([^"'\s,;}]+)/gi,
    '$1[redacted]',
  );
  // URL 上的签名/令牌参数同样不该落盘，但保留路径方便定位。
  text = text.replace(/(https?:\/\/[^\s"'`?]+)\?[^\s"'`]*/gi, '$1?[redacted]');
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…[truncated]` : text;
}

function normalizeEntry(value: unknown, index: number, now: number): LogEntry | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<LogEntry>;
  const ts = Math.trunc(Number(record.ts));
  if (!Number.isSafeInteger(ts) || ts < now - RETENTION_MS || ts > now + 60_000) return null;
  if (!LEVELS.has(record.level as LogLevel) || typeof record.message !== 'string') return null;
  const channel: LogChannel = record.channel === 'backend' ? 'backend' : 'frontend';
  return {
    id: typeof record.id === 'string' && record.id ? record.id.slice(0, 80) : `restored_${index}`,
    ts,
    level: record.level as LogLevel,
    channel,
    ...(typeof record.source === 'string' && record.source
      ? { source: record.source.slice(0, 80) }
      : {}),
    message: redactForStorage(record.message),
  };
}

function restore() {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [];
    const now = Date.now();
    entries = list
      .slice(-MAX_PERSISTED)
      .map((item, index) => normalizeEntry(item, index, now))
      .filter((item): item is LogEntry => item !== null);
  } catch {
    /* 存储被禁用或格式损坏时，直接从空日志开始。 */
  }
}

function persist() {
  if (typeof window === 'undefined') return;
  try {
    const payload = entries.slice(-MAX_PERSISTED).map((entry) => ({
      ...entry,
      message: redactForStorage(entry.message),
    }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* 隐私模式或配额满：只在本次会话内保留。 */
  }
}

/**
 * 写入一条日志。channel 默认 frontend；后端日志由面板拉取后单独渲染，
 * 这里留出参数是为了让面板能把后端行也塞进同一条时间线（暂未使用）。
 */
export function writeLog(
  level: LogLevel,
  message: unknown,
  source?: string,
  channel: LogChannel = 'frontend',
) {
  const text = String(message ?? '');
  sequence += 1;
  const entry: LogEntry = {
    id: `${Date.now().toString(36)}_${sequence.toString(36)}`,
    ts: Date.now(),
    level,
    channel,
    ...(source ? { source } : {}),
    message: text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text,
  };
  entries = [...entries, entry];
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  if (!open) {
    unread = Math.min(99, unread + 1);
    if (level === 'error') errorUnread = Math.min(99, errorUnread + 1);
  }
  emit();
  schedulePersist();
}

export function clearLogs() {
  entries = [];
  unread = 0;
  errorUnread = 0;
  emit();
  persist();
}

export function setTerminalOpen(value: boolean) {
  open = value;
  if (value) {
    unread = 0;
    errorUnread = 0;
  }
  emit();
}

export function toggleTerminal() {
  setTerminalOpen(!open);
}

export function subscribeLogs(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLogSnapshot(): LogSnapshot {
  return snapshot;
}

export function isTerminalOpen() {
  return open;
}

/** 面板「复制」「下载」用：带时间戳的纯文本，最近的在最后。 */
export function formatLogsAsText(list: readonly LogEntry[] = entries): string {
  return list
    .map((entry) => {
      const date = new Date(entry.ts);
      const time = `${date.toISOString().slice(11, 23)}`;
      const source = entry.source ? ` [${entry.source}]` : '';
      return `${time} ${entry.level.toUpperCase().padEnd(7)}${source} ${entry.message}`;
    })
    .join('\n');
}

export const logBus = {
  info: (message: unknown, source?: string) => writeLog('info', message, source),
  success: (message: unknown, source?: string) => writeLog('success', message, source),
  warn: (message: unknown, source?: string) => writeLog('warn', message, source),
  error: (message: unknown, source?: string) => writeLog('error', message, source),
  debug: (message: unknown, source?: string) => writeLog('debug', message, source),
};

// 模块加载时恢复上次会话的日志（脱敏后的副本）。
restore();

// 关窗/刷新时把还没落盘的那一批补上，否则最后 1 秒的日志会丢。
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (persistTimer !== null) {
      window.clearTimeout(persistTimer);
      persistTimer = null;
    }
    persist();
  });
}
