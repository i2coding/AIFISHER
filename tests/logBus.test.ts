import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLogs,
  getLogSnapshot,
  logBus,
  redactForStorage,
  subscribeLogs,
  writeLog,
} from '../src/stable/diagnostics/logBus';
import { createLogRingBuffer } from '../server/diagnostics/logRing.js';

describe('前端日志总线', () => {
  beforeEach(() => {
    clearLogs();
  });

  it('写入后能按顺序读到，并带上级别与来源', () => {
    logBus.info('第一条', '生成');
    logBus.error('第二条');
    const { entries } = getLogSnapshot();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ level: 'info', source: '生成', message: '第一条' });
    expect(entries[1]).toMatchObject({ level: 'error', message: '第二条' });
    expect(entries[1].source).toBeUndefined();
  });

  it('通知订阅者，且取消订阅后不再收到', () => {
    let calls = 0;
    const unsubscribe = subscribeLogs(() => {
      calls += 1;
    });
    logBus.warn('一条');
    expect(calls).toBe(1);
    unsubscribe();
    logBus.warn('两条');
    expect(calls).toBe(1);
  });

  it('超过 500 条后丢弃最旧的，不会无限增长', () => {
    for (let index = 0; index < 520; index += 1) writeLog('debug', `第 ${index} 条`);
    const { entries } = getLogSnapshot();
    expect(entries).toHaveLength(500);
    expect(entries[0].message).toBe('第 20 条');
    expect(entries[entries.length - 1].message).toBe('第 519 条');
  });

  it('超长消息被截断，避免单条撑爆面板', () => {
    writeLog('info', 'x'.repeat(6000));
    expect(getLogSnapshot().entries[0].message.length).toBeLessThan(4100);
  });

  it('未读数只在面板关闭时累计，打开即清零', () => {
    logBus.info('a');
    logBus.error('b');
    expect(getLogSnapshot().unread).toBe(2);
    expect(getLogSnapshot().errorUnread).toBe(1);
    // 打开面板（setTerminalOpen 由面板调用，这里直接验证清零语义）
    clearLogs();
    expect(getLogSnapshot().unread).toBe(0);
    expect(getLogSnapshot().errorUnread).toBe(0);
  });
});

describe('日志落盘前的脱敏', () => {
  it('抹掉 API Key、Bearer 与 URL 查询串', () => {
    expect(redactForStorage('key sk-abcdefgh12345678')).toContain('[redacted-key]');
    expect(redactForStorage('Authorization: Bearer abc.def.ghi123')).toContain('[redacted]');
    const url = redactForStorage('请求 https://api.example.com/v1/image?sign=abcdef&t=1 失败');
    expect(url).not.toContain('sign=abcdef');
    expect(url).toContain('https://api.example.com/v1/image');
  });

  it('普通文本原样保留', () => {
    expect(redactForStorage('模型 kling-v2 生成失败')).toBe('模型 kling-v2 生成失败');
  });
});

describe('后端日志环形缓冲', () => {
  it('console 方法映射成面板级别', () => {
    const ring = createLogRingBuffer(10);
    ring.push('log', ['普通']);
    ring.push('warn', ['注意']);
    ring.push('error', ['坏了']);
    expect(ring.list().map((entry) => entry.level)).toEqual(['info', 'warn', 'error']);
  });

  it('按上限保留最新的条目', () => {
    const ring = createLogRingBuffer(3);
    for (let index = 0; index < 6; index += 1) ring.push('log', [`第 ${index} 条`]);
    const list = ring.list();
    expect(list).toHaveLength(3);
    expect(list[0].message).toBe('第 3 条');
    expect(list[2].message).toBe('第 5 条');
  });

  it('对象参数被格式化，异常带上名称与消息', () => {
    const ring = createLogRingBuffer(5);
    ring.push('log', ['请求失败', { status: 502, path: '/api/generate-image' }]);
    ring.push('error', [new Error('上游超时')]);
    const list = ring.list();
    expect(list[0].message).toContain('"status":502');
    expect(list[0].message).toContain('/api/generate-image');
    expect(list[1].message).toBe('Error: 上游超时');
  });

  it('保留路径但抹掉密钥：排错要看路径', () => {
    const ring = createLogRingBuffer(5);
    ring.push('error', ['读取 D:\\Users\\me\\models\\x.bin 失败，token=abc123']);
    const message = ring.list()[0].message;
    expect(message).toContain('models');
    expect(message).not.toContain('abc123');
  });
});
