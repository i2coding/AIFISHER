import type { CanvasComponent } from '../app/canvasComponentType';
import type * as ReactTypes from 'react';
import { isResizableMediaNode } from '../media/mediaNodeSizing';
type Runtime = Pick<typeof ReactTypes, 'createElement' | 'useState' | 'useRef' | 'useEffect'>;
interface NodeData {
  id: string;
  type: string;
  x: number;
  y: number;
  title?: string;
  parentIds?: string[];
  projectId?: string;
  networkUrl?: string;
  resultAspectRatio?: string;
  [key: string]: unknown;
}
type Icon = ReactTypes.ComponentType<{ size: number; className?: string; strokeWidth?: number }>;
interface ConnectorProps {
  nodeId: string;
  side: 'left' | 'right';
  zoom?: number;
  selected?: boolean;
  hasIncoming?: boolean;
  onConnectorDown(event: ReactTypes.PointerEvent, id: string, side: 'left' | 'right'): void;
}
const validZoom = (zoom = 1) => (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
/** 圆点直径与可点击热区直径：热区比圆点大得多，鼠标不用瞄准。 */
const ANCHOR_SIZE = 28;
const ANCHOR_HIT_SIZE = 50;

/**
 * 节点输出端索引：场景在渲染前登记一次，输出圆点据此判断"有没有连线"。
 * 输入侧直接看节点自己的 parentIds，输出侧是反向关系，只能靠这张表。
 */
let nodesWithChildren: ReadonlySet<string> = new Set<string>();
export function registerNodeConnections(
  nodes: readonly { id: string; parentIds?: readonly string[] }[],
): void {
  const next = new Set<string>();
  for (const node of nodes) for (const parentId of node.parentIds ?? []) next.add(parentId);
  nodesWithChildren = next;
}

export function CanvasConnector(_React: Runtime, props: ConnectorProps, _icon?: Icon) {
  const { side, nodeId, onConnectorDown } = props;
  // 左端看自己有没有上游，右端看有没有下游被别人引用。
  const connected = side === 'left' ? props.hasIncoming === true : nodesWithChildren.has(nodeId);
  return (
    <div
      className="absolute z-20 flex items-center justify-center pointer-events-auto rounded-full"
      style={{
        width: ANCHOR_HIT_SIZE,
        height: ANCHOR_HIT_SIZE,
        [side]: -(ANCHOR_HIT_SIZE / 2),
        top: '50%',
        transform: 'translateY(-50%)',
      }}
    >
      <button
        type="button"
        aria-label={side === 'left' ? '连接输入' : '连接输出'}
        aria-pressed={connected}
        data-fisherai-connector-node-id={nodeId}
        data-fisherai-connector-side={side}
        data-fisherai-connector-connected={connected ? 'true' : 'false'}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.stopPropagation();
          onConnectorDown(event, nodeId, side);
        }}
        className={`rounded-full border-2 cursor-crosshair transition-colors duration-150 hover:scale-110 focus-visible:scale-110 ${
          connected
            ? 'bg-[var(--af-text-secondary)] border-[var(--af-text-secondary)]'
            : 'bg-[var(--af-surface)] border-[var(--af-border-control)] hover:border-[var(--af-text-secondary)]'
        }`}
        style={{ width: ANCHOR_SIZE, height: ANCHOR_SIZE, transformOrigin: 'center' }}
      />
    </div>
  );
}
export function CanvasConnectors(
  React: Runtime,
  props: Omit<ConnectorProps, 'side'> & { nodeType: string },
  Connector: CanvasComponent,
) {
  if (props.nodeType === 'ComfyUI') return null;
  return (
    <>
      {React.createElement(Connector, { ...props, side: 'left' })}
      {props.nodeType !== 'Image Compare' &&
        React.createElement(Connector, { ...props, side: 'right' })}
    </>
  );
}
interface FrameProps {
  data: NodeData;
  selected?: boolean;
  isHoveredForConnection?: boolean;
  isInvalidHover?: boolean;
  children?: ReactTypes.ReactNode;
  controls?: ReactTypes.ReactNode;
  className?: string;
  onNodePointerDown(event: ReactTypes.PointerEvent, id: string): void;
  onContextMenu(event: ReactTypes.MouseEvent, id: string): void;
  onConnectorDown: ConnectorProps['onConnectorDown'];
  onMouseEnter?: ReactTypes.MouseEventHandler;
  onMouseLeave?: ReactTypes.MouseEventHandler;
  onResizeStart?(event: ReactTypes.PointerEvent, id: string, width: number, height: number): void;
  isResizing?: boolean;
  isDragging?: boolean;
  zIndex?: number;
  zoom?: number;
  isBareCard?: boolean;
}
export function CanvasNodeFrame(
  React: Runtime,
  props: FrameProps,
  dependencies: {
    Connectors: CanvasComponent;
    getWidth(node: NodeData): number;
    getHeight(node: NodeData): number;
  },
) {
  const {
    data,
    selected,
    isHoveredForConnection: hovered,
    isInvalidHover: invalid,
    isBareCard,
    isResizing,
  } = props;
  const width = dependencies.getWidth(data),
    height = dependencies.getHeight(data),
    zoom = validZoom(props.zoom),
    inverse = 1 / zoom;
  return (
    <div
      data-node-id={data.id}
      data-node-selected={selected ? 'true' : 'false'}
      className={`absolute flex items-center group/node touch-none pointer-events-auto ${props.className || ''}`}
      style={{
        transform: `translate(${data.x}px, ${data.y}px)`,
        transition: 'box-shadow 0.2s',
        zIndex: props.zIndex ?? (selected ? 30 : 10),
        willChange: props.isDragging || isResizing ? 'transform' : 'auto',
      }}
      onPointerDown={(event) => {
        if (event.button !== 1) props.onNodePointerDown(event, data.id);
      }}
      onContextMenu={(event) => props.onContextMenu(event, data.id)}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
    >
      {React.createElement(dependencies.Connectors, {
        nodeId: data.id,
        onConnectorDown: props.onConnectorDown,
        nodeType: data.type,
        zoom,
        selected,
        hasIncoming: (data.parentIds?.length ?? 0) > 0,
      })}
      <div className="relative group/nodecard flex flex-col items-center">
        <div
          className={
            isBareCard
              ? 'relative flex flex-col bg-transparent'
              : `relative rounded-lg border flex flex-col bg-[var(--af-surface)] ${isResizing ? '' : 'transition-[border-color,box-shadow,ring] duration-200'} ${hovered ? (invalid ? 'border-red-500 ring-4 ring-red-500/50 scale-[1.02]' : 'border-blue-500 ring-4 ring-blue-500/30 scale-[1.02]') : selected ? 'border-blue-500 ring-2 ring-blue-500/50 shadow-[0_0_20px_rgba(59,130,246,0.3)]' : 'border-[var(--af-border)] shadow-2xl'}`
          }
          style={{
            width: `${width}px`,
            height: `${height}px`,
          }}
        >
          {props.children}
        </div>
        {props.controls && (
          <div
            className="absolute left-1/2 z-[100] flex flex-col items-center"
            style={{
              top: `calc(100% + ${16 * inverse}px)`,
              transform: `translateX(-50%) scale(${inverse})`,
              transformOrigin: 'top center',
              width: '680px',
            }}
          >
            {props.controls}
          </div>
        )}
        {selected && props.onResizeStart && isResizableMediaNode(data) && (
          <div
            data-fisherai-media-resize-handle="true"
            aria-label="缩放媒体节点"
            className="absolute -bottom-5 -right-5 w-9 h-9 cursor-nwse-resize flex items-center justify-center group/resize opacity-50 hover:opacity-100 transition-opacity"
            style={{ zIndex: 40 }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.stopPropagation();
              props.onResizeStart?.(event, data.id, width, height);
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 32 32"
              fill="none"
              className="text-[var(--af-text-muted)] group-hover/resize:text-[var(--af-info)] transition-all duration-200 drop-shadow-[0_0_4px_rgba(0,0,0,0.6)]"
            >
              <path
                d="M 12 28 C 22 28 28 22 28 12"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}

const titles: Record<string, string> = {
  'Upload Image': '上传图片',
  'Upload Video': '上传视频',
  'Upload Audio': '上传音频',
  Image: '图片生成',
  Video: '视频生成',
  Audio: '音频生成',
  'Image Compare': '图片对比',
  'Image Composite': '图片拼合',
  Text: '文本输入',
  ComfyUI: 'ComfyUI',
};
interface HeaderProps {
  data: NodeData;
  children?: ReactTypes.ReactNode;
  selected?: boolean;
  onUpdate(id: string, patch: { title?: string }): void;
}
interface HeaderIcons {
  Image: Icon;
  Video: Icon;
  Audio: Icon;
  Text: Icon;
  Compare: Icon;
  Composite: Icon;
  Workflow: Icon;
}
export function CanvasNodeHeader(React: Runtime, props: HeaderProps, icons: HeaderIcons) {
  const { data, selected } = props;
  const defaultTitle = titles[data.type] || data.type,
    title = data.title || defaultTitle;
  const [editing, setEditing] = React.useState(false),
    [draft, setDraft] = React.useState(title);
  const draftRef = React.useRef(title),
    activeRef = React.useRef(false),
    inputRef = React.useRef<HTMLInputElement>(null),
    titleRef = React.useRef(title);
  titleRef.current = title;
  React.useEffect(() => {
    activeRef.current = false;
    setEditing(false);
    setDraft(titleRef.current);
    draftRef.current = titleRef.current;
  }, [data.id, data.projectId, data.type]);
  React.useEffect(() => {
    if (!activeRef.current) {
      setDraft(title);
      draftRef.current = title;
    }
  }, [title]);
  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  const commit = () => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setEditing(false);
    const value = draftRef.current.trim();
    const next = value === defaultTitle ? undefined : value;
    if (value && next !== data.title) props.onUpdate(data.id, { title: next });
  };
  const cancel = () => {
    activeRef.current = false;
    draftRef.current = title;
    setDraft(title);
    setEditing(false);
  };
  const start = () => {
    activeRef.current = true;
    draftRef.current = title;
    setDraft(title);
    setEditing(true);
  };
  const kind = data.type.replace('Upload ', '');
  const Icon =
    icons[kind as keyof HeaderIcons] ||
    (data.type === 'Image Compare'
      ? icons.Compare
      : data.type === 'Image Composite'
        ? icons.Composite
        : data.type === 'ComfyUI'
          ? icons.Workflow
          : null);
  const dimensions = data.resultAspectRatio?.match(/^(\d+)\/(\d+)$/);
  const size =
    dimensions && Number(dimensions[1]) > 50 && Number(dimensions[2]) > 50
      ? `${Number(dimensions[1])}x${Number(dimensions[2])}`
      : null;
  return (
    <div
      data-af-node-title
      className="absolute pointer-events-auto flex items-center justify-between bg-transparent text-[var(--af-text)]"
      style={{ bottom: 'calc(100% + 4px)', left: 0, right: 0, width: '100%' }}
    >
      <div className="flex items-center min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center w-full overflow-hidden">
            {Icon && <Icon size={12} className="mr-1 flex-shrink-0" />}
            <input
              ref={inputRef}
              aria-label="节点名称"
              type="text"
              value={draft}
              onChange={(event) => {
                draftRef.current = event.target.value;
                setDraft(event.target.value);
              }}
              onBlur={commit}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commit();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancel();
                }
              }}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              className="text-[11px] font-bold px-0 py-0.5 rounded outline-none transition-all w-full bg-transparent"
              style={{
                color: data.networkUrl ? 'var(--af-focus)' : 'var(--af-text)',
                border: 'none',
              }}
            />
          </div>
        ) : (
          <div
            role="button"
            tabIndex={0}
            aria-label={`重命名 ${title}`}
            className="text-[11px] font-bold px-1 py-0.5 rounded cursor-text select-none whitespace-nowrap overflow-hidden text-ellipsis flex items-center transition-colors min-w-0"
            onDoubleClick={(event) => {
              event.stopPropagation();
              start();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'F2') {
                event.preventDefault();
                event.stopPropagation();
                start();
              }
            }}
            style={{
              color: data.networkUrl
                ? 'var(--af-info)'
                : selected
                  ? 'var(--af-text)'
                  : 'var(--af-text-secondary)',
            }}
            title={title}
          >
            {Icon && <Icon size={12} className="mr-1 flex-shrink-0" />}
            <span className="truncate">{title}</span>
          </div>
        )}
      </div>
      {size && (
        <div className="text-[9px] font-medium text-[var(--af-text-muted)] px-1 py-0.5 whitespace-nowrap flex-shrink-0">
          {size}
        </div>
      )}
      {props.children}
    </div>
  );
}

export function CanvasNode(
  React: Pick<Runtime, 'createElement'>,
  props: Record<string, unknown> & {
    data: { type: string; kind?: string; comfyMode?: string };
    isVisible?: boolean;
  },
  components: Record<string, CanvasComponent>,
) {
  if (props.isVisible === false) return null;
  const type = props.data.type.replace('Upload ', '');
  const component =
    type === 'ComfyUI'
      ? props.data.kind === 'workflow'
        ? components.Workflow
        : props.data.comfyMode === 'minimax-h3-t2va'
          ? components.MiniMax
          : components.LegacyWorkflow
      : components[type];
  return component ? React.createElement(component, props) : null;
}
