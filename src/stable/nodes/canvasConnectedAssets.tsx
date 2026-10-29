import { promptAssetIndex, promptAssetLabel } from '../prompt/promptDocument';
import type * as ReactTypes from 'react';
import { createPortal } from 'react-dom';
import { disconnectCanvasNodes, type CanvasConnectionNode } from '../canvas/canvasConnections';

export interface ConnectedAsset {
  id: string;
  type?: string;
  url?: string;
  lastFrame?: string;
  [key: string]: unknown;
}
export interface ConnectedAssetsProps {
  node: CanvasConnectionNode;
  connectedImageNodes?: ConnectedAsset[];
  disabled?: boolean;
  onUpdate(id: string, patch: Partial<CanvasConnectionNode>): void;
}
type Icon = ReactTypes.ComponentType<{ size: number; className?: string }>;
interface Components {
  ImageIcon: Icon;
  VideoIcon: Icon;
  AudioIcon: Icon;
  RemoveIcon: Icon;
}

/**
 * 参考图的顺序就是 parentIds 的顺序：缩略图上的「图片1/图片2」由数组下标推导，
 * 所以拖动排序只要把这两个数组一起搬动，编号和生成时的引用顺序自然就跟着变。
 *
 * parentIds 里出现空串表示这是 ComfyUI 的固定占位槽位（槽位号由端口决定，不是顺序），
 * 那种情况不在这里重排，避免把占位槽的顺序搅乱。
 */
function reorderParentIds(
  node: CanvasConnectionNode,
  fromId: string,
  toId: string,
  placement: 'before' | 'after',
): Pick<CanvasConnectionNode, 'parentIds' | 'sourcePortIndices'> | null {
  const parentIds = [...(node.parentIds ?? [])];
  if (parentIds.includes('')) return null;
  const from = parentIds.indexOf(fromId);
  const to = parentIds.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return null;
  const sourcePortIndices = [...(node.sourcePortIndices ?? [])];
  while (sourcePortIndices.length < parentIds.length) sourcePortIndices.push(0);
  const [movedId] = parentIds.splice(from, 1);
  const [movedPort] = sourcePortIndices.splice(from, 1);
  let insertAt = parentIds.indexOf(toId);
  if (insertAt < 0) return null;
  if (placement === 'after') insertAt += 1;
  parentIds.splice(insertAt, 0, movedId);
  sourcePortIndices.splice(insertAt, 0, movedPort ?? 0);
  return { parentIds, sourcePortIndices };
}


export function CanvasConnectedAssets(
  React: Pick<typeof ReactTypes, 'createElement' | 'useState' | 'useRef' | 'useEffect'>,
  { node, connectedImageNodes = [], disabled = false, onUpdate }: ConnectedAssetsProps,
  { ImageIcon, VideoIcon, AudioIcon, RemoveIcon }: Components,
) {
  const [focused, setFocused] = React.useState<string | null>(null);
  const [previewId, setPreviewId] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState('all');
  const [hover, setHover] = React.useState<{ id: string; left: number; top: number } | null>(null);
  const [dragAssetId, setDragAssetId] = React.useState<string | null>(null);
  const [dropHint, setDropHint] = React.useState<{ id: string; placement: 'before' | 'after' } | null>(
    null,
  );
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keepHover = () => clearTimeout(closeTimer.current);
  const closeHover = () => {
    keepHover();
    closeTimer.current = setTimeout(() => setHover(null), 160);
  };
  const showHover = (id: string, target: HTMLElement) => {
    keepHover();
    const box = target.getBoundingClientRect();
    const height = Math.min(300, window.innerHeight - 24);
    setHover({
      id,
      left: Math.max(12, Math.min(box.left, window.innerWidth - 252)),
      top:
        box.top >= height + 12
          ? box.top - height - 8
          : Math.max(12, Math.min(box.bottom + 8, window.innerHeight - height - 12)),
    });
  };
  React.useEffect(() => {
    const dismiss = (event?: Event) => {
      if (event?.target instanceof Element && event.target.closest('[data-fisherai-asset-preview]')) return;
      clearTimeout(closeTimer.current);
      setHover(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        dismiss();
        setPreviewId(null);
      }
    };
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('keydown', escape);
    return () => {
      clearTimeout(closeTimer.current);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('keydown', escape);
    };
  }, []);
  const index = promptAssetIndex(connectedImageNodes);
  const preview = previewId ? index.byId.get(previewId) : undefined;
  const hovered = hover ? index.byId.get(hover.id) : undefined;
  const assets = [...index.byId.values()].filter(
    (entry) => filter === 'all' || entry.type === filter,
  );
  const remove = (assetId: string) => {
    if (disabled) return;
    const nodes: CanvasConnectionNode[] = [
      ...connectedImageNodes.map((asset) => ({ ...asset, type: asset.type || 'Image' })),
      node,
    ];
    const updated = disconnectCanvasNodes(nodes, { childId: node.id, parentId: assetId }).find(
      (candidate) => candidate.id === node.id,
    );
    if (!updated || updated === node) return;
    const patch: Partial<CanvasConnectionNode> = { parentIds: updated.parentIds };
    for (const key of ['sourcePortIndices', 'imageMode', 'midjourneyReferenceNodeIds'] as const) {
      if (updated[key] !== node[key]) Object.assign(patch, { [key]: updated[key] });
    }
    onUpdate(node.id, patch);
  };
  // 顺序本身就是引用顺序，所以拖动缩略图不需要额外的排序字段。
  const reorderable = !disabled && assets.length > 1 && !(node.parentIds ?? []).includes('');
  const placementAt = (event: ReactTypes.DragEvent, element: HTMLElement): 'before' | 'after' => {
    const rect = element.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
  };
  const reorder = (fromId: string, toId: string, placement: 'before' | 'after') => {
    const next = reorderParentIds(node, fromId, toId, placement);
    if (next) onUpdate(node.id, next);
  };
  return (
    <div
      data-fisherai-connected-asset-strip="true"
      className="mb-3 pb-3 border-b border-[var(--af-border)] relative group/assets"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div
        data-fisherai-reference-tabs
        role="group"
        aria-label="参考素材分类"
        className="flex items-center gap-4 mb-2"
      >
        {(['all', 'image', 'video', 'audio', 'text'] as const).map((kind) => (
          <button
            type="button"
            key={kind}
            aria-pressed={filter === kind}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              setFilter(kind);
            }}
            style={{
              color: filter === kind ? 'var(--af-text)' : 'var(--af-text-secondary)',
              borderBottom: filter === kind ? '2px solid var(--af-text)' : '2px solid transparent',
              padding: '6px 0',
              fontSize: 13,
            }}
          >
            {{ all: '全部', image: '图片', video: '视频', audio: '音频', text: '文本' }[kind]}{' '}
            {kind === 'all' ? index.byId.size : index.byType[kind].length}
          </button>
        ))}
      </div>
      <div className="flex items-center min-w-0">
        <div className="flex items-center gap-2 nodrag min-w-0 flex-1">
          <div className="min-w-0 flex-1 relative">
            <div
              className="flex items-center gap-2 overflow-x-auto py-1 pr-1"
              style={{ scrollbarWidth: 'none' }}
            >
              {assets.length ? (
                assets.map(({ asset, type: kind, number }) => {
                  const label = promptAssetLabel(kind, number);
                  const thumbnail =
                    kind === 'video'
                      ? asset.lastFrame
                      : kind === 'image' && asset.url && !asset.url.endsWith('-node-placeholder')
                        ? asset.url
                        : undefined;
                  const Placeholder =
                    kind === 'video' ? VideoIcon : kind === 'audio' ? AudioIcon : ImageIcon;
                  const hint = dropHint?.id === asset.id ? dropHint.placement : null;
                  return (
                    <div
                      key={asset.id}
                      className="relative group/frame shrink-0"
                      draggable={reorderable}
                      title={reorderable ? '拖动可调整参考图顺序' : undefined}
                      style={{ opacity: dragAssetId === asset.id ? 0.35 : 1 }}
                      onMouseEnter={(event) => showHover(asset.id, event.currentTarget)}
                      onMouseLeave={closeHover}
                      onFocus={(event) => showHover(asset.id, event.currentTarget)}
                      onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget as Node))
                          closeHover();
                      }}
                      onDragStart={(event) => {
                        if (!reorderable) {
                          event.preventDefault();
                          return;
                        }
                        event.stopPropagation();
                        setDragAssetId(asset.id);
                        setDropHint(null);
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', asset.id);
                      }}
                      onDragEnd={() => {
                        setDragAssetId(null);
                        setDropHint(null);
                      }}
                      onDragOver={(event) => {
                        if (!reorderable || !dragAssetId || dragAssetId === asset.id) return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = 'move';
                        const placement = placementAt(event, event.currentTarget);
                        setDropHint((current) =>
                          current?.id === asset.id && current.placement === placement
                            ? current
                            : { id: asset.id, placement },
                        );
                      }}
                      onDragLeave={(event) => {
                        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                        setDropHint((current) => (current?.id === asset.id ? null : current));
                      }}
                      onDrop={(event) => {
                        if (!reorderable || !dragAssetId || dragAssetId === asset.id) return;
                        event.preventDefault();
                        event.stopPropagation();
                        reorder(dragAssetId, asset.id, placementAt(event, event.currentTarget));
                        setDragAssetId(null);
                        setDropHint(null);
                      }}
                    >
                      {hint && (
                        <span
                          aria-hidden="true"
                          data-fisherai-asset-drop-hint="true"
                          className="absolute top-0 bottom-0 w-[2px] bg-[var(--af-primary)] rounded-full pointer-events-none z-20"
                          style={hint === 'before' ? { left: '-5px' } : { right: '-5px' }}
                        />
                      )}
                      <button
                        type="button"
                        aria-label={`插入引用${label}`}
                        disabled={disabled}
                        onMouseDown={(event) => {
                          // 阻止默认按下行为会连带阻止 HTML5 拖拽，所以只在不能排序时才拦。
                          if (!reorderable) event.preventDefault();
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          event.currentTarget
                            .closest('[data-fisherai-generation-composer]')
                            ?.dispatchEvent(
                              new CustomEvent('fisherai:insert-prompt-reference', {
                                detail: asset.id,
                              }),
                            );
                        }}
                      >
                        {thumbnail ? (
                          <div
                            className="rounded-[10px] border border-[var(--af-border)] overflow-hidden relative shadow-sm bg-[var(--af-surface)]"
                            style={{ width: '64px', height: '64px' }}
                          >
                            <img
                              src={String(thumbnail)}
                              alt={label}
                              className="w-full h-full object-cover"
                              draggable={false}
                            />
                            <span
                              data-af-media-chrome
                              data-fisherai-connected-asset-label="true"
                              className="absolute inset-x-0 bottom-0 px-1.5 py-0.5 bg-black/70 text-[10px] font-semibold text-[var(--af-media-text)] text-center truncate"
                            >
                              {label}
                            </span>
                          </div>
                        ) : (
                          <div data-asset-kind={kind} className="w-16 h-16 flex flex-col items-center justify-center rounded-[10px] border border-[var(--af-border)] bg-[var(--af-surface)] text-[var(--af-text-secondary)]"
                            style={kind === 'text' ? { background: '#17232f', borderColor: '#416280', color: '#b9dcff' } : undefined}>
                            {kind === 'text' ? <span aria-hidden="true" style={{ fontSize: 23, lineHeight: 1, fontWeight: 600 }}>T</span> : <Placeholder size={16} />}
                            <span className="text-[8px] font-bold leading-none mt-1">{label}</span>
                          </div>
                        )}
                      </button>
                      <button
                        type="button"
                        data-af-media-chrome
                        aria-label={`预览${label}`}
                        className="absolute top-1 left-1 w-5 h-5 rounded bg-black/70 text-[var(--af-media-text)] text-xs opacity-0 group-hover/frame:opacity-100 focus-visible:opacity-100"
                        onClick={(event) => {
                          event.stopPropagation();
                          setPreviewId(asset.id);
                        }}
                      >
                        ↗
                      </button>
                      <button
                        type="button"
                        data-af-media-chrome
                        aria-label={`移除引用${label}`}
                        disabled={disabled}
                        style={{ opacity: focused === asset.id ? 1 : undefined }}
                        onFocus={() => setFocused(asset.id)}
                        onBlur={() => setFocused(null)}
                        onClick={(event) => {
                          event.stopPropagation();
                          remove(asset.id);
                        }}
                        className="absolute -top-1 -right-1 w-4 h-4 bg-black rounded-full flex items-center justify-center opacity-0 group-hover/frame:opacity-100 focus-visible:opacity-100 transition-opacity z-10 border border-[var(--af-border)] hover:bg-red-600"
                      >
                        <RemoveIcon size={12} className="text-[var(--af-media-text)]" />
                      </button>
                    </div>
                  );
                })
              ) : (
                <div className="text-[10px] text-[var(--af-text-muted)] italic px-1 flex items-center gap-1.5 h-[42px]">
                  <div className="w-8 h-8 rounded-md border border-dashed border-[var(--af-border)] flex items-center justify-center text-[var(--af-text-muted)]">
                    <ImageIcon size={14} />
                  </div>
                  <span>无引用素材</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      {hover &&
        hovered &&
        !preview &&
        createPortal(
          <div
            role="region"
            aria-label="悬停素材预览"
            data-fisherai-asset-preview="hover"
            onWheel={(event) => event.stopPropagation()}
            onMouseEnter={keepHover}
            onMouseLeave={closeHover}
            onFocus={keepHover}
            onBlur={closeHover}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            style={{
              position: 'fixed',
              left: hover.left,
              top: hover.top,
              width: 'min(240px, calc(100vw - 24px))',
              height: 'min(300px, calc(100vh - 24px))',
              zIndex: 10000,
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--af-surface-raised)',
              border: '1px solid var(--af-border-control)',
              fontSize: 16, lineHeight: 1.65,
              borderRadius: 12,
              overflow: 'hidden',
              boxShadow: 'var(--af-shadow)',
            }}
          >
            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: hovered.type === 'text' ? 'block' : 'flex',
                overscrollBehavior: 'contain',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'auto',
              }}
            >
              {hovered.type === 'image' || (hovered.type === 'video' && hovered.asset.lastFrame) ? (
                <img
                  src={String(
                    hovered.type === 'image' ? hovered.asset.url : hovered.asset.lastFrame,
                  )}
                  alt={promptAssetLabel(hovered.type, hovered.number)}
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              ) : (
                <span style={{ display: 'block', color: 'var(--af-text-secondary)', padding: 16, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {hovered.type === 'text'
                    ? String(hovered.asset.textContent || hovered.asset.prompt || '')
                    : promptAssetLabel(hovered.type, hovered.number)}
                </span>
              )}
            </div>
            <button
              type="button"
              style={{ padding: 10, color: 'var(--af-text)', fontSize: 12 }}
              onClick={() => {
                setPreviewId(hover.id);
                setHover(null);
              }}
            >
              {hovered.type === 'image' ? '查看原图' : '查看素材'}
            </button>
          </div>,
          document.body,
        )}
      {preview &&
        createPortal(
          <div
            role="dialog"
            aria-label="素材预览"
            data-fisherai-asset-preview="expanded"
            onWheel={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            style={{
              position: 'fixed',
              top: '10vh',
              left: '15vw',
              right: '15vw',
              zIndex: 10001,
              background: 'var(--af-surface)',
              color: 'var(--af-text)',
              padding: 16,
              border: '1px solid var(--af-border)',
              borderRadius: 12,
            }}
          >
            <button type="button" onClick={() => setPreviewId(null)} style={{ float: 'right' }}>
              关闭预览
            </button>
            <div style={{ clear: 'both', maxHeight: '70vh', overflow: 'auto', overscrollBehavior: 'contain', fontSize: 16, lineHeight: 1.65 }}>
              {preview.type === 'image' ? (
                <img
                  src={preview.asset.url}
                  alt={promptAssetLabel(preview.type, preview.number)}
                  style={{ maxHeight: '65vh', maxWidth: '100%', margin: 'auto' }}
                />
              ) : preview.type === 'video' ? (
                <video
                  src={preview.asset.url}
                  controls
                  style={{ maxHeight: '65vh', maxWidth: '100%' }}
                />
              ) : preview.type === 'audio' ? (
                <audio src={preview.asset.url} controls />
              ) : (
                <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, padding: '12px 4px', color: '#ddd' }}>
                  {String(preview.asset.textContent || preview.asset.prompt || '')}
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
