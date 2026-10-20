import path from 'node:path';
import { readFile } from 'node:fs/promises';

// RunningHub 云端调用全局访问设置（画布设置里的「RunningHub 访问」区块）。
// 存储于账号偏好文件 preferences.json（与 /api/preferences 同一份数据），
// key 带 runninghub.access. 前缀，value 均为字符串。读取失败一律回退默认值，
// 绝不阻断工作流执行。
const CONFIG_FILE = 'preferences.json';
const KEY_PREFIX = 'runninghub.access.';

export const RUNNINGHUB_ACCESS_DEFAULTS = Object.freeze({
  // 总体查询窗口（轮询总时长）：默认 30 分钟。
  totalTimeoutMs: 30 * 60_000,
  // 基础轮询间隔：默认 15 秒。
  baseIntervalMs: 15_000,
  // 随机抖动范围 ±：默认 ±5 秒。
  jitterMs: 5_000,
  // 查询失败（网络类可重试错误）的连续重试次数：默认 3。
  retryMaxAttempts: 3,
  // 最大并发任务数：默认 1。
  maxConcurrent: 1,
  // 等待队列长度：-1 = 无界，0 = 不排队，N = 最多 N 个排队。
  maxQueueLength: -1,
});

export const RUNNINGHUB_ACCESS_KEYS = Object.freeze({
  totalTimeoutMs: `${KEY_PREFIX}totalTimeoutMs`,
  baseIntervalMs: `${KEY_PREFIX}baseIntervalMs`,
  jitterMs: `${KEY_PREFIX}jitterMs`,
  retryMaxAttempts: `${KEY_PREFIX}retryMaxAttempts`,
  maxConcurrent: `${KEY_PREFIX}maxConcurrent`,
  maxQueueLength: `${KEY_PREFIX}maxQueueLength`,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function toNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.round(parsed);
}

export function parseRunningHubAccessConfig(values = {}) {
  const result = { ...RUNNINGHUB_ACCESS_DEFAULTS };
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    if (typeof values[RUNNINGHUB_ACCESS_KEYS.totalTimeoutMs] === 'string') {
      result.totalTimeoutMs = toNonNegativeInteger(
        values[RUNNINGHUB_ACCESS_KEYS.totalTimeoutMs],
        result.totalTimeoutMs,
      );
    }
    if (typeof values[RUNNINGHUB_ACCESS_KEYS.baseIntervalMs] === 'string') {
      result.baseIntervalMs = toNonNegativeInteger(
        values[RUNNINGHUB_ACCESS_KEYS.baseIntervalMs],
        result.baseIntervalMs,
      );
    }
    if (typeof values[RUNNINGHUB_ACCESS_KEYS.jitterMs] === 'string') {
      result.jitterMs = toNonNegativeInteger(
        values[RUNNINGHUB_ACCESS_KEYS.jitterMs],
        result.jitterMs,
      );
    }
    if (typeof values[RUNNINGHUB_ACCESS_KEYS.retryMaxAttempts] === 'string') {
      result.retryMaxAttempts = toNonNegativeInteger(
        values[RUNNINGHUB_ACCESS_KEYS.retryMaxAttempts],
        result.retryMaxAttempts,
      );
    }
    if (typeof values[RUNNINGHUB_ACCESS_KEYS.maxConcurrent] === 'string') {
      result.maxConcurrent = toNonNegativeInteger(
        values[RUNNINGHUB_ACCESS_KEYS.maxConcurrent],
        result.maxConcurrent,
      );
    }
    if (typeof values[RUNNINGHUB_ACCESS_KEYS.maxQueueLength] === 'string') {
      const parsed = Number(values[RUNNINGHUB_ACCESS_KEYS.maxQueueLength]);
      if (Number.isFinite(parsed)) result.maxQueueLength = Math.round(parsed);
    }
  }
  // 夹取合法范围
  result.totalTimeoutMs = clamp(result.totalTimeoutMs, 10_000, 7_200_000);
  result.baseIntervalMs = clamp(result.baseIntervalMs, 100, 600_000);
  result.jitterMs = clamp(result.jitterMs, 0, result.baseIntervalMs);
  result.retryMaxAttempts = clamp(result.retryMaxAttempts, 0, 20);
  result.maxConcurrent = clamp(result.maxConcurrent, 1, 10);
  // maxQueueLength: -1 = 无界，否则 0~100
  if (result.maxQueueLength !== -1) {
    result.maxQueueLength = clamp(result.maxQueueLength, 0, 100);
  }
  return result;
}

export async function readRunningHubAccessConfig(privateDirectory) {
  try {
    const text = await readFile(path.join(privateDirectory, CONFIG_FILE), 'utf8');
    const document = JSON.parse(text);
    const values = document?.values && typeof document.values === 'object' && !Array.isArray(document.values)
      ? document.values
      : {};
    return parseRunningHubAccessConfig(values);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ...RUNNINGHUB_ACCESS_DEFAULTS };
    return { ...RUNNINGHUB_ACCESS_DEFAULTS };
  }
}
