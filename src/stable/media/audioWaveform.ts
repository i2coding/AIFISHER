/**
 * AIFISHER 音频波形播放器
 * 设计参考 ComfyUI 小珠光音频加载节点：
 * - Canvas 手绘波形（黑底 + 绿波 + 红蓝裁剪线 + 白色播放头）
 * - 顶部叠加信息栏：音量%、时间码、循环符号、全览/细节切换
 * - 红蓝线拖拽调整裁剪范围，白线拖拽跳转播放位置
 * - Web Audio API GainNode 支持 0~300% 音量
 * - 解码进度条（彩虹均衡器动画）
 */

export interface AudioRange {
  start: number;
  end: number;
}

export interface AudioWaveformEvents {
  ready(duration: number): void;
  time(time: number): void;
  playing(playing: boolean): void;
  range(range: AudioRange | null): void;
  error(error: unknown): void;
}

export interface AudioWaveform {
  playPause(): Promise<void>;
  pause(): void;
  setEditing(editing: boolean, trimming: boolean): void;
  /** 触发范围变化通知（拖拽松手后由 React 层调用 onAudioTrim 前手动同步） */
  getRange(): AudioRange;
  destroy(): void;
}

interface Peak {
  min: number;
  max: number;
}

const WAVEFORM_SAMPLES = 500;
const PADDING_X = 14;
const BORDER_W = 4;

function formatTime(t: number): string {
  if (t >= 60) {
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }
  return t.toFixed(1) + 's';
}

export function createAudioWaveform(
  container: HTMLElement,
  url: string,
  events: AudioWaveformEvents,
): AudioWaveform {
  // ── DOM 结构 ──
  container.style.position = 'relative';
  container.style.width = '100%';
  container.style.height = '100%';
  container.style.background = '#000';
  container.style.overflow = 'hidden';

  const canvas = document.createElement('canvas');
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  container.appendChild(canvas);

  const audio = new Audio();
  audio.preload = 'auto';
  audio.crossOrigin = 'anonymous';

  // ── 状态 ──
  let disposed = false;
  let peaks: Peak[] = [];
  let duration = 0;
  let startTime = 0;
  let endTime = 0;
  let playbackTime = 0;
  let volume = 1.0;
  let loopPlayback = false;
  let displayMode: 'full' | 'crop' = 'full';
  let isPlaying = false;
  let objectUrl: string | null = null;

  // 解码进度
  let decoding = true;
  let decodeProgress = -1; // -1 = 不确定
  let decodedTime = 0;
  let totalDuration = 0;

  // 拖拽状态
  let isDragging = false;
  let dragType: 'start' | 'end' | 'playhead' | 'volume' | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartStartTime = 0;
  let dragStartEndTime = 0;
  let dragStartVolY = 0;
  let dragMoved = false;
  const DRAG_THRESHOLD = 5;

  // hover 状态
  let playheadHover = false;
  let startMarkHover = false;
  let endMarkHover = false;

  // rAF
  let renderRafId: number | null = null;
  let playbackRafId: number | null = null;
  let decodeAnimRafId: number | null = null;

  // Web Audio
  let audioCtx: AudioContext | null = null;
  let gainNode: GainNode | null = null;
  let sourceNode: MediaElementAudioSourceNode | null = null;
  let audioGraphConnected = false;

  // 按钮命中区域（canvas 坐标）
  let loopBtnRect: { x: number; y: number; w: number; h: number } | null = null;
  let modeBtnRect: { x: number; y: number; w: number; h: number } | null = null;

  // ── 工具：坐标换算 ──
  function getCanvasSize() {
    const rect = canvas.getBoundingClientRect();
    return { w: Math.max(1, rect.width), h: Math.max(1, rect.height) };
  }

  function getPad() {
    const { w } = getCanvasSize();
    return Math.min(PADDING_X, Math.max(2, Math.floor(w / 8)));
  }

  function getUsableWidth() {
    const { w } = getCanvasSize();
    return Math.max(1, w - getPad() * 2);
  }

  function timeToX(t: number): number {
    if (duration <= 0) return getPad();
    const pad = getPad();
    const usableW = getUsableWidth();
    const cropDur = endTime - startTime;
    const isCrop = displayMode === 'crop' && cropDur > 0;
    if (isCrop) {
      const ratio = Math.max(0, Math.min(1, (t - startTime) / cropDur));
      return pad + ratio * usableW;
    }
    return pad + (t / duration) * usableW;
  }

  function xToTime(x: number): number {
    if (duration <= 0) return 0;
    const pad = getPad();
    const usableW = getUsableWidth();
    const px = x - pad;
    const cropDur = endTime - startTime;
    const isCrop = displayMode === 'crop' && cropDur > 0;
    if (isCrop) {
      const ratio = Math.max(0, Math.min(1, px / usableW));
      return startTime + ratio * cropDur;
    }
    return Math.max(0, Math.min(duration, (px / usableW) * duration));
  }

  function getVolumeY(_y: number, h: number): number {
    const barPadY = 2;
    const waveH = h - barPadY * 2;
    const v = Math.max(0, Math.min(3.0, volume));
    let yRatio: number;
    if (v <= 1.0) {
      yRatio = 1.0 - v * 0.5;
    } else {
      const t = (v - 1.0) / 2.0;
      yRatio = 0.5 - t * 0.5;
    }
    return barPadY + waveH * yRatio;
  }

  function getVolumeFromY(y: number, h: number): number {
    const barPadY = 2;
    const waveH = h - barPadY * 2;
    const yRatio = Math.max(0, Math.min(1, (y - barPadY) / waveH));
    if (yRatio >= 0.5) {
      const t = (1.0 - yRatio) / 0.5;
      return Math.max(0, Math.min(1.0, t));
    } else {
      const t = (0.5 - yRatio) / 0.5;
      return Math.max(1.0, Math.min(3.0, 1.0 + t * 2.0));
    }
  }

  // ── Web Audio 初始化 ──
  function ensureAudioGraph() {
    if (audioGraphConnected) return;
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      audioCtx = new AC();
      sourceNode = audioCtx.createMediaElementSource(audio);
      gainNode = audioCtx.createGain();
      gainNode.gain.value = volume;
      sourceNode.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      audioGraphConnected = true;
      audio.volume = 1;
    } catch {
      audioGraphConnected = false;
    }
  }

  function applyVolume(v: number) {
    if (audioGraphConnected && gainNode) {
      gainNode.gain.value = v;
    } else if (audio) {
      audio.volume = Math.min(1, v);
    }
  }

  // ── 渲染循环 ──
  let renderPending = false;
  function scheduleRender() {
    if (renderPending || disposed) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      render();
    });
  }

  function render() {
    if (disposed) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h } = getCanvasSize();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 黑底
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // 左右边框条 + 底部横边
    if (getPad() > 0) {
      ctx.fillStyle = '#353535';
      ctx.fillRect(0, 0, BORDER_W, h);
      ctx.fillRect(w - BORDER_W, 0, BORDER_W, h);
      ctx.fillRect(0, h - 4, w, 4);
    }

    // 解码中：画进度条
    if (decoding) {
      drawProgressBar(ctx, w, h);
      renderRafId = requestAnimationFrame(render);
      return;
    }

    if (peaks.length === 0) {
      ctx.fillStyle = '#555';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('无音频数据', w / 2, h / 2);
      return;
    }

    drawWaveform(ctx, w, h);
    drawTopBar(ctx, w, h);
  }

  function drawWaveform(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const barPadY = 2;
    const topBarH = 20; // 顶部信息栏高度
    const waveTop = topBarH;
    const waveH = h - waveTop - barPadY * 2;
    if (waveH <= 0) return;
    const waveMid = waveTop + barPadY + waveH / 2;
    const pad = getPad();
    const usableW = getUsableWidth();
    const volScale = volume;

    const cropDur = endTime - startTime;
    const isCropMode = displayMode === 'crop' && cropDur > 0;

    let startX: number, endX: number, playX: number;
    if (isCropMode) {
      startX = pad;
      endX = w - pad;
      playX = playbackTime >= startTime && playbackTime <= endTime
        ? pad + ((playbackTime - startTime) / cropDur) * usableW
        : -1;
    } else {
      startX = duration > 0 ? pad + (startTime / duration) * usableW : pad;
      endX = duration > 0 ? pad + (endTime / duration) * usableW : w - pad;
      playX = duration > 0 ? pad + (playbackTime / duration) * usableW : -1;
    }

    // 波形柱
    const numBars = peaks.length;
    if (isCropMode) {
      const startIdx = Math.floor((startTime / duration) * numBars);
      const endIdx = Math.ceil((endTime / duration) * numBars);
      const cropNumBars = Math.max(1, endIdx - startIdx);
      const barWidth = usableW / cropNumBars;
      for (let i = 0; i < cropNumBars; i++) {
        const peakIdx = startIdx + i;
        if (peakIdx < 0 || peakIdx >= numBars) continue;
        const [minVal, maxVal] = [peaks[peakIdx].min, peaks[peakIdx].max];
        const x = pad + i * barWidth;
        const bw = Math.max(1, Math.min(barWidth, w - pad - x));
        if (w - pad - x < 1) continue;
        ctx.fillStyle = '#307960';
        const top = waveMid + minVal * (waveH / 2) * volScale;
        const bottom = waveMid + maxVal * (waveH / 2) * volScale;
        ctx.fillRect(x, Math.max(waveTop + barPadY, top), bw, Math.max(1, Math.min(waveTop + h - barPadY, bottom) - Math.max(waveTop + barPadY, top)));
      }
    } else {
      const barWidth = usableW / numBars;
      for (let i = 0; i < numBars; i++) {
        const { min: minVal, max: maxVal } = peaks[i];
        const x = pad + i * barWidth;
        const bw = Math.max(1, Math.min(barWidth, w - pad - x));
        if (w - pad - x < 1) continue;
        const inRange = x >= startX && x <= endX;
        ctx.fillStyle = inRange ? '#307960' : '#444';
        const top = waveMid + minVal * (waveH / 2) * volScale;
        const bottom = waveMid + maxVal * (waveH / 2) * volScale;
        ctx.fillRect(x, Math.max(waveTop + barPadY, top), bw, Math.max(1, Math.min(waveTop + h - barPadY, bottom) - Math.max(waveTop + barPadY, top)));
      }
      // 未选中区域遮罩
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(pad, waveTop + barPadY, startX - pad, waveH);
      ctx.fillRect(endX, waveTop + barPadY, w - pad - endX, waveH);
    }

    // 音量线（左侧可拖拽手柄）
    const volY = getVolumeY(0, h) + waveTop;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(pad, volY);
    ctx.lineTo(pad + 50, volY);
    ctx.stroke();
    // 右端小圆点手柄
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(pad + 50, volY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineCap = 'butt';

    // 标记线
    if (duration > 0) {
      // 起点红线
      const startHot = startMarkHover || (isDragging && dragType === 'start');
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(startX, waveTop);
      ctx.lineTo(startX, h);
      ctx.stroke();
      if (startHot) {
        ctx.save();
        ctx.strokeStyle = '#ff6868';
        ctx.lineWidth = 4;
        ctx.shadowColor = 'rgba(255,70,70,0.95)';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(startX, waveTop + 20);
        ctx.lineTo(startX, h);
        ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.moveTo(startX - 4, waveTop);
      ctx.lineTo(startX + 4, waveTop);
      ctx.lineTo(startX, waveTop + 5);
      ctx.closePath();
      ctx.fill();

      // 终点蓝线
      const endHot = endMarkHover || (isDragging && dragType === 'end');
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(endX, waveTop);
      ctx.lineTo(endX, h);
      ctx.stroke();
      if (endHot) {
        ctx.save();
        ctx.strokeStyle = '#63b3ff';
        ctx.lineWidth = 4;
        ctx.shadowColor = 'rgba(55,145,255,0.95)';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(endX, waveTop + 20);
        ctx.lineTo(endX, h);
        ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = '#3b82f6';
      ctx.beginPath();
      ctx.moveTo(endX - 4, waveTop);
      ctx.lineTo(endX + 4, waveTop);
      ctx.lineTo(endX, waveTop + 5);
      ctx.closePath();
      ctx.fill();

      // 播放头白线
      if (playX >= 0) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(playX, waveTop);
        ctx.lineTo(playX, h);
        ctx.stroke();
        if (playheadHover || (isDragging && dragType === 'playhead')) {
          ctx.strokeStyle = '#FFD34E';
          ctx.lineWidth = 3.5;
          ctx.beginPath();
          ctx.moveTo(playX, waveTop + 20);
          ctx.lineTo(playX, h);
          ctx.stroke();
        }
      }
    }
  }

  function drawTopBar(ctx: CanvasRenderingContext2D, w: number, _h: number) {
    const pad = getPad();
    // 音量文字
    const volText = `音量${Math.round(volume * 100)}`;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(volText, pad + 2, 3);
    const volTextW = ctx.measureText(volText).width;

    // 时间码
    const curTime = formatTime(playbackTime || startTime);
    const rangeStr = `${formatTime(startTime)}-${formatTime(endTime)}`;
    const durLabel = formatTime(Math.max(0, endTime - startTime));
    let timeText = `${curTime} / ${rangeStr} 时长${durLabel}`;
    const rightZone = w - pad - 15;
    const timeBaseX = pad + 2 + volTextW + 6;
    if (ctx.measureText(timeText).width > rightZone - timeBaseX - 24) {
      timeText = `${curTime} / ${durLabel}`;
      if (ctx.measureText(timeText).width > rightZone - timeBaseX - 24) {
        timeText = curTime;
        if (ctx.measureText(timeText).width > rightZone - timeBaseX - 24) {
          timeText = '';
        }
      }
    }
    ctx.fillText(timeText, timeBaseX, 3);
    const timeTextW = ctx.measureText(timeText).width;

    // 循环符号
    const loopSym = loopPlayback ? '⇆' : '→';
    const loopX = timeBaseX + timeTextW + 8;
    const loopW = ctx.measureText(loopSym).width;
    ctx.fillStyle = '#FFD700';
    ctx.fillText(loopSym, loopX, 2);
    loopBtnRect = { x: loopX - 3, y: 1, w: loopW + 6, h: 18 };

    // 全览/细节按钮
    const btnW = 30;
    const btnX = loopX - 3 + loopW + 6 + 8;
    const btnY = 3;
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.textAlign = 'right';
    ctx.fillText(displayMode === 'crop' ? '细节' : '全览', btnX + btnW, btnY);
    modeBtnRect = { x: btnX, y: btnY, w: btnW, h: 18 };
  }

  function drawProgressBar(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const pad = getPad();
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    ctx.fillRect(0, 0, w, h);

    const maxBarH = Math.min(h * 0.55, 28);
    const minBarH = 3;
    const barW = 3;
    const barGap = 3;
    const usableW = Math.max(40, w - pad * 2);
    const numBars = Math.max(7, Math.floor((usableW + barGap) / (barW + barGap)));
    const totalW = numBars * barW + (numBars - 1) * barGap;
    const startX = pad + (usableW - totalW) / 2;
    const baseY = h / 2 + maxBarH / 2 + 14;

    const now = Date.now();
    const progressFactor = decodeProgress >= 0 ? decodeProgress : 0.5;
    const palette = [
      { dark: '#8B0000', mid: '#FF4444', light: '#FFB3B3' },
      { dark: '#8B4500', mid: '#FF8C00', light: '#FFD9B3' },
      { dark: '#8B6914', mid: '#FFD700', light: '#FFF8DC' },
      { dark: '#006400', mid: '#22C55E', light: '#B3F0C4' },
      { dark: '#006964', mid: '#06B6D4', light: '#B3F0F5' },
      { dark: '#00008B', mid: '#3B82F6', light: '#B3D4FF' },
      { dark: '#4B0082', mid: '#8B5CF6', light: '#D4C4FF' },
    ];

    for (let i = 0; i < numBars; i++) {
      const phase1 = Math.sin(now * 0.006 + i * 0.7) * 0.5 + 0.5;
      const phase2 = Math.sin(now * 0.011 + i * 1.3 + 1.2) * 0.3 + 0.3;
      const phase3 = Math.sin(now * 0.004 + i * 0.4 + 2.5) * 0.2 + 0.2;
      const centerWeight = 1 - Math.abs(i - (numBars - 1) / 2) / ((numBars - 1) / 2) * 0.4;
      let intensity = (phase1 + phase2 + phase3) * centerWeight;
      intensity = intensity * (0.4 + progressFactor * 0.6);
      intensity = Math.max(0, Math.min(1, intensity));
      const barHi = minBarH + (maxBarH - minBarH) * intensity;
      const x = startX + i * (barW + barGap);
      const y = baseY - barHi;
      const color = palette[i % palette.length];
      const grad = ctx.createLinearGradient(0, baseY, 0, baseY - maxBarH);
      grad.addColorStop(0, color.dark);
      grad.addColorStop(0.5, color.mid);
      grad.addColorStop(1, color.light);
      ctx.fillStyle = grad;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, barW, barHi, barW / 2);
      else ctx.rect(x, y, barW, barHi);
      ctx.fill();
    }

    // 文字
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#FFD700';
    ctx.font = '12px sans-serif';
    if (decodeProgress >= 0) {
      ctx.fillText(`解码中... ${Math.round(decodeProgress * 100)}%`, w / 2, baseY + 4);
    } else {
      ctx.fillText('正在分析音频...', w / 2, baseY + 4);
    }
    ctx.fillStyle = '#888';
    if (totalDuration > 0 && decodedTime > 0) {
      ctx.fillText(`${formatTime(decodedTime)} / ${formatTime(totalDuration)}`, w / 2, baseY + 16);
    }
  }

  // ── 播放控制 ──
  function togglePlay() {
    if (duration <= 0) return;
    if (isPlaying) {
      audio.pause();
      return;
    }
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    const targetTime = playbackTime || startTime;
    let t = targetTime;
    if (t < startTime || t >= endTime - 0.05) t = startTime;
    if (Math.abs((audio.currentTime || 0) - t) > 0.05) {
      try { audio.currentTime = t; } catch { /* not ready */ }
      playbackTime = t;
    }
    audio.play().catch(() => {});
  }

  function startPlaybackLoop() {
    if (playbackRafId != null) return;
    const loop = () => {
      if (!isPlaying) return;
      playbackTime = audio.currentTime;
      if (loopPlayback) {
        if (audio.currentTime >= endTime - 0.02) {
          audio.currentTime = startTime;
          playbackTime = startTime;
        }
      } else {
        if (audio.currentTime >= endTime - 0.02) {
          playbackTime = endTime;
          audio.pause();
          events.time(playbackTime);
          render();
          return;
        }
      }
      events.time(playbackTime);
      render();
      playbackRafId = requestAnimationFrame(loop);
    };
    playbackRafId = requestAnimationFrame(loop);
  }

  function stopPlaybackLoop() {
    if (playbackRafId != null) {
      cancelAnimationFrame(playbackRafId);
      playbackRafId = null;
    }
  }

  // ── 音频事件 ──
  audio.addEventListener('play', () => {
    if (disposed) return;
    isPlaying = true;
    events.playing(true);
    startPlaybackLoop();
  });
  audio.addEventListener('pause', () => {
    if (disposed) return;
    isPlaying = false;
    events.playing(false);
    stopPlaybackLoop();
  });
  audio.addEventListener('ended', () => {
    if (disposed) return;
    if (loopPlayback) {
      audio.currentTime = startTime;
      audio.play().catch(() => {});
    }
  });
  audio.addEventListener('error', () => {
    if (disposed) return;
    events.error(new Error('音频加载失败'));
  });

  // ── Pointer 事件 ──
  function getLocalPos(e: PointerEvent | MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: PointerEvent) {
    if (disposed || decoding) return;
    if (e.button === 2) return; // 右键由 React 层处理

    const { x, y } = getLocalPos(e);
    const { h } = getCanvasSize();
    const topBarH = 20;

    // 命中循环按钮
    if (loopBtnRect && y < topBarH && x >= loopBtnRect.x && x <= loopBtnRect.x + loopBtnRect.w) {
      e.preventDefault();
      e.stopPropagation();
      loopPlayback = !loopPlayback;
      return;
    }
    // 命中模式切换按钮
    if (modeBtnRect && y < topBarH && x >= modeBtnRect.x && x <= modeBtnRect.x + modeBtnRect.w) {
      e.preventDefault();
      e.stopPropagation();
      displayMode = displayMode === 'crop' ? 'full' : 'crop';
      return;
    }

    if (y < topBarH) return; // 顶部信息栏区域其他位置不响应

    const pad = getPad();
    const waveTop = topBarH;
    const volY = getVolumeY(0, h) + waveTop;
    const startX = timeToX(startTime);
    const endX = timeToX(endTime);
    const playX = timeToX(playbackTime);

    // 判断是否命中交互手柄（红蓝线/播放头/音量线）
    const hitVolume = Math.abs(y - volY) <= 12 && x >= pad - 4 && x <= pad + 60;
    const hitStart = Math.abs(x - startX) <= 18;
    const hitEnd = Math.abs(x - endX) <= 18;
    const hitPlayhead = Math.abs(x - playX) <= 20;

    if (!hitVolume && !hitStart && !hitEnd && !hitPlayhead) {
      // 空白处：播放/暂停，不阻止冒泡（让节点能被选中/拖动）
      togglePlay();
      return;
    }

    // 命中手柄：阻止冒泡，自己处理拖拽
    e.preventDefault();
    e.stopPropagation();

    if (hitVolume) {
      dragType = 'volume';
    } else if (hitStart && (!hitEnd || Math.abs(x - startX) <= Math.abs(x - endX))) {
      dragType = 'start';
    } else if (hitEnd) {
      dragType = 'end';
    } else {
      dragType = 'playhead';
    }

    isDragging = true;
    dragMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartStartTime = startTime;
    dragStartEndTime = endTime;
    dragStartVolY = volY;

    if (dragType === 'playhead') {
      let t = xToTime(x);
      t = Math.max(startTime, Math.min(endTime, t));
      t = Math.round(t * 100) / 100;
      playbackTime = t;
      try { audio.currentTime = t; } catch { /* not ready */ }
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  }

  function onPointerMove(e: PointerEvent) {
    if (disposed || !isDragging) return;
    const { h } = getCanvasSize();
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    if (!dragMoved) {
      if (Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        dragMoved = true;
      } else {
        return;
      }
    }

    if (dragType === 'volume') {
      const currentY = dragStartVolY + dy;
      let v = getVolumeFromY(currentY - 20, h); // 减去 topBar 偏移
      v = Math.round(v * 100) / 100;
      volume = v;
      applyVolume(v);
      scheduleRender();
      return;
    }

    if (dragType === 'playhead') {
      const rect = canvas.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      let t = xToTime(localX);
      t = Math.max(startTime, Math.min(endTime, t));
      t = Math.round(t * 100) / 100;
      playbackTime = t;
      try { audio.currentTime = t; } catch { /* not ready */ }
      scheduleRender();
      return;
    }

    // start / end 拖拽
    const usableW = getUsableWidth();
    const dt = (dx / usableW) * duration;
    if (dragType === 'start') {
      startTime = Math.max(0, Math.min(endTime - 0.01, dragStartStartTime + dt));
      startTime = Math.round(startTime * 100) / 100;
    } else if (dragType === 'end') {
      endTime = Math.min(duration, Math.max(startTime + 0.01, dragStartEndTime + dt));
      endTime = Math.round(endTime * 100) / 100;
    }
    scheduleRender();
  }

  function onPointerUp() {
    if (disposed) return;
    const wasDragging = dragType;
    const moved = dragMoved;
    isDragging = false;
    dragType = null;
    dragMoved = false;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);

    if ((wasDragging === 'start' || wasDragging === 'end') && moved) {
      events.range({ start: startTime, end: endTime });
    }
  }

  // hover 检测
  function onMouseMove(e: MouseEvent) {
    if (disposed || isDragging || decoding) return;
    const { x, y } = getLocalPos(e);
    const topBarH = 20;
    if (y < topBarH) return;
    const startX = timeToX(startTime);
    const endX = timeToX(endTime);
    const playX = timeToX(playbackTime);
    const nearStart = Math.abs(x - startX) <= 18;
    const nearEnd = Math.abs(x - endX) <= 18;
    const nearPlay = Math.abs(x - playX) <= 20;
    const newStartHover = nearStart && (!nearEnd || Math.abs(x - startX) <= Math.abs(x - endX));
    const newEndHover = nearEnd && !nearStart;
    const newPlayHover = nearPlay && !nearStart && !nearEnd;
    if (newStartHover !== startMarkHover || newEndHover !== endMarkHover || newPlayHover !== playheadHover) {
      startMarkHover = newStartHover;
      endMarkHover = newEndHover;
      playheadHover = newPlayHover;
      scheduleRender();
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('mousemove', onMouseMove);

  // ── 解码动画 ──
  function startDecodeAnim() {
    if (decodeAnimRafId != null) return;
    const loop = () => {
      if (!decoding) return;
      decodeAnimRafId = requestAnimationFrame(loop);
    };
    decodeAnimRafId = requestAnimationFrame(loop);
  }
  function stopDecodeAnim() {
    if (decodeAnimRafId != null) {
      cancelAnimationFrame(decodeAnimRafId);
      decodeAnimRafId = null;
    }
  }

  // ── 加载音频 ──
  async function load() {
    try {
      // fetch 音频为 ArrayBuffer，用于解码提取 peaks
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      objectUrl = URL.createObjectURL(new Blob([buf]));
      audio.src = objectUrl;

      // 用 OfflineAudioContext 解码提取 peaks
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const offCtx = new AC();
      const decoded = await offCtx.decodeAudioData(buf.slice(0));
      duration = decoded.duration;
      totalDuration = duration;
      startTime = 0;
      endTime = duration;
      playbackTime = duration / 2;

      // 提取 peaks
      const channelData = decoded.getChannelData(0);
      const total = channelData.length;
      const samplesPerBin = total / WAVEFORM_SAMPLES;
      peaks = [];
      for (let i = 0; i < WAVEFORM_SAMPLES; i++) {
        const s = Math.floor(i * samplesPerBin);
        const e = Math.floor((i + 1) * samplesPerBin);
        let mn = 1, mx = -1;
        for (let j = s; j < e && j < total; j++) {
          const v = channelData[j];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
        peaks.push({ min: mn, max: mx });
      }
      offCtx.close().catch(() => {});

      decoding = false;
      stopDecodeAnim();
      events.ready(duration);
      events.time(0);
    } catch (err) {
      decoding = false;
      stopDecodeAnim();
      events.error(err);
    }
  }

  startDecodeAnim();
  void load();

  // 启动渲染循环
  render();

  return {
    playPause: async () => {
      togglePlay();
    },
    pause: () => {
      audio.pause();
    },
    setEditing: () => {
      // 新设计：红蓝线始终可拖，无需进入裁切模式
    },
    getRange: () => ({ start: startTime, end: endTime }),
    destroy: () => {
      disposed = true;
      stopPlaybackLoop();
      stopDecodeAnim();
      if (renderRafId != null) cancelAnimationFrame(renderRafId);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      audio.pause();
      audio.src = '';
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (audioCtx) {
        audioCtx.close().catch(() => {});
      }
      canvas.remove();
    },
  };
}
