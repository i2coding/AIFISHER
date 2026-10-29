// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasTerminal } from '../src/stable/dialogs/canvasTerminal';
import {
  clearLogs,
  logBus,
  setTerminalOpen,
} from '../src/stable/diagnostics/logBus';

const Icon = () => React.createElement('svg');

const components = {
  TerminalIcon: Icon,
  CloseIcon: Icon,
  TrashIcon: Icon,
  CopyIcon: Icon,
  DownloadIcon: Icon,
  SearchIcon: Icon,
  RefreshIcon: Icon,
};

const Terminal = (props: Record<string, unknown>) =>
  CanvasTerminal(React, props, components) as React.ReactElement;

describe('终端面板渲染', () => {
  beforeEach(() => {
    clearLogs();
    // 面板打开时会拉后端日志，这里给一个固定响应，避免走真实网络。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ entries: [], lines: [] }), { status: 200 })),
    );
  });

  afterEach(() => {
    // @testing-library 的自动清理依赖 globals，这里没开 globals，手动清。
    cleanup();
    setTerminalOpen(false);
    vi.unstubAllGlobals();
  });

  it('关闭时不渲染任何内容', () => {
    setTerminalOpen(false);
    const { container } = render(React.createElement(Terminal, {}));
    expect(container.textContent).toBe('');
  });

  it('打开时渲染日志条目与级别', () => {
    logBus.info('图片生成完成', '生成');
    logBus.error('上游 502', 'net');
    setTerminalOpen(true);
    render(React.createElement(Terminal, {}));

    expect(screen.getByText('终端')).toBeTruthy();
    expect(screen.getByText('图片生成完成')).toBeTruthy();
    expect(screen.getByText('上游 502')).toBeTruthy();
    expect(screen.getByText('[生成]')).toBeTruthy();
  });

  it('按级别筛选后只留对应条目', () => {
    logBus.info('普通信息');
    logBus.error('这是一条错误');
    setTerminalOpen(true);
    render(React.createElement(Terminal, {}));

    act(() => {
      fireEvent.click(screen.getByText('错误'));
    });

    expect(screen.getByText('这是一条错误')).toBeTruthy();
    expect(screen.queryByText('普通信息')).toBeNull();
  });

  it('搜索框按关键字过滤', () => {
    logBus.error('模型 kling-v2 超时');
    logBus.error('模型 seedance 拒绝');
    setTerminalOpen(true);
    render(React.createElement(Terminal, {}));

    const input = screen.getByPlaceholderText('搜索日志…');
    act(() => {
      fireEvent.change(input, { target: { value: 'kling' } });
    });

    expect(screen.getByText('模型 kling-v2 超时')).toBeTruthy();
    expect(screen.queryByText('模型 seedance 拒绝')).toBeNull();
  });

  it('清空按钮把日志清掉', async () => {
    logBus.error('会被清掉');
    setTerminalOpen(true);
    render(React.createElement(Terminal, {}));

    act(() => {
      fireEvent.click(screen.getByLabelText('清空前端日志'));
    });

    // 日志总线把通知合并到下一帧（避免刷屏时每条都重渲染），所以这里要等一下。
    await waitFor(() => expect(screen.queryByText('会被清掉')).toBeNull());
    expect(screen.getByText(/暂无日志/)).toBeTruthy();
  });

  it('空日志时给出说明文案', () => {
    setTerminalOpen(true);
    render(React.createElement(Terminal, {}));
    expect(screen.getByText(/生成、保存或请求出错时会自动记录/)).toBeTruthy();
  });
});
