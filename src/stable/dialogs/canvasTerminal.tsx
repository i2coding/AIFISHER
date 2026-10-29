import type { CanvasComponent } from '../app/canvasComponentType';
import type * as ReactTypes from 'react';
import {
  clearLogs,
  formatLogsAsText,
  getLogSnapshot,
  setTerminalOpen,
  subscribeLogs,
  type LogLevel,
} from '../diagnostics/logBus';

type Runtime = Pick<
  typeof ReactTypes,
  | 'createElement'
  | 'Fragment'
  | 'useState'
  | 'useRef'
  | 'useEffect'
  | 'useMemo'
  | 'useCallback'
>;

type Props = Record<string, unknown>;

interface Components {
  TerminalIcon: CanvasComponent;
  CloseIcon: CanvasComponent;
  TrashIcon: CanvasComponent;
  CopyIcon: CanvasComponent;
  DownloadIcon: CanvasComponent;
  SearchIcon: CanvasComponent;
  RefreshIcon: CanvasComponent;
}

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'success', 'debug'];
const LEVEL_LABELS: Record<LogLevel | 'all', string> = {
  all: '全部',
  error: '错误',
  warn: '警告',
  info: '信息',
  success: '成功',
  debug: '调试',
};
const LEVEL_STYLE: Record<LogLevel, { color: string; background: string }> = {
  error: { color: 'var(--af-danger)', background: 'var(--af-danger-bg)' },
  warn: { color: 'var(--af-warning)', background: 'var(--af-warning-bg)' },
  info: { color: 'var(--af-info)', background: 'var(--af-info-bg)' },
  success: { color: 'var(--af-success)', background: 'var(--af-success-bg)' },
  debug: { color: 'var(--af-text-muted)', background: 'transparent' },
};

/** 后端日志是纯文本行，按关键字猜级别，够用且不需要改 server 的输出格式。 */
const BACKEND_LEVEL_STYLE = {
  error: LEVEL_STYLE.error,
  warn: LEVEL_STYLE.warn,
  info: { color: 'var(--af-text-secondary)', background: 'transparent' },
} as const;

type BackendLevel = keyof typeof BACKEND_LEVEL_STYLE;

interface BackendLine {
  key: string;
  level: BackendLevel;
  text: string;
  /** 内存环返回的条目带真实时间；从日志文件读出来的行没有。 */
  ts?: number;
}

function classifyBackendLine(text: string): BackendLevel {
  if (/\b(error|failed|failure|exception|uncaught|unhandled|fatal)\b/i.test(text)) return 'error';
  if (/\b(warn|warning|deprecat)/i.test(text)) return 'warn';
  return 'info';
}

function pad2(value: number) {
  return value < 10 ? `0${value}` : String(value);
}

function formatTime(ts: number) {
  const date = new Date(ts);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${String(
    date.getMilliseconds(),
  ).padStart(3, '0')}`;
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || target.isContentEditable;
}

export function CanvasTerminal(React: Runtime, _props: Props, components: Components) {
  const {
    TerminalIcon,
    CloseIcon,
    TrashIcon,
    CopyIcon,
    DownloadIcon,
    SearchIcon,
    RefreshIcon,
  } = components;

  const [state, setState] = React.useState(() => getLogSnapshot());
  React.useEffect(() => {
    setState(getLogSnapshot());
    return subscribeLogs(() => setState(getLogSnapshot()));
  }, []);

  const [tab, setTab] = React.useState<'frontend' | 'backend'>('frontend');
  const [level, setLevel] = React.useState<LogLevel | 'all'>('all');
  const [query, setQuery] = React.useState('');
  const [follow, setFollow] = React.useState(true);
  const [height, setHeight] = React.useState(() =>
    Math.min(320, Math.round((typeof window === 'undefined' ? 800 : window.innerHeight) * 0.45)),
  );
  const [backendLines, setBackendLines] = React.useState<BackendLine[]>([]);
  const [backendNote, setBackendNote] = React.useState('');
  const [copied, setCopied] = React.useState('');
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const failedRef = React.useRef(false);

  const { open, entries } = state;

  const filtered = React.useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (level !== 'all' && entry.level !== level) return false;
      if (!keyword) return true;
      return `${entry.source ?? ''} ${entry.message}`.toLowerCase().includes(keyword);
    });
  }, [entries, level, query]);

  const visibleBackend = React.useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return backendLines;
    return backendLines.filter((line) => line.text.toLowerCase().includes(keyword));
  }, [backendLines, query]);

  const loadBackend = React.useCallback(async () => {
    if (failedRef.current) return;
    try {
      const response = await fetch('/api/diagnostics/logs?tail=200', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: unknown = await response.json();
      const payload = (data ?? {}) as { entries?: unknown; lines?: unknown };
      if (Array.isArray(payload.entries) && payload.entries.length > 0) {
        // 实时日志：后端已经给了级别和时间，直接用，不用再猜。
        setBackendLines(
          payload.entries.map((item, index) => {
            const record = (item ?? {}) as { ts?: unknown; level?: unknown; message?: unknown };
            const text =
              typeof record.message === 'string' ? record.message : String(item ?? '');
            const level: BackendLevel =
              record.level === 'error' || record.level === 'warn'
                ? record.level
                : classifyBackendLine(text);
            const ts = Number(record.ts);
            return {
              key: `live_${index}_${Number.isFinite(ts) ? ts : ''}`,
              level,
              text,
              ...(Number.isFinite(ts) ? { ts } : {}),
            };
          }),
        );
      } else if (Array.isArray(payload.lines)) {
        // 回退：文件尾部是纯文本，只能按关键字猜级别。
        setBackendLines(
          payload.lines
            .filter((line): line is string => typeof line === 'string')
            .map((text, index) => ({
              key: `file_${index}_${text.slice(0, 24)}`,
              level: classifyBackendLine(text),
              text,
            })),
        );
      } else {
        throw new Error('返回格式不正确');
      }
      setBackendNote('');
    } catch (error) {
      // 失败就停轮询，避免每 3 秒往日志里刷一条（这条请求本身会被 fetch 捕获器记录）。
      failedRef.current = true;
      setBackendNote(
        `无法读取后端日志：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, []);

  // 只在后端 tab 可见时轮询：前端日志由总线推送，不需要拉。
  React.useEffect(() => {
    if (!open || tab !== 'backend') return;
    void loadBackend();
    const timer = window.setInterval(() => void loadBackend(), 3000);
    return () => window.clearInterval(timer);
  }, [open, tab, loadBackend]);

  // 自动滚到底（可关闭，方便回看历史）。
  React.useEffect(() => {
    if (!open || !follow) return;
    const element = bodyRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [open, follow, filtered.length, visibleBackend.length, tab, state.revision]);

  // ESC 关闭；输入框里按 ESC 不动（避免和搜索/重命名冲突）。
  // 用冒泡阶段而不是捕获：上层弹窗如果已经处理过 ESC（preventDefault），就不该再关终端，
  // 否则按一次 ESC 会连弹窗一起关掉。
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTypingTarget(event.target)) return;
      setTerminalOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // 拖动面板顶边调整高度：日志多的时候需要能拉大。
  const resizeRef = React.useRef<{ startY: number; startHeight: number } | null>(null);
  const startResize = (event: ReactTypes.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = { startY: event.clientY, startHeight: height };
    const move = (moveEvent: PointerEvent) => {
      const current = resizeRef.current;
      if (!current) return;
      const next = current.startHeight + (current.startY - moveEvent.clientY);
      setHeight(Math.min(Math.max(next, 160), Math.round(window.innerHeight * 0.8)));
    };
    const finish = () => {
      resizeRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  if (!open) return null;

  const copyAll = async () => {
    const text =
      tab === 'backend'
        ? visibleBackend.map((line) => line.text).join('\n')
        : formatLogsAsText(filtered);
    try {
      await navigator.clipboard.writeText(text || '(空)');
      setCopied('已复制');
      window.setTimeout(() => setCopied(''), 1600);
    } catch {
      setCopied('复制失败');
      window.setTimeout(() => setCopied(''), 1600);
    }
  };

  const download = () => {
    const text =
      tab === 'backend'
        ? visibleBackend.map((line) => line.text).join('\n')
        : formatLogsAsText(filtered);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const blob = new Blob([text || '(空)'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `aifisher-${tab}-logs-${stamp}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const tabButton = (value: 'frontend' | 'backend', label: string, count: number) =>
    React.createElement(
      'button',
      {
        key: value,
        type: 'button',
        onClick: () => setTab(value),
        className: `h-6 px-2 rounded-md text-[11px] transition-colors ${
          tab === value
            ? 'bg-[var(--af-selected)] text-[var(--af-on-selected)]'
            : 'text-[var(--af-text-muted)] hover:bg-[var(--af-hover)]'
        }`,
      },
      `${label} ${count}`,
    );

  const iconButton = (
    key: string,
    label: string,
    icon: CanvasComponent,
    onClick: () => void,
  ) =>
    React.createElement(
      'button',
      {
        key,
        type: 'button',
        title: label,
        'aria-label': label,
        onClick,
        className:
          'w-6 h-6 flex items-center justify-center rounded-md text-[var(--af-text-muted)] hover:text-[var(--af-text)] hover:bg-[var(--af-hover)] transition-colors',
      },
      React.createElement(icon, { size: 13 }),
    );

  return React.createElement(
    'div',
    {
      className: 'fixed left-3 right-3 bottom-3 z-[150] flex flex-col',
      style: { height },
    },
    React.createElement(
      'div',
      {
        className:
          'flex-1 min-h-0 flex flex-col rounded-xl overflow-hidden border border-[var(--af-border)] bg-[var(--af-surface)] shadow-2xl',
      },
      // 顶边拖拽条
      React.createElement('div', {
        key: 'resize',
        onPointerDown: startResize,
        title: '拖动调整高度',
        className: 'h-1.5 shrink-0 cursor-ns-resize bg-transparent hover:bg-[var(--af-hover)]',
      }),
      // 工具条
      React.createElement(
        'div',
        {
          key: 'bar',
          className:
            'shrink-0 flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--af-border)] bg-[var(--af-surface-raised)]',
        },
        React.createElement(TerminalIcon, {
          size: 14,
          className: 'text-[var(--af-info)] shrink-0',
        }),
        React.createElement(
          'span',
          { className: 'text-[12px] font-semibold text-[var(--af-text)] shrink-0' },
          '终端',
        ),
        React.createElement(
          'div',
          { className: 'flex items-center gap-0.5 shrink-0' },
          tabButton('frontend', '前端', entries.length),
          tabButton('backend', '后端', backendLines.length),
        ),
        React.createElement('div', {
          className: 'w-px h-4 bg-[var(--af-border)] shrink-0',
        }),
        // 级别筛选
        React.createElement(
          'div',
          { className: 'flex items-center gap-0.5 shrink-0' },
          (['all', ...LEVELS] as Array<LogLevel | 'all'>).map((value) =>
            React.createElement(
              'button',
              {
                key: value,
                type: 'button',
                onClick: () => setLevel(value),
                className: `h-6 px-1.5 rounded-md text-[11px] transition-colors ${
                  level === value
                    ? 'bg-[var(--af-selected)] text-[var(--af-on-selected)]'
                    : 'text-[var(--af-text-muted)] hover:bg-[var(--af-hover)]'
                }`,
              },
              LEVEL_LABELS[value],
            ),
          ),
        ),
        // 搜索
        React.createElement(
          'label',
          {
            key: 'search',
            className:
              'flex items-center gap-1 h-6 px-1.5 rounded-md border border-[var(--af-border)] bg-[var(--af-input)] min-w-0 flex-1',
          },
          React.createElement(SearchIcon, { size: 11, className: 'text-[var(--af-text-muted)]' }),
          React.createElement('input', {
            value: query,
            onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) =>
              setQuery(event.target.value),
            placeholder: '搜索日志…',
            className:
              'flex-1 min-w-0 bg-transparent text-[11px] text-[var(--af-text)] outline-none placeholder:text-[var(--af-text-muted)]',
          }),
        ),
        copied
          ? React.createElement(
              'span',
              { key: 'copied', className: 'text-[10px] text-[var(--af-success)] shrink-0' },
              copied,
            )
          : null,
        React.createElement(
          'label',
          {
            key: 'follow',
            className:
              'flex items-center gap-1 text-[10px] text-[var(--af-text-muted)] shrink-0 cursor-pointer select-none',
          },
          React.createElement('input', {
            type: 'checkbox',
            checked: follow,
            onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) =>
              setFollow(event.target.checked),
          }),
          '跟随',
        ),
        tab === 'backend'
          ? iconButton('refresh', '重新读取后端日志', RefreshIcon, () => {
              failedRef.current = false;
              setBackendNote('');
              void loadBackend();
            })
          : null,
        iconButton('copy', '复制当前内容', CopyIcon, () => void copyAll()),
        iconButton('download', '下载为 txt', DownloadIcon, download),
        iconButton('clear', '清空前端日志', TrashIcon, () => {
          clearLogs();
          setBackendLines([]);
        }),
        iconButton('close', '关闭终端 (Esc)', CloseIcon, () => setTerminalOpen(false)),
      ),
      // 日志体
      React.createElement(
        'div',
        {
          key: 'body',
          ref: bodyRef,
          className:
            'flex-1 min-h-0 overflow-y-auto px-2 py-1.5 font-mono text-[11px] leading-[1.6] bg-[var(--af-input)]',
          style: { wordBreak: 'break-all' },
        },
        tab === 'backend'
          ? visibleBackend.length === 0
            ? React.createElement(
                'div',
                { className: 'py-8 text-center text-[var(--af-text-muted)]' },
                backendNote || '后端暂时没有日志输出',
              )
            : visibleBackend.map((line) =>
                React.createElement(
                  'div',
                  {
                    key: line.key,
                    className:
                      'flex gap-2 px-1 py-0.5 rounded hover:bg-[var(--af-hover)] whitespace-pre-wrap',
                  },
                  line.ts
                    ? React.createElement(
                        'span',
                        { className: 'shrink-0 text-[var(--af-text-muted)]' },
                        formatTime(line.ts),
                      )
                    : null,
                  React.createElement(
                    'span',
                    {
                      className: 'shrink-0 text-[10px] font-bold uppercase',
                      style: { color: BACKEND_LEVEL_STYLE[line.level].color },
                    },
                    line.level,
                  ),
                  React.createElement(
                    'span',
                    { className: 'text-[var(--af-text-secondary)]' },
                    line.text,
                  ),
                ),
              )
          : filtered.length === 0
            ? React.createElement(
                'div',
                { className: 'py-8 text-center text-[var(--af-text-muted)]' },
                entries.length === 0
                  ? '暂无日志。生成、保存或请求出错时会自动记录在这里。'
                  : '没有符合筛选条件的日志',
              )
            : filtered.map((entry) => {
                const style = LEVEL_STYLE[entry.level];
                return React.createElement(
                  'div',
                  {
                    key: entry.id,
                    className: 'flex gap-2 px-1 py-0.5 rounded hover:bg-[var(--af-hover)]',
                  },
                  React.createElement(
                    'span',
                    { className: 'shrink-0 text-[var(--af-text-muted)]' },
                    formatTime(entry.ts),
                  ),
                  React.createElement(
                    'span',
                    {
                      className: 'shrink-0 px-1 rounded text-[10px] font-bold uppercase',
                      style: { color: style.color, background: style.background },
                    },
                    entry.level,
                  ),
                  entry.source
                    ? React.createElement(
                        'span',
                        { className: 'shrink-0 text-[var(--af-info)]' },
                        `[${entry.source}]`,
                      )
                    : null,
                  React.createElement(
                    'span',
                    { className: 'whitespace-pre-wrap text-[var(--af-text)]' },
                    entry.message,
                  ),
                );
              }),
      ),
    ),
  );
}
