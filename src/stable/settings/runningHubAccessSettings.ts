import type { SettingsRequestOptions } from '../generation/sourceSettingsRequests';
import { requestSettingsJson } from '../generation/sourceSettingsRequests';
import { createStableTextElement as element } from '../design/dom';
import { createSettingsScope } from '../generation/sourceSettingsScope';
import { settingsOperation } from './settingsOperation';

// RunningHub 云端调用全局访问设置（对应「设置 → RunningHub 访问」区块）。
// 与后端 server/workflowRuntime/runningHubAccessConfig.js 的 key 保持一致，
// 存储于 /api/preferences（按账号本机保存）。
export type RunningHubAccessSettings = {
  totalTimeoutMs: number;
  baseIntervalMs: number;
  jitterMs: number;
  retryMaxAttempts: number;
  upscaleTargetSize: number;
};

export const RUNNINGHUB_ACCESS_DEFAULTS: RunningHubAccessSettings = {
  totalTimeoutMs: 30 * 60_000,
  baseIntervalMs: 15_000,
  jitterMs: 5_000,
  retryMaxAttempts: 3,
  upscaleTargetSize: 2048,
};

const ACCESS_KEYS = {
  totalTimeoutMs: 'runninghub.access.totalTimeoutMs',
  baseIntervalMs: 'runninghub.access.baseIntervalMs',
  jitterMs: 'runninghub.access.jitterMs',
  retryMaxAttempts: 'runninghub.access.retryMaxAttempts',
  upscaleTargetSize: 'runninghub.upscale.targetSize',
} as const;

function parseValue(values: Record<string, string>, key: string, fallback: number) {
  const raw = values[key];
  if (typeof raw !== 'string') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

export type RunningHubAccessSettingsClient = {
  read(options?: SettingsRequestOptions): Promise<RunningHubAccessSettings>;
  save(settings: RunningHubAccessSettings, options?: SettingsRequestOptions): Promise<void>;
};

export function createRunningHubAccessSettingsClient(
  fetcher: typeof fetch = globalThis.fetch,
): RunningHubAccessSettingsClient {
  return {
    async read(options: SettingsRequestOptions = {}) {
      const body = await requestSettingsJson<{ values?: Record<string, string> }>(
        fetcher,
        '/api/preferences',
        '读取 RunningHub 访问设置失败',
        options,
      );
      const values = body.values ?? {};
      return {
        totalTimeoutMs: parseValue(
          values,
          ACCESS_KEYS.totalTimeoutMs,
          RUNNINGHUB_ACCESS_DEFAULTS.totalTimeoutMs,
        ),
        baseIntervalMs: parseValue(
          values,
          ACCESS_KEYS.baseIntervalMs,
          RUNNINGHUB_ACCESS_DEFAULTS.baseIntervalMs,
        ),
        jitterMs: parseValue(
          values,
          ACCESS_KEYS.jitterMs,
          RUNNINGHUB_ACCESS_DEFAULTS.jitterMs,
        ),
        retryMaxAttempts: parseValue(
          values,
          ACCESS_KEYS.retryMaxAttempts,
          RUNNINGHUB_ACCESS_DEFAULTS.retryMaxAttempts,
        ),
        upscaleTargetSize: parseValue(
          values,
          ACCESS_KEYS.upscaleTargetSize,
          RUNNINGHUB_ACCESS_DEFAULTS.upscaleTargetSize,
        ),
      };
    },
    async save(settings: RunningHubAccessSettings, options: SettingsRequestOptions = {}) {
      await requestSettingsJson<{ values?: Record<string, string> }>(
        fetcher,
        '/api/preferences',
        '保存 RunningHub 访问设置失败',
        options,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            set: {
              [ACCESS_KEYS.totalTimeoutMs]: String(settings.totalTimeoutMs),
              [ACCESS_KEYS.baseIntervalMs]: String(settings.baseIntervalMs),
              [ACCESS_KEYS.jitterMs]: String(settings.jitterMs),
              [ACCESS_KEYS.retryMaxAttempts]: String(settings.retryMaxAttempts),
              [ACCESS_KEYS.upscaleTargetSize]: String(settings.upscaleTargetSize),
            },
          }),
        },
      );
    },
  };
}

function action(label: string) {
  const button = element(
    'button',
    label,
    'px-3 py-2 rounded-lg border border-[var(--af-border-control)] text-sm text-[var(--af-text)] hover:bg-[var(--af-surface-raised)] disabled:opacity-50',
  ) as HTMLButtonElement;
  button.type = 'button';
  return button;
}

function numberField(label: string, unit: string, hint: string) {
  const row = element('label', '', 'flex items-center gap-6');
  const labelElement = element(
    'span',
    label,
    'w-40 shrink-0 text-sm font-medium text-[var(--af-text-secondary)]',
  );
  const wrap = element('span', '', 'flex items-center gap-2 flex-1 min-w-0');
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = '1';
  input.className =
    'w-28 rounded-lg border border-[var(--af-border)] bg-[var(--af-input)] px-3 py-2 text-sm text-[var(--af-text)] focus:outline-none focus:border-[var(--af-primary)]';
  const unitElement = element('span', unit, 'shrink-0 text-sm text-[var(--af-text-muted)]');
  const hintElement = element(
    'span',
    hint,
    'text-xs text-[var(--af-text-muted)] truncate',
  );
  wrap.append(input, unitElement, hintElement);
  row.append(labelElement, wrap);
  return { row, input };
}

export function mountRunningHubAccessSettings(
  host: HTMLElement,
  client: RunningHubAccessSettingsClient,
) {
  const panel = element('section', '', 'space-y-6 animate-in fade-in duration-200');
  panel.setAttribute('data-fisherai-runninghub-access-settings', 'true');
  host.append(panel);
  const scope = createSettingsScope(panel);
  let inFlight = false;

  const card = element(
    'div',
    '',
    'p-8 bg-[var(--af-surface-raised)] border border-[var(--af-border)] rounded-lg space-y-6',
  );
  const heading = element('div');
  heading.append(
    element('h3', 'RunningHub 访问', 'text-xl font-bold text-[var(--af-text)] mb-2'),
    element(
      'p',
      '云端调用 RunningHub 应用时的全局轮询参数：总体超时时间、查询间隔（基础间隔 ± 随机抖动）与查询失败重试次数。新参数将在下一次 RunningHub 任务生效。',
      'text-sm text-[var(--af-text-secondary)]',
    ),
  );

  const totalField = numberField(
    '总体超时时间',
    '分钟',
    '云端任务最长等待时间，到期自动暂停观察。',
  );
  const baseField = numberField('基础轮询间隔', '秒', '每次查询任务状态的时间基准。');
  const jitterField = numberField('随机抖动范围', '秒', '查询间隔 = 基础间隔 ± 抖动内随机值。');
  const retryField = numberField('查询失败重试次数', '次', '网络类错误连续重试上限，超出即停止。');
  const upscaleField = numberField('高清放大目标边长', 'px', 'HD 按钮放大输出图的目标短边像素（256–8192）。');

  const actions = element('div', '', 'flex flex-wrap gap-2');
  const save = action('保存设置');
  const reset = action('恢复默认');
  actions.append(save, reset);

  const message = element('p', '', 'min-h-5 text-xs text-[var(--af-text-secondary)]');
  message.setAttribute('aria-live', 'polite');
  card.append(heading, totalField.row, baseField.row, jitterField.row, retryField.row, upscaleField.row, actions, message);
  panel.append(card);

  const busy = (active: boolean) => {
    inFlight = active;
    save.disabled = active;
    reset.disabled = active;
  };

  const applyForm = (settings: RunningHubAccessSettings) => {
    totalField.input.value = String(Math.round(settings.totalTimeoutMs / 60_000));
    baseField.input.value = String(Math.round(settings.baseIntervalMs / 1_000));
    jitterField.input.value = String(Math.round(settings.jitterMs / 1_000));
    retryField.input.value = String(settings.retryMaxAttempts);
    upscaleField.input.value = String(settings.upscaleTargetSize);
  };

  const showMessage = (text: string, warning = false) => {
    message.style.color = warning ? 'var(--af-warning)' : 'var(--af-text-secondary)';
    message.textContent = text;
  };

  const load = async () => {
    if (inFlight || !scope.active()) return;
    busy(true);
    showMessage('正在读取当前设置…');
    try {
      const settings = await settingsOperation(
        scope,
        () => client.read({ signal: scope.signal }),
        15_000,
      );
      if (!scope.active()) return;
      applyForm(settings);
      showMessage(settings.totalTimeoutMs === RUNNINGHUB_ACCESS_DEFAULTS.totalTimeoutMs
        ? '当前使用默认设置。'
        : '已读取当前设置。');
    } catch (error) {
      if (!scope.active()) return;
      applyForm(RUNNINGHUB_ACCESS_DEFAULTS);
      showMessage(error instanceof Error ? error.message : '读取设置失败，已显示默认值。', true);
    } finally {
      busy(false);
    }
  };

  const collect = (): RunningHubAccessSettings | null => {
    const totalMinutes = Number(totalField.input.value);
    const baseSeconds = Number(baseField.input.value);
    const jitterSeconds = Number(jitterField.input.value);
    const retry = Number(retryField.input.value);
    const upscale = Number(upscaleField.input.value);
    if (
      ![totalMinutes, baseSeconds, jitterSeconds, retry, upscale].every(Number.isFinite)
      || totalMinutes < 1 || baseSeconds < 1 || jitterSeconds < 0 || retry < 0
    ) {
      showMessage('请输入有效数字：超时 ≥ 1 分钟，间隔 ≥ 1 秒，抖动 ≥ 0，重试 ≥ 0。', true);
      return null;
    }
    if (jitterSeconds > baseSeconds) {
      showMessage('随机抖动范围不能超过基础轮询间隔。', true);
      return null;
    }
    if (totalMinutes > 120) {
      showMessage('总体超时时间不能超过 120 分钟（2 小时）。', true);
      return null;
    }
    if (!Number.isInteger(upscale) || upscale < 256 || upscale > 8192) {
      showMessage('高清放大目标边长需为 256–8192 之间的整数。', true);
      return null;
    }
    return {
      totalTimeoutMs: Math.round(totalMinutes * 60_000),
      baseIntervalMs: Math.round(baseSeconds * 1_000),
      jitterMs: Math.round(jitterSeconds * 1_000),
      retryMaxAttempts: Math.round(retry),
      upscaleTargetSize: upscale,
    };
  };

  const persist = async (settings: RunningHubAccessSettings, successMessage: string) => {
    if (inFlight || !scope.active()) return;
    busy(true);
    showMessage('正在保存…');
    try {
      await settingsOperation(
        scope,
        () => client.save(settings, { signal: scope.signal }),
        30_000,
      );
      if (!scope.active()) return;
      applyForm(settings);
      showMessage(successMessage);
    } catch (error) {
      if (!scope.active()) return;
      showMessage(error instanceof Error ? error.message : '保存失败，请重试。', true);
    } finally {
      busy(false);
    }
  };

  save.addEventListener('click', () => {
    const settings = collect();
    if (settings) void persist(settings, '已保存。新参数将在下一次 RunningHub 任务生效。');
  });
  reset.addEventListener('click', () => {
    void persist(RUNNINGHUB_ACCESS_DEFAULTS, '已恢复默认设置。新参数将在下一次 RunningHub 任务生效。');
  });

  void load();

  return scope.dispose;
}
