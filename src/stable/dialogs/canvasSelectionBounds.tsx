import type * as ReactTypes from 'react';
import type { CanvasViewport } from '../canvas/canvasNavigation';
import type { CanvasGroup } from '../canvas/canvasGroups';
import type { CanvasNodeFrame, SelectionResizeHandle } from '../canvas/canvasEditing';
import type { MinimapNode, NodeMeasurement } from './minimapGeometry';
type Runtime = Pick<
  typeof ReactTypes,
  'createElement' | 'Fragment' | 'useState' | 'useRef' | 'useEffect' | 'useLayoutEffect'
>;
interface Props {
  documentEpoch?: number;
  selectedNodes: MinimapNode[];
  group?: CanvasGroup | null;
  viewport: CanvasViewport;
  onGroup(): void;
  onUngroup(): void;
  onBoundingBoxPointerDown(event: ReactTypes.PointerEvent): void;
  onSelectionResizeStart?(
    event: ReactTypes.PointerEvent,
    handle: SelectionResizeHandle,
    frames: CanvasNodeFrame[],
  ): void;
  onRenameGroup?(id: string, label: string): void;
  onToggleGridSlider?(): void;
  onCreateCollage?(): void;
  showGridSlider?: boolean;
  gridColumns?: number;
  isSelected?: boolean;
  /** 组自己存的框（不再随成员包围盒变化）。 */
  frameOverride?: { left: number; top: number; right: number; bottom: number } | null;
  /** 组框连接点是否已经有连线（用来做空心/实心）。 */
  batchConnectorConnected?: { left: boolean; right: boolean };
  /** 拖动组框右下角：只改组框，不动成员尺寸。 */
  onGroupResizeStart?(
    event: ReactTypes.PointerEvent,
    groupId: string,
    box: { left: number; top: number; width: number; height: number },
  ): void;
  isDragging?: boolean;
  isPanning?: boolean;
  onBatchConnectorDown?(event: ReactTypes.PointerEvent, side: 'left' | 'right'): void;
}
export function CanvasSelectionBounds(React: Runtime, props: Props, measure: NodeMeasurement) {
  const {
    documentEpoch,
    selectedNodes,
    group,
    viewport,
    onGroup,
    onUngroup,
    onBoundingBoxPointerDown,
    onSelectionResizeStart,
    onToggleGridSlider,
    onCreateCollage,
    showGridSlider,
    gridColumns,
    isSelected,
    frameOverride,
    batchConnectorConnected,
    onGroupResizeStart,
    isDragging,
    isPanning = false,
    onBatchConnectorDown,
  } = props;
  const [editing, setEditing] = React.useState(false),
    [draft, setDraft] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null),
    editOwnerRef = React.useRef<{ id: string; epoch: number | undefined } | null>(null),
    finishedRef = React.useRef(true),
    currentRef = React.useRef(props);
  React.useLayoutEffect(() => {
    currentRef.current = props;
  });
  React.useEffect(() => {
    finishedRef.current = true;
    editOwnerRef.current = null;
    setEditing(false);
  }, [group?.id, documentEpoch]);
  React.useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  const startRename = (event: ReactTypes.MouseEvent) => {
    event.stopPropagation();
    if (!group) return;
    finishedRef.current = false;
    editOwnerRef.current = { id: group.id, epoch: documentEpoch };
    setDraft(group.label);
    setEditing(true);
  };
  const commitTitle = () => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const owner = editOwnerRef.current,
      label = draft.trim();
    setEditing(false);
    if (
      owner &&
      currentRef.current.group?.id === owner.id &&
      currentRef.current.documentEpoch === owner.epoch &&
      label &&
      label !== currentRef.current.group.label
    )
      currentRef.current.onRenameGroup?.(owner.id, label);
  };
  const titleKeyDown = (event: ReactTypes.KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      finishedRef.current = true;
      setEditing(false);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commitTitle();
    }
  };
  const byId = new Map(selectedNodes.map((node) => [node.id, node]));
  const frames = selectedNodes.map((node) => {
    const parent = byId.get(node.parentIds?.[0] || ''),
      width = measure.width(node, parent),
      height = measure.height(node, parent),
      minSize = node.type === 'Text' ? 252 : 200;
    return {
      id: node.id,
      x: node.x,
      y: node.y,
      width,
      height,
      minWidth: Math.min(width, minSize),
      minHeight: Math.min(height, minSize),
    };
  });
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const frame of frames) {
    left = Math.min(left, frame.x - 50);
    top = Math.min(top, frame.y - 50);
    right = Math.max(right, frame.x + frame.width + 50);
    bottom = Math.max(bottom, frame.y + frame.height + 50);
  }
  const isGroup = !!group,
    pinned = isGroup && frameOverride ? frameOverride : null,
    boxLeft = pinned ? pinned.left : left,
    boxTop = pinned ? pinned.top : top,
    width = pinned ? pinned.right - pinned.left : right - left,
    height = pinned ? pinned.bottom - pinned.top : bottom - top,
    canGroup = selectedNodes.length > 1 && !isGroup,
    controlScale = Math.min(1 / viewport.zoom, 1.5),
    accent = '#3b82f6',
    borderColor = isSelected ? accent : '#444';
  const resizeSelection = (event: ReactTypes.PointerEvent, handle: SelectionResizeHandle) => {
    if (event.button !== 0 || !onSelectionResizeStart) return;
    event.stopPropagation();
    event.preventDefault();
    onSelectionResizeStart(event, handle, frames);
  };
  if (
    !frames.length ||
    (frames.length === 1 && !group) ||
    ![left, top, width, height, controlScale].every(Number.isFinite)
  )
    return null;
  return (
    <div
      data-selection-bounding-box={'true'}
      data-fisherai-group-id={group?.id}
      className={`absolute pointer-events-auto ${isPanning ? 'cursor-grabbing' : 'cursor-move'}`}
      style={{
        left: boxLeft,
        top: boxTop,
        width: width,
        height: height,
        border: isGroup
          ? `2px solid ${isSelected ? accent : 'rgba(148,163,184,0.55)'}`
          : `1.5px dashed ${borderColor}`,
        borderRadius: isGroup ? '16px' : '12px',
        backgroundColor: isGroup
          ? isSelected
            ? 'rgba(59,130,246,0.15)'
            : 'rgba(68,68,68,0.22)'
          : 'transparent',
        boxShadow: isGroup
          ? isSelected
            ? '0 16px 40px rgba(15,23,42,0.16)'
            : '0 12px 30px rgba(15,23,42,0.08)'
          : undefined,
        zIndex: 5,
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onBoundingBoxPointerDown(event);
        }
      }}
    >
      {/* 双实线的第二道：内嵌一圈，和外面那圈留 4px 间隙 */}
      {isGroup && (
        <div
          aria-hidden={'true'}
          data-fisherai-group-frame-inner={'true'}
          className={'absolute pointer-events-none'}
          style={{
            inset: 4,
            borderRadius: 12,
            border: `1.5px solid ${
              isSelected ? 'rgba(59,130,246,0.45)' : 'rgba(148,163,184,0.38)'
            }`,
            backgroundColor: 'transparent',
          }}
        />
      )}
      {!isGroup &&
        [
          { pos: 'top-left', cursor: 'nw-resize', top: -4, left: -4 },
          {
            pos: 'top',
            cursor: 'n-resize',
            top: -4,
            left: '50%',
            transform: 'translateX(-50%)',
          },
          { pos: 'top-right', cursor: 'ne-resize', top: -4, right: -4 },
          {
            pos: 'right',
            cursor: 'e-resize',
            top: '50%',
            right: -4,
            transform: 'translateY(-50%)',
          },
          { pos: 'bottom-right', cursor: 'se-resize', bottom: -4, right: -4 },
          {
            pos: 'bottom',
            cursor: 's-resize',
            bottom: -4,
            left: '50%',
            transform: 'translateX(-50%)',
          },
          { pos: 'bottom-left', cursor: 'sw-resize', bottom: -4, left: -4 },
          {
            pos: 'left',
            cursor: 'w-resize',
            top: '50%',
            left: -4,
            transform: 'translateY(-50%)',
          },
        ].map((event) => (
          <div
            data-fisherai-selection-resize-handle={event.pos}
            aria-label={'批量缩放选中节点'}
            className={
              'absolute w-2 h-2 bg-[var(--af-primary)] border rounded-sm pointer-events-auto'
            }
            style={{
              top: event.top,
              left: event.left,
              right: event.right,
              bottom: event.bottom,
              transform: event.transform,
              cursor: event.cursor,
              borderColor: borderColor,
            }}
            onPointerDown={(pointer) =>
              resizeSelection(pointer, event.pos as SelectionResizeHandle)
            }
            key={event.pos}
          />
        ))}
      {/* 组框右下角的缩放柄：只改组框本身，成员尺寸不动。 */}
      {isGroup && group && onGroupResizeStart && !isDragging && (
        <div
          data-fisherai-group-resize-handle={'true'}
          aria-label={'缩放整组'}
          title={'拖动缩放整组'}
          className={
            'absolute border bg-[var(--af-primary)] pointer-events-auto z-20 transition-transform duration-150 hover:scale-110'
          }
          style={{
            width: 16,
            height: 16,
            right: -8,
            bottom: -8,
            borderRadius: 5,
            cursor: 'nwse-resize',
            borderColor: borderColor,
            boxShadow: '0 2px 8px rgba(0,0,0,0.28)',
            transform: `scale(${controlScale})`,
            transformOrigin: 'center',
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            event.preventDefault();
            onGroupResizeStart(event, group.id, {
              left: boxLeft,
              top: boxTop,
              width,
              height,
            });
          }}
        />
      )}
      {/* 组框和多选都提供连接点：把整组成员当成一个输出，直接连到下游。 */}
      {onBatchConnectorDown &&
        !isDragging &&
        (isGroup || (isSelected && selectedNodes.length > 1)) &&
        [
          { side: 'left' as const, label: '整组输入连线', position: { left: -31 } },
          { side: 'right' as const, label: '整组输出连线', position: { right: -31 } },
        ].map((connector) => {
          const connected =
            connector.side === 'left'
              ? batchConnectorConnected?.left === true
              : batchConnectorConnected?.right === true;
          const accent = 'var(--af-primary)';
          return (
            <div
              key={connector.side}
              className={'absolute z-20 flex items-center justify-center pointer-events-auto'}
              style={{
                width: 62,
                height: 62,
                top: '50%',
                transform: 'translateY(-50%)',
                ...connector.position,
              }}
            >
              <button
                type={'button'}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.preventDefault();
                  onBatchConnectorDown(event, connector.side);
                }}
                title={connector.label}
                aria-label={connector.label}
                aria-pressed={connected}
                data-fisherai-group-connector={connector.side}
                data-fisherai-group-connector-connected={connected ? 'true' : 'false'}
                className={
                  'group/dot relative flex items-center justify-center rounded-full border-2 transition-all duration-150 ease-out cursor-crosshair hover:scale-[1.08] focus-visible:scale-[1.08] focus-visible:outline-none'
                }
                style={{
                  width: 38,
                  height: 38,
                  borderColor: connected ? accent : 'var(--af-border-control)',
                  background: 'var(--af-surface)',
                  boxShadow: connected
                    ? '0 0 0 4px rgba(59,130,246,0.16), 0 4px 14px rgba(0,0,0,0.28)'
                    : '0 0 0 4px rgba(0,0,0,0.12), 0 4px 14px rgba(0,0,0,0.26)',
                }}
              >
                <span
                  className={'block rounded-full transition-all duration-150'}
                  style={{
                    width: connected ? 16 : 10,
                    height: connected ? 16 : 10,
                    background: connected ? accent : 'var(--af-text-muted)',
                    opacity: connected ? 1 : 0.55,
                  }}
                />
              </button>
            </div>
          );
        })}
      {isGroup && group && (
        <div
          data-fisherai-group-title={'true'}
          className={'absolute pointer-events-auto'}
          style={{
            bottom: 'calc(100% + 8px)',
            left: 0,
            transform: `scale(${controlScale})`,
            transformOrigin: 'bottom left',
            display: 'inline-grid',
            alignItems: 'center',
            padding: '5px 11px 5px 9px',
            border: '1px solid rgba(148,163,184,0.5)',
            borderLeft: `3px solid ${accent}`,
            borderRadius: '10px',
            backgroundColor: 'var(--af-surface)',
            boxShadow: '0 8px 22px rgba(15,23,42,0.18)',
          }}
        >
          <span
            className={'text-sm font-medium px-1 py-1 invisible'}
            style={{ gridArea: '1/1', whiteSpace: 'pre', minWidth: '60px' }}
          >
            {(editing ? draft : group.label) || ' '}
          </span>
          {editing ? (
            <input
              ref={inputRef}
              aria-label="分组名称"
              type={'text'}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={titleKeyDown}
              onPointerDown={(event) => {
                if (event.button !== 1) {
                  event.stopPropagation();
                }
              }}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              className={'text-sm font-bold px-1 py-1 rounded outline-none transition-all'}
              style={{
                gridArea: '1/1',
                width: '100%',
                backgroundColor: 'transparent',
                color: accent,
                border: 'none',
              }}
            />
          ) : (
            <div
              className={
                'text-sm font-bold px-1 py-1 rounded cursor-text whitespace-nowrap transition-colors'
              }
              style={{
                gridArea: '1/1',
                backgroundColor: 'transparent',
                color: isSelected ? 'var(--af-text)' : 'var(--af-text)',
                border: 'none',
              }}
              onPointerDown={(event) => {
                if (event.button !== 1) {
                  event.stopPropagation();
                }
              }}
              onDoubleClick={startRename}
            >
              {group.label}
            </div>
          )}
        </div>
      )}
      {canGroup && isSelected && !isDragging && (
        <div
          className={
            'absolute flex gap-2 pointer-events-auto animate-in fade-in slide-in-from-bottom-1 duration-200'
          }
          style={{
            top: -10,
            right: 0,
            transform: `scale(${controlScale}) translateY(-100%)`,
            transformOrigin: 'bottom right',
          }}
        >
          {onCreateCollage && (
            <button
              onClick={onCreateCollage}
              className={
                'bg-[var(--af-input)] border border-[var(--af-border-control)] hover:bg-[var(--af-surface-raised)] text-[var(--af-text)] text-sm px-4 py-2.5 rounded-[12px] flex items-center gap-2 transition-colors'
              }
            >
              <svg
                width={'16'}
                height={'16'}
                viewBox={'0 0 24 24'}
                fill={'none'}
                stroke={'currentColor'}
                strokeWidth={'2'}
              >
                <rect x={'3'} y={'5'} width={'7'} height={'6'} />
                <rect x={'14'} y={'5'} width={'7'} height={'6'} />
                <rect x={'3'} y={'14'} width={'7'} height={'5'} />
                <rect x={'14'} y={'14'} width={'7'} height={'5'} />
              </svg>
              {'拼图'}
            </button>
          )}
          <div className={'relative flex items-center'}>
            <button
              onClick={() => {
                if (onToggleGridSlider) {
                  onToggleGridSlider();
                }
              }}
              className={`bg-[var(--af-input)] border border-[var(--af-border-control)] hover:bg-[var(--af-surface-raised)] text-[var(--af-text)] text-sm px-4 py-2.5 rounded-[12px] flex items-center gap-2 transition-colors ${showGridSlider ? 'border-[var(--af-info)] bg-[var(--af-info-bg)]' : ''}`}
            >
              <svg
                width={'16'}
                height={'16'}
                viewBox={'0 0 24 24'}
                fill={'none'}
                stroke={'currentColor'}
                strokeWidth={'2'}
              >
                <rect x={'3'} y={'3'} width={'7'} height={'7'} />
                <rect x={'14'} y={'3'} width={'7'} height={'7'} />
                <rect x={'14'} y={'14'} width={'7'} height={'7'} />
                <rect x={'3'} y={'14'} width={'7'} height={'7'} />
              </svg>
              {showGridSlider ? `列数: ${gridColumns}` : '排列'}
            </button>
          </div>
          <button
            onClick={onGroup}
            className={
              'bg-[var(--af-input)] border border-[var(--af-border-control)] hover:bg-[var(--af-surface-raised)] text-[var(--af-text)] text-sm px-4 py-2.5 rounded-[12px] flex items-center gap-2 transition-colors'
            }
          >
            <svg
              width={'16'}
              height={'16'}
              viewBox={'0 0 24 24'}
              fill={'none'}
              stroke={'currentColor'}
              strokeWidth={'2'}
            >
              <rect x={'3'} y={'3'} width={'7'} height={'7'} />
              <rect x={'14'} y={'3'} width={'7'} height={'7'} />
              <rect x={'14'} y={'14'} width={'7'} height={'7'} />
              <rect x={'3'} y={'14'} width={'7'} height={'7'} />
            </svg>
            {'打组'}
          </button>
        </div>
      )}
      {isGroup && isSelected && !isDragging && (
        <div
          className={
            'absolute flex gap-2 pointer-events-auto animate-in fade-in slide-in-from-bottom-1 duration-200'
          }
          style={{
            top: -10,
            left: '50%',
            transform: `translateX(-50%) scale(${controlScale}) translateY(-100%)`,
            transformOrigin: 'bottom center',
          }}
        >
          <button
            onClick={onUngroup}
            className={
              'bg-[var(--af-input)] border border-[var(--af-border-control)] hover:bg-[var(--af-surface-raised)] text-[var(--af-text)] text-sm px-4 py-2.5 rounded-[12px] flex items-center gap-2 transition-colors'
            }
          >
            <svg
              width={'16'}
              height={'16'}
              viewBox={'0 0 24 24'}
              fill={'none'}
              stroke={'currentColor'}
              strokeWidth={'2'}
            >
              <rect x={'3'} y={'3'} width={'7'} height={'7'} />
              <rect x={'14'} y={'3'} width={'7'} height={'7'} />
              <rect x={'14'} y={'14'} width={'7'} height={'7'} />
              <rect x={'3'} y={'14'} width={'7'} height={'7'} />
              <line x1={'3'} y1={'3'} x2={'21'} y2={'21'} />
            </svg>
            {'解组'}
          </button>
        </div>
      )}
    </div>
  );
}
