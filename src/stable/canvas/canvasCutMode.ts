import type * as ReactTypes from 'react';

type Runtime = Pick<typeof ReactTypes, 'useEffect' | 'useRef' | 'useState'>;

/**
 * 连线命中元素上的标记。切割时直接读这几个属性，不去解析 data-edge-key ——
 * 节点的 uuid 本身含 '-'，拼在一起没法安全拆开。
 */
export const CUT_EDGE_ATTR = 'data-fisherai-edge-parent';

interface Point {
  x: number;
  y: number;
}
interface Options {
  containerRef: { current: HTMLElement | null };
  enabled: boolean;
  onCut(edges: Array<{ parentId: string; childId: string; portIndex?: number }>): void;
}
interface EdgeRef {
  parentId: string;
  childId: string;
  portIndex?: number;
}

const TRAIL_CLASS = 'fisherai-cut-trail';
/** 采样步长（屏幕像素）：一笔划过去时按这个间距逐点判定，快速划也不会漏线。 */
const SAMPLE_STEP = 6;

/**
 * 一条视觉上的线可能代表多条数据连接：组内多个成员连到同一个下游时会被合并成
 * "组 → 下游"一条线（portIndex 记为 -1）。剪它要按成员逐个断开。
 */
function readEdges(element: Element): EdgeRef[] {
  const childId = element.getAttribute('data-fisherai-edge-child');
  if (!childId) return [];
  const portValue = Number(element.getAttribute('data-fisherai-edge-port'));
  // -1 / NaN 表示"组连线"，端口交给 disconnect 按 parentId 自行匹配。
  const portIndex = Number.isFinite(portValue) && portValue >= 0 ? portValue : undefined;
  const grouped = element.getAttribute('data-fisherai-edge-parents');
  const parents = grouped
    ? grouped.split(' ').filter(Boolean)
    : [element.getAttribute(CUT_EDGE_ATTR)].filter((id): id is string => !!id);
  return parents.map((parentId) => ({ parentId, childId, portIndex }));
}

function markEdge(element: Element, marked: boolean) {
  const line = element.querySelector('[data-fisherai-edge-visible]') as SVGElement | null;
  if (!line) return;
  line.style.stroke = marked ? 'var(--fisherai-edge-danger, #e24b4a)' : '';
  line.style.strokeWidth = marked ? '3.6' : '';
}

/**
 * 按住 C 进入剪线模式：横划一条轨迹，划过的连线全部标红，松手一起断开。
 *
 * 用 window 捕获阶段接管指针事件，是因为画布自己的 pointerdown 会先开始拖节点或平移，
 * 剪线期间必须把它们挡在外面；抬起后立刻复原，不改变任何常驻行为。
 *
 * 三个"时好时坏"的坑，改这块时别踩回去：
 *  1. 命中判定用 elementsFromPoint（复数）而不是 elementFromPoint：组框、遮罩这类
 *     上层元素会把下面那条线挡住，单数版本永远取到最上层，线就"剪不断"。
 *  2. 指针移动是一帧一次的离散采样，手快时两点之间能横跨几百像素，必须沿着轨迹
 *     按 SAMPLE_STEP 插值，否则中间的线被整段跳过。
 *  3. 松手/松键都要"结算"而不是"丢弃"：先松 C 再松鼠标是最常见的操作顺序，
 *     旧实现里任何 keyup 都会 cleanup 掉这一笔，所以表现为"有时候剪了没反应"。
 */
export function useCanvasCutMode(React: Runtime, { containerRef, enabled, onCut }: Options) {
  const [active, setActive] = React.useState(false);
  const cutRef = React.useRef(onCut);
  cutRef.current = onCut;
  /**
   * 结算入口。松 C 与"关闭剪线模式"必须由**同一个**监听器按顺序执行：
   * 先结算再退出。拆成两个 keyup 监听器时，先跑的那个会把 active 置 false，
   * 触发 effect 清理清空已标红的集合，第二个监听器再来结算就什么都拿不到了
   * ——这就是"先松 C 再松鼠标剪不断"的原因。
   */
  const flushRef = React.useRef<((apply: boolean) => void) | null>(null);

  React.useEffect(() => {
    if (!enabled) {
      setActive(false);
      return;
    }
    const typing = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(target.closest('input, textarea, [contenteditable="true"], [contenteditable=""]'));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Esc = 取消这一笔，不剪。
        flushRef.current?.(false);
        setActive(false);
        return;
      }
      if (event.key.toLowerCase() !== 'c' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.repeat || typing(event.target)) return;
      setActive(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key !== 'c' && key !== 'escape') return;
      // 顺序很重要：先把这一笔结算掉，再退出剪线模式（退出会清理画布上的标记）。
      flushRef.current?.(true);
      setActive(false);
    };
    const onBlur = () => setActive(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [enabled]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!active || !container) return;
    const previousCursor = container.style.cursor;
    container.style.cursor = 'crosshair';
    let points: Point[] = [];
    let marked = new Map<Element, EdgeRef[]>();
    let svg: SVGSVGElement | null = null;
    let path: SVGPathElement | null = null;
    let stroking = false;
    let lastClient: Point | null = null;
    let capturedPointerId = -1;
    let cancelRequested = false;

    const ensureTrail = () => {
      if (svg) return;
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', TRAIL_CLASS);
      svg.setAttribute('aria-hidden', 'true');
      Object.assign(svg.style, {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: '1200',
        overflow: 'visible',
      });
      path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'var(--fisherai-edge-danger, #e24b4a)');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-dasharray', '6 4');
      path.setAttribute('opacity', '0.9');
      svg.append(path);
      container.append(svg);
    };
    const drawTrail = () => {
      if (!path || !svg) return;
      const box = container.getBoundingClientRect();
      svg.setAttribute('viewBox', `0 0 ${Math.max(1, box.width)} ${Math.max(1, box.height)}`);
      path.setAttribute(
        'd',
        points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' '),
      );
    };
    /** 单点命中：遍历该点上所有叠着的元素，任意一层是连线就算剪到。 */
    const hitAt = (x: number, y: number) => {
      const stack = document.elementsFromPoint(x, y);
      for (const element of stack) {
        const edge = element.closest?.(`[${CUT_EDGE_ATTR}]`);
        if (!edge || marked.has(edge)) continue;
        const refs = readEdges(edge);
        if (!refs.length) continue;
        marked.set(edge, refs);
        markEdge(edge, true);
      }
    };
    /** 沿上一采样点到当前点插值，避免快速划动时漏掉中间的连线。 */
    const strokeTo = (x: number, y: number) => {
      if (lastClient) {
        const dx = x - lastClient.x,
          dy = y - lastClient.y,
          steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / SAMPLE_STEP));
        for (let step = 1; step <= steps; step += 1)
          hitAt(lastClient.x + (dx * step) / steps, lastClient.y + (dy * step) / steps);
      } else {
        hitAt(x, y);
      }
      lastClient = { x, y };
    };
    const cleanup = () => {
      // 只要这一笔还没结算（stroking），离开剪线模式就把它结算掉：
      // 这样无论 keyup / pointerup / effect 清理谁先到，划线结果都不会丢。
      const pending =
        stroking && !cancelRequested ? [...marked.values()].flat() : ([] as EdgeRef[]);
      cancelRequested = false;
      try {
        if (capturedPointerId >= 0 && container.hasPointerCapture?.(capturedPointerId))
          container.releasePointerCapture(capturedPointerId);
      } catch {
        /* 忽略：捕获可能已被浏览器回收。 */
      }
      capturedPointerId = -1;
      for (const edge of marked.keys()) markEdge(edge, false);
      marked = new Map();
      points = [];
      lastClient = null;
      svg?.remove();
      svg = null;
      path = null;
      stroking = false;
      container.style.cursor = previousCursor;
      if (pending.length) cutRef.current(pending);
    };
    /** 结算：把标红过的连线一次性断开（松鼠标或松 C 都会走到这里）。 */
    const flush = (apply = true) => {
      cancelRequested = !apply;
      cleanup();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (!container.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
      stroking = true;
      lastClient = null;
      // 捕获指针：划出窗口再松手也能收到 pointerup，不会留下一笔"悬空"的轨迹。
      try {
        container.setPointerCapture(event.pointerId);
        capturedPointerId = event.pointerId;
      } catch {
        /* 指针已经抬起/不支持捕获时忽略即可。 */
      }
      const box = container.getBoundingClientRect();
      points = [{ x: event.clientX - box.left, y: event.clientY - box.top }];
      ensureTrail();
      drawTrail();
      strokeTo(event.clientX, event.clientY);
      // 剪完一笔后光标会被 cleanup 还原，按住 C 继续划时再切回十字。
      container.style.cursor = 'crosshair';
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!stroking) return;
      event.preventDefault();
      event.stopPropagation();
      const box = container.getBoundingClientRect();
      points.push({ x: event.clientX - box.left, y: event.clientY - box.top });
      drawTrail();
      strokeTo(event.clientX, event.clientY);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!stroking) return;
      event.preventDefault();
      event.stopPropagation();
      flush();
    };
    // 交给激活用的那个 keyup 监听器按"先结算后退出"的顺序调用。
    flushRef.current = (apply: boolean) => {
      if (stroking) flush(apply);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    return () => {
      flushRef.current = null;
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      cleanup();
    };
  }, [active, containerRef]);

  return active;
}
