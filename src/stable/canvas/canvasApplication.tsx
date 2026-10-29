import type { CanvasNode } from '../nodes/canvasNodeOperations';
import { alignCanvasDrag } from './canvasAlignment';
import type { CanvasGroup } from './canvasGroups';
import type { CanvasNodeFrame, SelectionResizeHandle } from './canvasEditing';
import type * as ReactTypes from 'react';
import type { Runtime, Dependencies } from './canvasApplicationDependencies';
import type { CanvasContextMenuState } from './canvasContextActions';
import { useCanvasAssetInsertion } from './canvasAssetInsertion';
import { useCanvasImageUpscale } from '../media/canvasImageUpscale';
import { createImageAngleDraft } from '../media/imageAngleDraft';
import type { ImageAngle } from '../prompt/imageAngle';
import { createCanvasSceneProjector, canvasVisibleScene } from './canvasSceneData';
import { disconnectCanvasNodes } from './canvasConnections';
import { screenToCanvas } from './canvasNavigation';
import { useCanvasCutMode } from './canvasCutMode';
import {
  connectJoinedGroupLinks,
  dropDepartedGroupLinks,
  syncCanvasGroupMembership,
  translateGroupFrames,
} from './canvasGroupMembership';
import { GROUP_FRAME_MIN_SIZE } from './canvasGroups';
import { reattachBundle } from './canvasBundleReattach';
import { applyCanvasPromptProposal } from '../agent/canvasPromptProposal';
import type { PromptProposal } from '../agent/codexClient';
import { flushSync } from 'react-dom';
import { createCanvasCreationControl } from '../agent/canvasCreationControl';
import { createCanvasProjectControl } from '../agent/canvasProjectControl';
import { createCanvasTaskControl } from '../agent/canvasTaskControl';
import { createCanvasMediaControl } from '../agent/canvasMediaControl';
import { createCanvasExternalClient } from '../agent/canvasExternalClient';
import { createCanvasWorkflowControl } from '../agent/canvasWorkflowControl';
import { createCanvasProductControl } from '../agent/canvasProductControl';
import { requestWorkflowNodeRun } from '../local/workflowNodeSession';
import { createGenerationPlanClient } from '../agent/generationPlanClient';
import { createCanvasBudgetControl } from '../agent/canvasBudgetControl';
import { createCanvasControlExecutor } from '../agent/canvasControlExecutor';
import { createCanvasAssetControl } from '../agent/canvasAssetControl';
import { projectArchiveRestoreRequest } from '../desktop/localFileUpload';
import {
  useCanvasPageEvents,
  useCanvasDeferredFrame,
  useCanvasSurfaceSize,
} from './canvasApplicationEvents';
export function CanvasApplication(React: Runtime, dependencies: Dependencies) {
  const {
    usePanels,
    useTitle,
    useViewport,
    useNodes,
    useConnections,
    useDrag,
    useResize,
    useMarquee,
    useGroups,
    useEdgePan,
    useHistory,
    useWorkflow,
    useLocalUser,
    userColorForId,
    NodeStatus,
    useGeneration,
    useSnapshots,
    useAudioTrim,
    NodeType,
    useTextActions,
    useLocalWorkflows,
    useAssets,
    usePresets,
    useCommands,
    useAutoSave,
    useVideoResults,
    useImageResults,
    useContextMenu,
    media,
    getNodeWidth,
    getNodeHeight,
    createId,
    textForNode,
    Projects,
    Settings,
    Header,
    Sidebar,
    Scene,
    Controls,
    SidePanels,
    Overlays,
    Annotation,
    Crop,
    Resize,
  } = dependencies;
  const session = window.__FISHERAI_CANVAS_SESSION__,
    navigationRef = React.useRef(0),
    mountedRef = React.useRef(true),
    [view, setView] = React.useState('dashboard'),
    [folderId, setFolderId] = React.useState<string | null>(null),
    [contextMenu, setContextMenu] = React.useState<CanvasContextMenuState>({
      isOpen: false,
      x: 0,
      y: 0,
      type: 'global',
    }),
    [showGridSlider, setShowGridSlider] = React.useState(false),
    [gridColumns, setGridColumns] = React.useState(3),
    [isCompact, setCompact] = React.useState(false),
    [isMinimapOpen, setMinimapOpen] = React.useState(true),
    [minimapWidth, setMinimapWidth] = React.useState(250),
    [chatPanelWidth, setChatPanelWidth] = React.useState(400),
    [settingsOpen, setSettingsOpen] = React.useState(false),
    [savedAt, setSavedAt] = React.useState<number | null | undefined>(void 0),
    [savedBy, setSavedBy] = React.useState('用户-'),
    [savedRevision, setSavedRevision] = React.useState<number | null>(null),
    zoomControlsRef = React.useRef<HTMLDivElement | null>(null),
    pointerRef = React.useRef<{
      x: number;
      y: number;
    } | null>(null),
    projectFileRef = React.useRef<HTMLInputElement | null>(null),
    mergeProjectFileRef = React.useRef<HTMLInputElement | null>(null);

  const {
      isHistoryPanelOpen,
      historyPanelY,
      handleHistoryClick,
      closeHistoryPanel,
      expandedImageUrl,
      expandedComparePayload,
      expandedCompositePayload,
      handleExpandImage,
      handleOpenCompare,
      handleOpenComposite,
      handleCloseExpand,
      handleCloseCompare,
      handleCloseComposite,
      isChatOpen,
      toggleChat,
      closeChat,
      isAssetLibraryOpen,
      assetLibraryY,
      assetLibraryVariant,
      handleAssetsClick,
      closeAssetLibrary,
      openAssetLibraryModal,
      isWorkflowPresetPanelOpen,
      workflowPresetPanelY,
      closeWorkflowPresetPanel,
      isDraggingNodeToChat,
      handleNodeDragStart,
      handleNodeDragEnd,
      annotatingNodeId,
      handleStartAnnotation,
      handleCloseAnnotation,
      cropNodeId,
      imageEditorMode,
      handleStartCrop,
      handleCloseCrop,
      resizeNodeId,
      handleStartResize,
      handleCloseResize,
    } = usePanels(),
    [batchConnecting, setBatchConnecting] = React.useState(false),
    // 组框缩放进行中：期间不写历史，避免每一帧都记一条。
    [groupFrameResizing, setGroupFrameResizing] = React.useState(false),
    // 从组框连接点发起批连线时，用它覆盖"按当前选中项批连"的默认来源。
    [groupBatchSourceIds, setGroupBatchSourceIds] = React.useState<string[] | null>(null),
    // Shift 改接期间要在画面上隐藏原线，所以必须是 state（ref 不会触发重渲染）。
    [rewiringEdge, setRewiringEdge] = React.useState<{
      parentId: string;
      childId: string;
      portIndex: number;
    } | null>(null),
    selectedCoverRef = React.useRef<string | null>(null),
    newProjectPendingRef = React.useRef(false);
  const {
      canvasTitle,
      setCanvasTitle,
      isEditingTitle,
      setIsEditingTitle,
      editingTitleValue,
      setEditingTitleValue,
      canvasTitleInputRef,
    } = useTitle(),
    { viewport, setViewport, canvasRef, handleWheel, handleSliderZoom, focusOnNodes } =
      useViewport(),
    onCanvasWheel = (ke: ReactTypes.WheelEvent<HTMLDivElement>) => {
      handleWheel(ke);
    },
    {
      nodes,
      setNodes,
      getNodes,
      createAgentNode,
      configureAgentNode,
      connectAgentNodes,
      selectedNodeIds,
      setSelectedNodeIds,
      updateNode,
      deleteNodes,
      clearSelection,
      handleSelectTypeFromMenu,
      autoAlignNodes,
      gridLayoutNodes,
    } = useNodes(),
    focusNodes = React.useCallback(
      (FisherIds: readonly string[]) => focusOnNodes(getNodes(), FisherIds),
      [focusOnNodes, getNodes],
    );

  const {
      isDraggingConnection,
      isPendingConnection,
      connectionStart,
      tempConnectionEnd,
      hoveredNodeId: connectionHoveredNodeId,
      hoveredSide,
      hoveredPortIndex,
      isInvalidHover,
      selectedConnection,
      setSelectedConnection,
      pendingBatchSourceNodeIds,
      handleConnectorPointerDown,
      updateConnectionDrag,
      completeConnectionDrag,
      cancelConnectionDrag,
      handleEdgeClick,
      deleteSelectedConnection,
    } = useConnections(),
    {
      handleNodePointerDown,
      updateNodeDrag,
      endNodeDrag,
      startPanning,
      updatePanning,
      endPanning,
      isDragging,
      isPanning,
      releasePointerCapture,
    } = useDrag(),
    [spaceHeld, setSpaceHeld] = React.useState(false),
    spaceHeldRef = React.useRef(false),
    endPanningRef = React.useRef(endPanning),
    {
      isResizing,
      handleResizeStart,
      handleSelectionResizeStart: startSelectionResize,
      updateNodeResize,
      endNodeResize,
    } = useResize(),
    {
      selectionBox,
      isSelecting,
      startSelection,
      updateSelection,
      endSelection,
      clearSelectionBox,
    } = useMarquee(),
    {
      groups,
      setGroups,
      getGroups,
      groupNodes,
      ungroupNodes,
      cleanupInvalidGroups,
      getCommonGroup,
      renameGroup,
    } = useGroups(),
    { updatePointerPos } = useEdgePan({
      canvasRef,
      isDragging,
      isDraggingConnection,
      isSelecting,
      viewport,
      setViewport,
      setNodes,
      selectedNodeIds,
    }),
    {
      undo: undoHistory,
      redo: redoHistory,
      pushHistory,
      reset,
      canUndo,
      canRedo,
    } = useHistory({ nodes, groups }, 50);

  const {
      workflowId,
      isWorkflowPanelOpen,
      workflowPanelY,
      handleSaveWorkflow,
      handleLoadWorkflow,
      closeWorkflowPanel,
      resetWorkflowId,
      getWorkflowEpoch,
      importDocument,
      useProjectFiles,
      useSaveFeedback,
    } = useWorkflow({
      nodes,
      groups,
      viewport,
      canvasTitle,
      isMinimapOpen,
      setNodes,
      setGroups,
      setSelectedNodeIds,
      setCanvasTitle,
      setEditingTitleValue,
      setViewport,
      setIsMinimapOpen: setMinimapOpen,
      onPanelOpen: () => {
        closeHistoryPanel();
        closeAssetLibrary();
        closeWorkflowPresetPanel();
      },
    }),
    activeProjectId = view === 'canvas' ? workflowId : null;

  // The source-owned canvas remains the only node store and save/history owner.
  const dramaBridge = window.__FISHERAI_DRAMA_BRIDGE__;
  const dramaDocumentEpoch = getWorkflowEpoch();
  React.useLayoutEffect(() => {
    dramaBridge?.setProject(activeProjectId);
    return () => dramaBridge?.clearProject(activeProjectId);
  }, [dramaBridge, activeProjectId, dramaDocumentEpoch]);
  React.useLayoutEffect(
    () =>
      dramaBridge?.bind(
        nodes,
        (transform) => {
          setNodes((current) => {
            const next = transform(current);
            if (!next.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)))
              throw new Error('文戏节点坐标无效，未写入画布。');
            return next as CanvasNode[];
          });
        },
        setSelectedNodeIds,
      ),
    [dramaBridge, nodes, setNodes, setSelectedNodeIds, dramaDocumentEpoch],
  );

  // Hold Space to pan the canvas (Figma-style): pointerdown on the background
  // routes into startPanning, text editors keep their normal space behaviour.
  React.useEffect(() => {
    const isTextEditable = (target: EventTarget | null) =>
      target instanceof Element &&
      Boolean(target.closest('input, textarea, select, [contenteditable]'));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.isComposing || isTextEditable(event.target)) return;
      event.preventDefault();
      spaceHeldRef.current = true;
      setSpaceHeld(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      spaceHeldRef.current = false;
      setSpaceHeld(false);
      endPanningRef.current();
    };
    const onBlur = () => {
      spaceHeldRef.current = false;
      setSpaceHeld(false);
      endPanningRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const deferFrame = useCanvasDeferredFrame(React, view === 'canvas', getWorkflowEpoch);
  const windowSize = useCanvasSurfaceSize(React, canvasRef, view, getWorkflowEpoch());

  // 按住 C 划一道线，划过的连线松手后一起断开。
  useCanvasCutMode(React, {
    containerRef: canvasRef,
    enabled: view === 'canvas',
    onCut: (cuts) => {
      setNodes((current) =>
        cuts.reduce((result, cut) => disconnectCanvasNodes(result, cut), current),
      );
    },
  });

  // Shift 抓住连线的一端改接：拖到别的节点就换掉原来那一端。
  const rewireRef = React.useRef<{
    parentId: string;
    childId: string;
    portIndex: number;
    end: 'parent' | 'child';
    /** 断开前的子节点快照：取消/失败时整条连线原样放回去（连槽位顺序都不变）。 */
    childSnapshot: CanvasNode;
  } | null>(null);
  const completedConnectionsRef = React.useRef<string[][]>([]);
  const startEdgeRewire = React.useCallback(
    (
      event: ReactTypes.PointerEvent,
      parentId: string,
      childId: string,
      portIndex: number,
      forcedEnd?: 'parent' | 'child',
    ) => {
      const parent = nodes.find((node) => node.id === parentId),
        child = nodes.find((node) => node.id === childId);
      if (!parent || !child) return;
      const point = screenToCanvas({ x: event.clientX, y: event.clientY }, viewport),
        parentCenter = parent.x + getNodeWidth(parent) / 2,
        childCenter = child.x + getNodeWidth(child) / 2,
        // 离哪一端近就抓哪一端：抓下游端改"接到谁"，抓上游端改"从哪来"。
        // 从节点圆点起手时由调用方直接指定，不靠距离猜。
        end: 'parent' | 'child' =
          forcedEnd ??
          (Math.abs(point.x - childCenter) <= Math.abs(point.x - parentCenter)
            ? 'child'
            : 'parent');
      rewireRef.current = { parentId, childId, portIndex, end, childSnapshot: child };
      setRewiringEdge({ parentId, childId, portIndex });
      // 立刻断开：原线从画面上消失，只剩跟着鼠标的那条；失败/取消时用快照还原。
      setNodes((latest) => disconnectCanvasNodes(latest, { parentId, childId, portIndex }));
      setBatchConnecting(false);
      setGroupBatchSourceIds(null);
      if (end === 'child') handleConnectorPointerDown(event, parentId, 'right', portIndex);
      else handleConnectorPointerDown(event, childId, 'left', portIndex);
    },
    [nodes, viewport, getNodeWidth, handleConnectorPointerDown],
  );

  // 拖动组框期间：组框位置用"锚点节点的位移"实时推导，拖动过程中框跟着走，
  // 松手时再由 translateGroupFrames 落到 frame 数据里（两者结果一致，不会跳）。
  const groupDragRef = React.useRef<{
    groupId: string;
    anchorId: string;
    anchorX: number;
    anchorY: number;
  } | null>(null);

  // 拖动开始时的节点位置快照：用来判断"整组平移"（所有成员位移一致才平移组框）。
  const dragOriginRef = React.useRef<Map<string, { x: number; y: number }> | null>(null);
  const rememberDragOrigin = React.useCallback(() => {
    dragOriginRef.current = new Map(nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
  }, [nodes]);

  // 组框缩放：只改 frame，成员尺寸完全不动。
  const groupResizeRef = React.useRef<{
    groupId: string;
    box: { left: number; top: number; width: number; height: number };
    startX: number;
    startY: number;
    zoom: number;
  } | null>(null);

  // Shift 抓住端口 = 把整个端口上的连线当成一束一起搬（ComfyUI 的换线手感）。
  const bundleRef = React.useRef<{
    nodeId: string;
    side: 'left' | 'right';
    items: { parentId: string; childId: string; portIndex: number; sourcePortIndex: number }[];
    snapshots: Map<string, CanvasNode>;
  } | null>(null);
  const [bundlePreview, setBundlePreview] = React.useState<{
    side: 'left' | 'right';
    edges: { nodeId: string; portIndex: number }[];
    /** 鼠标位置（画布坐标），预览线从这里发散。 */
    point: { x: number; y: number };
    /** 当前悬停的落点节点，给蓝框高亮用。 */
    targetId: string | null;
  } | null>(null);
  const bundleViewportRef = React.useRef(viewport);
  bundleViewportRef.current = viewport;
  const bundleNodesRef = React.useRef(nodes);
  bundleNodesRef.current = nodes;

  const startBundleDrag = React.useCallback(
    (event: ReactTypes.PointerEvent, nodeId: string, side: 'left' | 'right') => {
      const items: { parentId: string; childId: string; portIndex: number; sourcePortIndex: number }[] =
        [];
      if (side === 'right') {
        // 输出口：所有把这个节点当上游的连接一起拎起来。
        for (const child of nodes) {
          (child.parentIds || []).forEach((parentId, portIndex) => {
            if (parentId !== nodeId) return;
            items.push({
              parentId: nodeId,
              childId: child.id,
              portIndex,
              sourcePortIndex: child.sourcePortIndices?.[portIndex] ?? 0,
            });
          });
        }
      } else {
        // 输入口：这个节点身上的全部输入一起拎起来。
        const self = nodes.find((node) => node.id === nodeId);
        (self?.parentIds || []).forEach((parentId, portIndex) => {
          if (!parentId) return;
          items.push({
            parentId,
            childId: nodeId,
            portIndex,
            sourcePortIndex: self?.sourcePortIndices?.[portIndex] ?? 0,
          });
        });
      }
      if (!items.length) return false;
      const snapshots = new Map<string, CanvasNode>();
      for (const item of items) {
        const child = nodes.find((node) => node.id === item.childId);
        if (child && !snapshots.has(child.id)) snapshots.set(child.id, child);
      }
      bundleRef.current = { nodeId, side, items, snapshots };
      // 立刻全部断开：画面上这束线会收成一个点跟着鼠标，和 ComfyUI 一样。
      setNodes((current) =>
        items.reduce((result, item) => disconnectCanvasNodes(result, item), current),
      );
      setBundlePreview({
        side,
        edges: items.map((item) => ({
          nodeId: side === 'right' ? item.childId : item.parentId,
          portIndex: item.portIndex,
        })),
        point: screenToCanvas({ x: event.clientX, y: event.clientY }, viewport),
        targetId: null,
      });
      setRewiringEdge(null);
      setBatchConnecting(false);
      setGroupBatchSourceIds(null);
      return true;
    },
    [nodes, viewport, setNodes],
  );

  const finishBundleDrag = React.useCallback(
    (targetId: string | null) => {
      const bundle = bundleRef.current;
      bundleRef.current = null;
      setBundlePreview(null);
      if (!bundle) return;
      if (!targetId || targetId === bundle.nodeId) {
        // 松在空白或原节点上：整束原样还原（快照保住 parentIds 顺序与端口槽位）。
        setNodes((current) => {
          let next = current;
          for (const snapshot of bundle.snapshots.values())
            next = next.map((node) => (node.id === snapshot.id ? snapshot : node));
          return next;
        });
        return;
      }
      setNodes((current) =>
        reattachBundle(current, bundle.items, bundle.snapshots, targetId, bundle.side),
      );
    },
    [setNodes],
  );

  /**
   * 整束搬移自己管指针事件：不依赖连接拖拽那套状态机（它只识别"从端口拉一条新线"），
   * pointermove 直接算悬停节点 → 预览收口 + 高亮，pointerup 直接算落点。
   */
  const locateBundleAt = React.useCallback(
    (clientX: number, clientY: number) => {
      const bundle = bundleRef.current;
      if (!bundle) return null;
      const point = screenToCanvas({ x: clientX, y: clientY }, bundleViewportRef.current);
      const margin = 24;
      const hit = bundleNodesRef.current.find((node) => {
        if (node.id === bundle.nodeId) return false;
        return (
          point.x >= node.x - margin &&
          point.x <= node.x + getNodeWidth(node) + margin &&
          point.y >= node.y - margin &&
          point.y <= node.y + getNodeHeight(node) + margin
        );
      });
      return { point, targetId: hit?.id ?? null };
    },
    [getNodeWidth, getNodeHeight],
  );

  const bundleDragging = bundlePreview !== null;
  React.useEffect(() => {
    if (!bundleDragging) return;
    const move = (event: PointerEvent) => {
      const next = locateBundleAt(event.clientX, event.clientY);
      if (!next) return;
      setBundlePreview((current) =>
        current ? { ...current, point: next.point, targetId: next.targetId } : current,
      );
    };
    const finish = (event: PointerEvent) => {
      if (!bundleRef.current) return;
      finishBundleDrag(locateBundleAt(event.clientX, event.clientY)?.targetId ?? null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
  }, [bundleDragging, finishBundleDrag, locateBundleAt]);

  // 改接失败或取消：把子节点整条还原（保留 parentIds 原顺序，避免参考图编号错位）。
  const restoreRewiredNode = React.useCallback(() => {
    const pending = rewireRef.current;
    rewireRef.current = null;
    setRewiringEdge(null);
    if (!pending) return;
    setNodes((current) =>
      current.map((node) => (node.id === pending.childId ? pending.childSnapshot : node)),
    );
  }, [setNodes, setRewiringEdge]);

  // 组框上的连接点：把整组成员当成一个来源，一次连到下游。
  const startGroupConnection = React.useCallback(
    (
      event: ReactTypes.PointerEvent,
      side: 'left' | 'right',
      _groupId: string,
      nodeIds: string[],
    ) => {
      if (!nodeIds.length) return;
      setGroupBatchSourceIds(nodeIds);
      setBatchConnecting(true);
      handleConnectorPointerDown(event, nodeIds[0], side);
    },
    [handleConnectorPointerDown],
  );

  // 拖动结束后结算组成员：拖进组框即加入，拖出去即离开。
  const syncGroupsAfterDrag = React.useCallback(() => {
    const origins = dragOriginRef.current,
      drag = groupDragRef.current;
    dragOriginRef.current = null;
    groupDragRef.current = null;
    // 顺序很重要：先把组框搬到新位置，再拿它判断成员去留。反过来的话，拖整组时
    // 框还在原地，所有成员都会被判成"出框" → 组被解散。
    // 拖组框时用拖动期间那份同一个位移落账，保证松手瞬间框不会跳回去。
    let framedGroups = groups;
    const anchor = drag ? nodes.find((node) => node.id === drag.anchorId) : undefined;
    if (drag && anchor) {
      const dx = anchor.x - drag.anchorX,
        dy = anchor.y - drag.anchorY;
      framedGroups = groups.map((group) =>
        group.id === drag.groupId && group.frame
          ? { ...group, frame: { ...group.frame, x: group.frame.x + dx, y: group.frame.y + dy } }
          : group,
      );
    } else if (origins) {
      framedGroups = translateGroupFrames(groups, nodes, origins);
    }
    const next = syncCanvasGroupMembership(nodes, framedGroups, {
      width: getNodeWidth,
      height: getNodeHeight,
    });
    if (!next) {
      if (framedGroups !== groups) setGroups(framedGroups);
      return;
    }

    // 出组的节点要跟"这一组的连线"一起断开，否则看起来它还挂在组上。
    const previousGroupIds = new Map<string, string | undefined>(
      nodes.map((node) => [node.id, typeof node.groupId === 'string' ? node.groupId : undefined]),
    );
    // 出组：断开组内共有的那条线；入组：接到组已连着的下游上（两个方向对称）。
    const updated = connectJoinedGroupLinks(
      dropDepartedGroupLinks(next.nodes, previousGroupIds),
      previousGroupIds,
    );

    setNodes(updated);
    setGroups(next.groups);
  }, [nodes, groups, getNodeWidth, getNodeHeight, setNodes, setGroups]);


  // 每次渲染现算（不用 useMemo）：拖动结束清空 ref 的那一次渲染必须立刻拿到 null，
  // 否则缓存下来的旧偏移会让框在松手瞬间被多推一次。
  const groupDrag = groupDragRef.current;
  const groupDragAnchor = groupDrag
    ? nodes.find((node) => node.id === groupDrag.anchorId)
    : undefined;
  const groupFrameOffset =
    groupDrag && groupDragAnchor
      ? {
          groupId: groupDrag.groupId,
          dx: groupDragAnchor.x - groupDrag.anchorX,
          dy: groupDragAnchor.y - groupDrag.anchorY,
        }
      : null;

  // 缩放结束后要立刻结算成员（框外的出组），这里用 ref 拿到最新的回调。
  const syncGroupsRef = React.useRef(syncGroupsAfterDrag);
  syncGroupsRef.current = syncGroupsAfterDrag;

  // 组框缩放：拖动右下角只改 frame，成员尺寸完全不动。
  const handleGroupFrameResize = React.useCallback(
    (
      event: ReactTypes.PointerEvent,
      groupId: string,
      box: { left: number; top: number; width: number; height: number },
    ) => {
      event.stopPropagation();
      event.preventDefault();
      groupResizeRef.current = {
        groupId,
        box,
        startX: event.clientX,
        startY: event.clientY,
        zoom: viewport.zoom > 0 ? viewport.zoom : 1,
      };
      setGroupFrameResizing(true);
    },
    [viewport.zoom],
  );

  React.useEffect(() => {
    if (!groupFrameResizing) return;
    const move = (event: PointerEvent) => {
      const current = groupResizeRef.current;
      if (!current) return;
      const width = Math.max(
          GROUP_FRAME_MIN_SIZE.width,
          current.box.width + (event.clientX - current.startX) / current.zoom,
        ),
        height = Math.max(
          GROUP_FRAME_MIN_SIZE.height,
          current.box.height + (event.clientY - current.startY) / current.zoom,
        );
      setGroups((list) =>
        list.map((group) =>
          group.id === current.groupId
            ? { ...group, frame: { x: current.box.left, y: current.box.top, width, height } }
            : group,
        ),
      );
    };
    const finish = () => {
      if (!groupResizeRef.current) return;
      groupResizeRef.current = null;
      setGroupFrameResizing(false);
      // 缩框之后落在框外的成员要立刻出组（连带断开组下游的那条线）。
      syncGroupsRef.current?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
  }, [groupFrameResizing, setGroups]);

  const {
      id: localUserId,
      no: localUserNo,
      name: localUserName,
      setName: setLocalUserName,
    } = useLocalUser(),
    userColor = React.useMemo(
      () => userColorForId(localUserId || localUserNo),
      [localUserId, localUserNo, userColorForId],
    ),
    [dirty, setDirty] = React.useState(false),
    hasUnsavedChanges = dirty,
    firstEditRef = React.useRef(true),
    observedContentRef = React.useRef({ nodes, groups, title: canvasTitle }),
    loadingCountRef = React.useRef(0),
    resultCountRef = React.useRef(0),
    applyingDocumentRef = React.useRef(false);

  // History commits record edits; only explicit navigation restores a snapshot.
  const restoreHistory = (snapshot: { nodes: CanvasNode[]; groups: CanvasGroup[] } | null) => {
    if (!snapshot) return;
    applyingDocumentRef.current = true;
    setNodes(snapshot.nodes);
    setGroups(snapshot.groups);
    setDirty(true);
  };
  const undo = () => restoreHistory(undoHistory());
  const redo = () => restoreHistory(redoHistory());
  const controlRuntime = React.useRef<Parameters<typeof createCanvasControlExecutor>[0]>(
    () => null,
  );
  const documentEpoch = getWorkflowEpoch();
  controlRuntime.current = () =>
    view === 'canvas' &&
    workflowId &&
    mountedRef.current &&
    !isDragging &&
    !isResizing &&
    !isDraggingConnection &&
    !isSelecting
      ? {
          projectId: workflowId,
          snapshot: () => ({ nodes: getNodes(), groups: getGroups() }),
          create: createAgentNode,
          configure: configureAgentNode,
          connect: connectAgentNodes,
          measure: (node) => ({ width: getNodeWidth(node), height: getNodeHeight(node) }),
          selection: () => selectedNodeIds,
          focus: (ids) => {
            setSelectedNodeIds(ids);
            focusOnNodes(getNodes(), ids);
          },
          commit: (before, after) => {
            flushSync(() => {
              pushHistory(before);
              applyingDocumentRef.current = true;
              setNodes(after.nodes);
              setGroups(after.groups);
              pushHistory(after);
              setDirty(true);
            });
          },
        }
      : null;
  const creationRuntime = React.useRef<Parameters<typeof createCanvasCreationControl>[1]>(
    () => null,
  );
  creationRuntime.current = () =>
    view === 'canvas' && workflowId && mountedRef.current
      ? {
          projectId: workflowId,
          nodes: getNodes,
          generate: (id, authorization) => handleGenerate(id, authorization),
        }
      : null;
  const canvasExecutor = React.useMemo(
    () =>
      createCanvasControlExecutor(() =>
        getWorkflowEpoch() === documentEpoch ? controlRuntime.current() : null,
      ),
    [documentEpoch, getWorkflowEpoch],
  );
  const canvasCreation = React.useMemo(
    () =>
      createCanvasCreationControl(
        createCanvasWorkflowControl(
          createCanvasMediaControl(createCanvasAssetControl(canvasExecutor), canvasExecutor, () =>
            getWorkflowEpoch() === documentEpoch ? creationRuntime.current() : null,
          ),
          canvasExecutor,
          () => (getWorkflowEpoch() === documentEpoch ? creationRuntime.current() : null),
        ),
        () => (getWorkflowEpoch() === documentEpoch ? creationRuntime.current() : null),
        globalThis.fetch,
        createGenerationPlanClient(),
      ),
    [canvasExecutor, documentEpoch, getWorkflowEpoch],
  );
  React.useEffect(() => {
    if (activeProjectId) void canvasCreation.restore(activeProjectId).catch(() => {});
  }, [activeProjectId, canvasCreation]);
  const projectRuntime = React.useRef<Parameters<typeof createCanvasProjectControl>[1]>(() => null);
  const canvasProjects = React.useMemo(
    () =>
      createCanvasProjectControl(canvasCreation.control, () =>
        getWorkflowEpoch() === documentEpoch ? projectRuntime.current() : null,
      ),
    [canvasCreation, documentEpoch, getWorkflowEpoch],
  );
  const taskControl = React.useMemo(
    () =>
      createCanvasTaskControl(canvasProjects.control, () =>
        getWorkflowEpoch() === documentEpoch ? creationRuntime.current() : null,
      ),
    [canvasProjects, documentEpoch, getWorkflowEpoch],
  );
  const canvasBudgets = React.useMemo(
    () =>
      createCanvasBudgetControl(taskControl, canvasCreation, () =>
        getWorkflowEpoch() === documentEpoch ? creationRuntime.current() : null,
      ),
    [taskControl, canvasCreation, documentEpoch, getWorkflowEpoch],
  );
  React.useEffect(() => {
    if (activeProjectId) void canvasBudgets.refresh(activeProjectId);
  }, [activeProjectId, canvasBudgets]);
  const productRuntime = React.useRef<Parameters<typeof createCanvasProductControl>[1]>(() => null);
  const canvasProducts = React.useMemo(
    () =>
      createCanvasProductControl(canvasBudgets.control, () =>
        getWorkflowEpoch() === documentEpoch ? productRuntime.current() : null,
      ),
    [canvasBudgets, documentEpoch, getWorkflowEpoch],
  );
  const canvasExternal = React.useMemo(
    () =>
      activeProjectId
        ? createCanvasExternalClient(
            activeProjectId,
            canvasProducts.control,
            globalThis.fetch,
            (sessionId) => {
              canvasCreation.cancelSession(sessionId);
              canvasProjects.cancelSession(sessionId);
              canvasProducts.cancelSession(sessionId);
              void canvasBudgets.refresh(activeProjectId);
            },
          )
        : undefined,
    [activeProjectId, canvasProducts, canvasCreation, canvasProjects, canvasBudgets],
  );
  const canvasControl = canvasExternal?.control || canvasProducts.control;
  React.useEffect(() => {
    if (canvasExternal) void canvasExternal.start();
    return () => canvasExternal?.stop();
  }, [canvasExternal]);
  const save = useSaveFeedback({
      enabled: view === 'canvas',
      getWorkflowEpoch,
      getNodes,
      getSelectedCoverId: () => selectedCoverRef.current,
      folderId,
      userNo: localUserNo,
      saveWorkflow: handleSaveWorkflow,
      setDirty,
      setSavedAt,
      setSavedBy,
      setSavedRevision,
    }),
    saveManually = React.useCallback(async () => {
      await save({ manual: true });
    }, [save]),
    loadProject = React.useCallback(
      async (ke: string) => {
        const intent = ++navigationRef.current;
        applyingDocumentRef.current = true;
        const st = await handleLoadWorkflow(ke);
        if (!mountedRef.current || intent !== navigationRef.current) return null;
        if (st) {
          const ot = st.nodes || [];
          reset({ nodes: ot, groups: st.groups || [] });
          loadingCountRef.current = ot.filter((Ge) => Ge.status === NodeStatus.LOADING).length;
          resultCountRef.current = ot.filter(
            (Ge) => Ge.status === NodeStatus.SUCCESS && Ge.resultUrl,
          ).length;
          setSavedAt(st.lastSavedAt);
          setSavedBy(st.lastSavedBy || '用户-');
          setSavedRevision(typeof st.revision == 'number' ? st.revision : null);
        }
        return (st && setDirty(false), st);
      },
      [handleLoadWorkflow, reset, NodeStatus],
    ),
    { handleGenerate } = useGeneration({
      nodes,
      getNodes,
      projectId: workflowId || undefined,
      enabled: view === 'canvas',
      updateNode,
    }),
    { handleVideoSnapshot, handleVideoFirstLastSnapshot } = useSnapshots({
      nodes,
      getNodes,
      enabled: view === 'canvas',
      projectId: workflowId || undefined,
      setNodes,
      setSelectedNodeIds,
    }),
    { handleAudioTrim } = useAudioTrim({
      nodes,
      getNodes,
      enabled: view === 'canvas',
      projectId: workflowId || undefined,
      setNodes,
      setSelectedNodeIds,
    });

  const handleUpscaleImage = useCanvasImageUpscale(React, {
    projectId: workflowId || undefined,
    enabled: view === 'canvas',
    getNodes,
    setNodes,
    select: setSelectedNodeIds,
  });
  const agentReferences = React.useMemo(
      () =>
        isChatOpen
          ? nodes
              .filter(
                (ke) =>
                  selectedNodeIds.includes(ke.id) &&
                  [
                    'image',
                    'upload image',
                    'video',
                    'upload video',
                    'audio',
                    'upload audio',
                  ].includes(String(ke.type).toLowerCase()) &&
                  typeof ke.resultUrl == 'string' &&
                  ke.resultUrl.length > 0,
              )
              .map((ke) => ({
                nodeId: ke.id,
                url: ke.resultUrl,
                type: String(ke.type).toLowerCase().includes('video')
                  ? 'video'
                  : String(ke.type).toLowerCase().includes('audio')
                    ? 'audio'
                    : 'image',
              }))
          : [],
      [isChatOpen, nodes, selectedNodeIds],
    ),
    clearCanvas = () => {
      applyingDocumentRef.current = true;
      setNodes([]);
      setGroups([]);
      setSelectedNodeIds([]);
      setCanvasTitle('Untitled');
      setEditingTitleValue('Untitled');
      resetWorkflowId();
      selectedCoverRef.current = null;
      setSavedAt(undefined);
      setSavedRevision(null);
      setSavedBy('用户-');
      reset({ nodes: [], groups: [] });
      setDirty(false);
    },
    { handleWriteContent, handleTextToVideo, handleTextToImage } = useTextActions({
      nodes,
      getNodes,
      enabled: view === 'canvas',
      projectId: workflowId || undefined,
      updateNode,
      setNodes,
      setSelectedNodeIds,
    }),
    { handleMiniMaxH3T2VAGenerate } = useLocalWorkflows({
      nodes,
      getNodes,
      enabled: view === 'canvas',
      projectId: workflowId || undefined,
      setNodes,
      setSelectedNodeIds,
    });
  const {
      isCreateAssetModalOpen,
      setIsCreateAssetModalOpen,
      nodeToSnapshot,
      assetCategories,
      handleOpenCreateAsset,
      handleSaveAssetToLibrary,
      handleContextUpload,
      handleClipboardImagePaste,
      handleReplaceMedia,
    } = useAssets({
      nodes,
      getNodes,
      enabled: view === 'canvas',
      viewport,
      contextMenu,
      projectId: workflowId || undefined,
      setNodes,
      setSelectedNodeIds,
    }),
    {
      isCreateWorkflowPresetModalOpen,
      setIsCreateWorkflowPresetModalOpen,
      workflowPresetCoverUrl,
      workflowPresetCategories,
      workflowPresetDefaultName,
      canCreateWorkflowPreset,
      handleOpenCreateWorkflowPreset,
      handleSaveWorkflowPreset,
      handleImportWorkflowPreset,
    } = usePresets({
      nodes,
      getNodes,
      enabled: view === 'canvas',
      selectedNodeIds,
      viewport,
      projectId: workflowId || undefined,
      setNodes,
      setSelectedNodeIds,
      closeWorkflowPresetPanel,
    }),
    { handleCopy, handlePaste, hasCopiedNodes } = useCommands({
      nodes,
      viewport,
      selectedNodeIds,
      selectedConnection,
      setNodes,
      setSelectedNodeIds,
      setContextMenu,
      deleteNodes,
      deleteSelectedConnection,
      clearSelection,
      clearSelectionBox,
      undo,
      redo,
      autoAlignNodes,
      handleSaveWorkflow: saveManually,
      focusOnNodes,
      groupSelectedNodes: (ke: string[]) => {
        if (ke.length > 1) {
          groupNodes(ke, nodes, setNodes);
        }
      },
    });
  useAutoSave({
    isDirty: dirty,
    nodes,
    groups,
    title: canvasTitle,
    documentId: workflowId,
    enabled: view === 'canvas',
    onSave: () => save({ reportFailure: true }),
    hasActiveOperations: nodes.some((node) => node.status === NodeStatus.LOADING),
    interval: 5e3,
  });
  useVideoResults({ nodes, updateNode });

  useImageResults({ nodes, updateNode });
  useCanvasPageEvents(React, {
    enabled: view === 'canvas',
    canvasRef,
    pointer: pointerRef,
    hasCopiedNodes,
    paste: handlePaste,
    upload: handleClipboardImagePaste,
  });
  const {
      handleDoubleClick,
      handleGlobalContextMenu,
      handleAddNext,
      handleNodeContextMenu,
      handleContextMenuCreateAsset,
      handleContextMenuCreateWorkflowPreset,
      handleContextMenuSelect,
      handleToolbarAdd,
    } = useContextMenu({
      nodes,
      selectedNodeIds,
      viewport,
      projectId: workflowId || undefined,
      contextMenu,
      setContextMenu,
      handleOpenCreateAsset,
      handleOpenCreateWorkflowPreset,
      handleSelectTypeFromMenu,
      onCancelConnection: cancelConnectionDrag,
    }),
    openHistory = React.useCallback(
      (ke: ReactTypes.MouseEvent<HTMLButtonElement>) => {
        handleHistoryClick(ke, closeWorkflowPanel);
      },
      [handleHistoryClick, closeWorkflowPanel],
    ),
    openAssets = React.useCallback(
      (ke: ReactTypes.MouseEvent<HTMLButtonElement>) => {
        handleAssetsClick(ke, closeWorkflowPanel);
      },
      [handleAssetsClick, closeWorkflowPanel],
    ),
    openAssetsModal = React.useCallback(() => {
      openAssetLibraryModal(contextMenu.y, closeWorkflowPanel);
    }, [openAssetLibraryModal, contextMenu.y, closeWorkflowPanel]),
    replaceMedia = handleReplaceMedia,
    createCollage = media.useCanvasCollage(React, {
      nodes,
      getNodes,
      enabled: view === 'canvas',
      projectId: workflowId || undefined,
      setNodes,
      setSelectedNodeIds,
      selectedNodeIds,
      getNodeWidth,
      getNodeHeight,
    }),
    { selectHistoryAsset, importLibraryAsset } = useCanvasAssetInsertion(React, {
      enabled: view === 'canvas',
      getWorkflowEpoch,
      projectId: workflowId || undefined,
      viewport,
      canvasRef,
      setNodes,
      closeHistory: closeHistoryPanel,
      closeLibrary: closeAssetLibrary,
    });

  projectRuntime.current = () =>
    view === 'canvas' && workflowId && mountedRef.current
      ? {
          projectId: workflowId,
          folderId,
          save: async () => {
            const receipt = await save({ manual: true, reportFailure: true });
            return !!receipt && receipt.unchanged !== false;
          },
          rename: async (title) => {
            flushSync(() => {
              setCanvasTitle(title);
              setEditingTitleValue(title);
              setDirty(true);
            });
            const receipt = await save({ manual: true, reportFailure: true });
            return !!receipt && receipt.unchanged !== false;
          },
          move: (id) => flushSync(() => setFolderId(id)),
          open: (id) => openProject(id),
          exit: () => backToProjects(),
          importFile: () => chooseProjectFile(),
          download: (id) => {
            const link = document.createElement('a');
            link.href = `/api/workflows/${encodeURIComponent(id)}/backup`;
            link.download = '';
            link.click();
          },
        }
      : null;
  productRuntime.current = () =>
    view === 'canvas' && workflowId && mountedRef.current
      ? {
          projectId: workflowId,
          async invoke(operation, nodeId) {
            const node = nodeId ? getNodes().find((item) => item.id === nodeId) : undefined;
            if (nodeId && (!node || node.status === 'loading')) throw Error('节点不可用');
            if (operation === 'workflowManager') {
              window.dispatchEvent(new CustomEvent('fisherai:open-workflow-library'));
              return;
            }
            if (operation === 'upload' || operation === 'replace') {
              const input = document.createElement('input'),
                epoch = getWorkflowEpoch();
              input.type = 'file';
              input.accept = 'image/*,video/*,audio/*';
              input.multiple = operation === 'upload';
              input.onchange = () => {
                const files = input.files;
                input.remove();
                if (getWorkflowEpoch() !== epoch || !files?.length) return;
                if (nodeId) void handleReplaceMedia(nodeId, files[0]);
                else void handleContextUpload(files);
              };
              input.oncancel = () => input.remove();
              input.hidden = true;
              document.body.append(input);
              input.click();
              return;
            }
            if (!node) throw Error('节点不存在');
            if (operation === 'saveAsset') {
              handleOpenCreateAsset(node.id);
              return;
            }
            if (operation === 'resize') {
              handleStartResize(node.id);
              return;
            }
            if (operation === 'download') {
              if (typeof node.resultUrl !== 'string' || !window.__FISHERAI_MEDIA_DOWNLOAD__)
                throw Error('素材不可用');
              const extension = node.type.includes('Video')
                ? 'mp4'
                : node.type.includes('Audio')
                  ? 'mp3'
                  : 'png';
              const result = await window.__FISHERAI_MEDIA_DOWNLOAD__.download(
                node,
                node.resultUrl,
                extension,
              );
              if (result?.status === 'failed') throw Error('下载失败');
              return;
            }
            if (operation === 'runWorkflow') {
              if (node.kind !== 'workflow') throw Error('不是执行工作流');
              const epoch = getWorkflowEpoch();
              const configuration = () => {
                const current = getNodes().find((item) => item.id === node.id);
                return JSON.stringify([
                  current?.parameterValues,
                  current?.parentIds,
                  current?.sourcePortIndices,
                  current?.workflowRef,
                  current?.canvasNodeHash,
                  current?.runningHubInstanceType,
                  getNodes().filter((item) => current?.parentIds?.includes(item.id)),
                ]);
              };
              const expected = configuration();
              const authorized = () =>
                mountedRef.current && getWorkflowEpoch() === epoch && configuration() === expected;
              flushSync(() => {
                setSelectedNodeIds([node.id]);
                focusOnNodes(getNodes(), [node.id]);
              });
              await new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              );
              if (!authorized() || !(await requestWorkflowNodeRun(workflowId, node.id, authorized)))
                throw Error('请在节点核对原任务');
            }
          },
        }
      : null;
  const onCanvasPointerDown = (ke: ReactTypes.PointerEvent<HTMLDivElement>) => {
      if (spaceHeldRef.current && ke.button === 0) {
        startPanning(ke);
        setSelectedConnection(null);
        setContextMenu((st) => ({ ...st, isOpen: false }));
        return;
      }
      if ((isPendingConnection && cancelConnectionDrag(), ke.button === 1)) {
        startPanning(ke);
        setSelectedConnection(null);
        setContextMenu((st) => ({ ...st, isOpen: false }));
        return;
      }
      if (ke.target instanceof Element && ke.target.id === 'canvas-background' && ke.button === 0) {
        startSelection(ke, viewport);
        setSelectedNodeIds(window.__FISHERAI_CANVAS_SELECTION__?.clearSelection() ?? []);
        setSelectedConnection(null);
        setContextMenu((st) => ({ ...st, isOpen: false }));
        closeWorkflowPanel();
        closeHistoryPanel();
        closeAssetLibrary();
        closeWorkflowPresetPanel();
      }
    },
    onCanvasPointerMove = React.useCallback(
      (ke: ReactTypes.PointerEvent<HTMLDivElement>) => {
        pointerRef.current = { x: ke.clientX, y: ke.clientY };
        updatePointerPos(ke.clientX, ke.clientY);
        const { isUpdating: st, selectedIds: ot } = updateSelection(ke, nodes, viewport);
        if (st) {
          setSelectedNodeIds(ot);
          return;
        }
        if (!(
          updateNodeResize(ke, viewport, setNodes) ||
          updateNodeDrag(
            ke,
            viewport,
            setNodes,
            window.__FISHERAI_CANVAS_EDITING__?.getMovableNodeIds(selectedNodeIds) ??
              selectedNodeIds,
            { getWidth: getNodeWidth, getHeight: getNodeHeight },
          ) ||
          updateConnectionDrag(ke, nodes, viewport) ||
          isSelecting
        )) {
          updatePanning(ke, setViewport);
        }
      },
      [
        updatePointerPos,
        updateNodeResize,
        updateSelection,
        nodes,
        viewport,
        setSelectedNodeIds,
        updateNodeDrag,
        getNodeWidth,
        getNodeHeight,
        setNodes,
        selectedNodeIds,
        updateConnectionDrag,
        isSelecting,
        updatePanning,
        setViewport,
      ],
    ),
    startBatchConnection = React.useCallback(
      (ke: ReactTypes.PointerEvent<HTMLDivElement>, st: 'left' | 'right') => {
        const ot = selectedNodeIds;
        if (!(ot.length < 2)) {
          setBatchConnecting(true);
          handleConnectorPointerDown(ke, ot[0], st);
        }
      },
      [selectedNodeIds, handleConnectorPointerDown],
    ),
    onConnectionCompleted = React.useCallback((parent: string, child: string) => {
      // 记录本次手势真正建立起来的连线，Shift 改接据此判断要不要删旧线。
      completedConnectionsRef.current = [...completedConnectionsRef.current, [parent, child]];
    }, []),
    onCanvasPointerUp = React.useCallback(
      (ke: ReactTypes.PointerEvent<HTMLDivElement>) => {
        if (isSelecting) {
          setSelectedNodeIds(endSelection(nodes, viewport));
          releasePointerCapture(ke);
          return;
        }
        // 整束搬移：画布内松手先在这里收尾（window 监听是画布外松手的兜底）。
        if (bundleRef.current) {
          finishBundleDrag(locateBundleAt(ke.clientX, ke.clientY)?.targetId ?? null);
          releasePointerCapture(ke);
          return;
        }
        const st =
          batchConnecting && connectionStart
            ? groupBatchSourceIds?.length
              ? groupBatchSourceIds
              : Array.from(new Set(selectedNodeIds))
            : void 0;
        // Shift 改接松在空白处：直接收手，不弹"添加节点"菜单。
        const rewire = rewireRef.current;
        if (rewire && !connectionHoveredNodeId) {
          cancelConnectionDrag();
          restoreRewiredNode();
          releasePointerCapture(ke);
          return;
        }
        completedConnectionsRef.current = [];
        if (
          completeConnectionDrag(handleAddNext, setNodes, nodes, onConnectionCompleted, ke, st)
        ) {
          const target = connectionHoveredNodeId;
          if (rewire && target) {
            // 旧线在起手时已经断开了，这里只在"真的接到了新的一端"时才保持断开。
            const expectedParent = rewire.end === 'child' ? rewire.parentId : target,
              expectedChild = rewire.end === 'child' ? target : rewire.childId,
              connectedNow = completedConnectionsRef.current.some(
                ([parent, child]) => parent === expectedParent && child === expectedChild,
              ),
              // 落回原来那一端 = 没换地方，还原快照以保住 parentIds 顺序。
              sameEnd =
                rewire.end === 'child' ? target === rewire.childId : target === rewire.parentId;
            if (!connectedNow || sameEnd) restoreRewiredNode();
            else {
              rewireRef.current = null;
              setRewiringEdge(null);
            }
          } else if (rewire) {
            restoreRewiredNode();
          }
          setBatchConnecting(false);
          setGroupBatchSourceIds(null);
          releasePointerCapture(ke);
          return;
        }
        endPanning();
        endNodeResize();
        deferFrame(() => {
          if (isResizing || isDragging || window.__FISHERAI_CANVAS_EDITING__?.hasPendingMove()) {
            pushHistory();
          }
        });
        if (isDragging) syncGroupsAfterDrag();
        endNodeDrag();
        setBatchConnecting(false);
        setGroupBatchSourceIds(null);
        releasePointerCapture(ke);
      },
      [
        isSelecting,
        endSelection,
        nodes,
        viewport,
        setSelectedNodeIds,
        connectionStart,
        releasePointerCapture,
        completeConnectionDrag,
        handleAddNext,
        setNodes,
        onConnectionCompleted,
        endPanning,
        isDragging,
        pushHistory,
        deferFrame,
        endNodeDrag,
        isResizing,
        endNodeResize,
        batchConnecting,
        selectedNodeIds,
        groupBatchSourceIds,
        connectionHoveredNodeId,
        cancelConnectionDrag,
        locateBundleAt,
        restoreRewiredNode,
        syncGroupsAfterDrag,
      ],
    ),
    saveAnnotation = media.useCanvasImageEditSave(React, {
      nodes,
      getNodes,
      enabled: view === 'canvas',
      projectId: workflowId || undefined,
      setNodes,
      setSelectedNodeIds,
      title: '标注',
      getNodeWidth: () => 300,
    }),
    saveCrop = media.useCanvasCropSave(React, {
      nodes,
      getNodes,
      enabled: view === 'canvas',
      projectId: workflowId || undefined,
      setNodes,
      setSelectedNodeIds,
      getNodeWidth,
      getNodeHeight,
    }),
    saveResize = media.useCanvasImageEditSave(React, {
      nodes,
      getNodes,
      enabled: view === 'canvas',
      projectId: workflowId || undefined,
      setNodes,
      setSelectedNodeIds,
      title: '尺寸',
      getNodeWidth,
    }),
    saveComposite = media.useCanvasCompositeSave(React, {
      nodes,
      getNodes,
      enabled: view === 'canvas',
      projectId: workflowId || undefined,
      setNodes,
      setSelectedNodeIds,
      getNodeWidth,
    }),
    openComposite = React.useCallback(
      (ke: Record<string, unknown>) => {
        handleOpenComposite({ ...ke, onSave: saveComposite });
      },
      [handleOpenComposite, saveComposite],
    ),
    openProject = async (ke: string) => {
      const st = await loadProject(ke);
      if (st) {
        setFolderId(st.folderId || null);
        setView('canvas');
      }
    },
    chooseProjectFile = React.useCallback(() => {
      let ke;
      if (!((ke = projectFileRef.current) == null)) {
        ke.click();
      }
    }, []);
  const { handleOpenProjectFile, handleMergeProjectFile } = useProjectFiles({
      view,
      projectId: workflowId || undefined,
      getWorkflowEpoch,
      getNodes,
      setNodes,
      setGroups: (value) =>
        setGroups(
          (current) => (typeof value === 'function' ? value(current) : value) as CanvasGroup[],
        ),
      setSelectedNodeIds,
      importDocument,
      onOpened: (document) => {
        navigationRef.current++;
        applyingDocumentRef.current = true;
        setSavedAt(null);
        setSavedBy('用户-');
        setSavedRevision(null);
        setFolderId(null);
        reset({
          nodes: document.nodes,
          groups: document.groups as CanvasGroup[],
        });
        setDirty(true);
        setView('canvas');
      },
      onChanged: () => setDirty(true),
      createId,
    }),
    backToProjects = async () => {
      navigationRef.current++;
      resetWorkflowId();
      session?.clear();
      setView('dashboard');
    },
    newProject = (ke: string | null = null) => {
      navigationRef.current++;
      session?.clear();
      clearCanvas();
      setFolderId(typeof ke == 'string' ? ke : null);
      setView('canvas');
      newProjectPendingRef.current = true;
    },
    onDragOver = (ke: ReactTypes.DragEvent<HTMLDivElement>) => {
      ke.preventDefault();
      ke.stopPropagation();
      ke.dataTransfer.dropEffect = 'copy';
    },
    onDrop = (event: ReactTypes.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const bounds = canvasRef.current?.getBoundingClientRect();
      if (!bounds) return;
      return handleClipboardImagePaste([...event.dataTransfer.files], {
        x: event.clientX - bounds.left - 170 * viewport.zoom,
        y: event.clientY - bounds.top - 100 * viewport.zoom,
      });
    },
    projectScene = React.useMemo(
      () => createCanvasSceneProjector({ width: getNodeWidth, height: getNodeHeight, text: textForNode }),
      [getNodeWidth, getNodeHeight, textForNode],
    ),
    sceneData = React.useMemo(() => projectScene(nodes), [nodes, projectScene]),
    { nodeDisplayData, nodesByGroupId } = sceneData,
    { visibleNodeIds, visibleGroups } = React.useMemo(
      () => canvasVisibleScene(sceneData, groups, viewport, windowSize),
      [sceneData, groups, viewport, windowSize],
    ),
    onEdgeDoubleClick = React.useCallback(
      (
        ke: ReactTypes.MouseEvent,
        st: string,
        ot: string,
        Ge: number,
        parentIds?: string[],
      ) => {
        ke.stopPropagation();
        // 一条"组 → 下游"的线背后是多条成员连接，双击要一起断干净。
        // Ge < 0 表示组连线，端口交给 disconnect 按 parentId 自行匹配。
        const parents = parentIds?.length ? parentIds : [st],
          portIndex = Ge >= 0 ? Ge : undefined;
        setNodes((current) =>
          parents.reduce(
            (result, parentId) => disconnectCanvasNodes(result, { parentId, childId: ot, portIndex }),
            current,
          ),
        );
        setSelectedConnection(null);
      },
      [setSelectedConnection, setNodes],
    ),
    onEdgeClick = React.useCallback(
      (ke: ReactTypes.MouseEvent, st: string, ot: string, Ge: number) => {
        if (!ke.shiftKey) {
          clearSelection();
        }
        handleEdgeClick(ke, st, ot, Ge);
      },
      [clearSelection, handleEdgeClick],
    );

  React.useEffect(() => {
    if (view === 'canvas' && isMinimapOpen && zoomControlsRef.current) {
      const ke = zoomControlsRef.current.getBoundingClientRect();
      if (ke.width > 0) {
        setMinimapWidth(ke.width + 24);
      }
      const st = new ResizeObserver((ot) => {
        for (const Ge of ot)
          if (Ge.target === zoomControlsRef.current) {
            const ft = Ge.contentRect.width;
            if (ft > 0) {
              setMinimapWidth(ft + 24);
            }
          }
      });
      return (st.observe(zoomControlsRef.current), () => st.disconnect());
    }
  }, [isMinimapOpen, view]);
  React.useEffect(() => {
    window.__FISHERAI_FOCUS_NODES__ = focusNodes;
    return () => {
      if (window.__FISHERAI_FOCUS_NODES__ === focusNodes) {
        delete window.__FISHERAI_FOCUS_NODES__;
      }
    };
  }, [focusNodes]);
  React.useEffect(() => {
    mountedRef.current = true;
    const navigation = navigationRef;
    return () => {
      mountedRef.current = false;
      navigation.current++;
    };
  }, []);
  React.useEffect(() => {
    let active = true;
    const ke = session?.load();
    const intent = navigationRef.current + 1;
    if (ke) {
      loadProject(ke.workflowId)
        .then((st) => {
          if (!active || !mountedRef.current || intent !== navigationRef.current) return;
          if (st) {
            setFolderId(st.folderId || ke.folderId || null);
            setViewport(ke.viewport);
            setView('canvas');
          } else {
            session?.clear();
          }
        })
        .catch(() => {
          if (active && mountedRef.current && intent === navigationRef.current) session?.clear();
        });
    }
    return () => {
      active = false;
    };
  }, [loadProject, session, setViewport]);
  React.useEffect(() => {
    if (view === 'canvas' && workflowId) {
      session?.save({
        workflowId,
        folderId: typeof folderId === 'string' ? folderId : null,
        viewport,
      });
    }
  }, [view, workflowId, folderId, viewport, session]);
  React.useEffect(() => {
    const previous = observedContentRef.current;
    observedContentRef.current = { nodes, groups, title: canvasTitle };
    if (firstEditRef.current) {
      firstEditRef.current = false;
      loadingCountRef.current = nodes.filter((ot) => ot.status === NodeStatus.LOADING).length;
      resultCountRef.current = nodes.filter(
        (ot) => ot.status === NodeStatus.SUCCESS && ot.resultUrl,
      ).length;
      return;
    }
    if (applyingDocumentRef.current) {
      applyingDocumentRef.current = false;
      return;
    }
    if (previous.nodes === nodes && previous.groups === groups && previous.title === canvasTitle)
      return;
    setDirty(true);
    if (!isDragging && !isResizing && !isDraggingConnection && !isSelecting && !groupFrameResizing) {
      pushHistory({ nodes, groups });
    }
    const ke = nodes.filter((ot) => ot.status === NodeStatus.LOADING).length;
    if (ke > loadingCountRef.current) {
      save();
    }
    loadingCountRef.current = ke;
    const st = nodes.filter((ot) => ot.status === NodeStatus.SUCCESS && ot.resultUrl).length;
    if (st > resultCountRef.current) {
      save();
    }
    resultCountRef.current = st;
  }, [
    nodes,
    groups,
    canvasTitle,
    NodeStatus,
    isDragging,
    isResizing,
    isDraggingConnection,
    isSelecting,
    groupFrameResizing,
    pushHistory,
    save,
  ]);
  React.useEffect(() => {
    if (selectedNodeIds.length === 1) {
      const ke = nodes.find((st) => st.id === selectedNodeIds[0]);
      if (
        ke &&
        ((['image', 'upload image', 'video', 'upload video', 'audio', 'upload audio'].includes(
          String(ke.type).toLowerCase(),
        ) &&
          ke.resultUrl) ||
          ((ke.type === NodeType.VIDEO || ke.type === NodeType.UPLOAD_VIDEO) &&
            (ke.lastFrame || ke.resultUrl)))
      ) {
        selectedCoverRef.current = ke.id;
      }
    }
  }, [selectedNodeIds, nodes, NodeType]);
  React.useEffect(() => {
    if (view === 'canvas' && newProjectPendingRef.current) {
      newProjectPendingRef.current = false;
      save();
    }
  }, [view, save]);
  React.useEffect(() => {
    cleanupInvalidGroups(nodes, setNodes);
  }, [nodes, cleanupInvalidGroups, setNodes]);
  React.useEffect(() => {
    const insert = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          nodes?: CanvasNode[];
          nodeIds?: string[];
        }>
      ).detail;
      if (
        !Array.isArray(detail?.nodes) ||
        !Array.isArray(detail.nodeIds) ||
        !detail.nodeIds.length
      )
        return;
      setView('canvas');
      setSettingsOpen(false);
      // The insertion event is already emitted after the node store accepts the nodes.
      // A second RAF can be cancelled by the very render caused by this insertion.
      focusOnNodes(detail.nodes, detail.nodeIds);
      setSelectedNodeIds(detail.nodeIds);
    };
    window.addEventListener('fisherai:workflow-canvas-inserted', insert);
    return () => {
      window.removeEventListener('fisherai:workflow-canvas-inserted', insert);
    };
  }, [view, focusOnNodes, setSelectedNodeIds]);
  React.useEffect(() => {
    const ke = () => setSettingsOpen(true);
    return (
      window.addEventListener('fisherai:open-settings', ke),
      () => window.removeEventListener('fisherai:open-settings', ke)
    );
  }, [setSettingsOpen]);
  if (view === 'dashboard')
    return React.createElement(React.Fragment, {
      children: [
        React.createElement(Projects, {
          key: 'projects',
          onOpenProject: openProject,
          onNewProject: newProject,
          initialFolderId: folderId,
        }),
        React.createElement(Settings, {
          key: 'settings',
          isOpen: settingsOpen,
          onClose: () => setSettingsOpen(false),
          localUserName,
          setLocalUserName,
          localUserId,
          localUserNo,
        }),
      ],
    });
  const batchSourceNodeIds =
    batchConnecting && connectionStart
      ? groupBatchSourceIds?.length
        ? groupBatchSourceIds
        : Array.from(new Set(selectedNodeIds))
      : pendingBatchSourceNodeIds;
  return React.createElement('div', {
    key: 'div',
    className:
      'w-screen h-screen bg-[var(--af-input)] text-[var(--af-text)] overflow-hidden select-none font-sans transition-colors duration-300',
    children: [
      React.createElement(Header, {
        key: 'header',
        canvasTitle,
        isEditingTitle,
        editingTitleValue,
        canvasTitleInputRef,
        setCanvasTitle,
        setIsEditingTitle,
        setEditingTitleValue,
        onSave: () => save({ manual: true, reportFailure: true }),
        documentEpoch: getWorkflowEpoch(),
        onBack: backToProjects,
        onImportProjectJson: chooseProjectFile,
        hasUnsavedChanges,
        isChatOpen,
        chatPanelWidth,
        lastAutoSaveTime: savedAt,
        lastSavedBy: savedBy,
        lastSavedRevision: savedRevision,
      }),
      React.createElement('input', {
        key: 'input',
        ref: projectFileRef,
        type: 'file',
        accept: '.json,.fisherai,application/json',
        onChange: async (event: ReactTypes.ChangeEvent<HTMLInputElement>) => {
          const file = event.target.files?.[0];
          if (!file?.name.toLowerCase().endsWith('.fisherai')) return handleOpenProjectFile(event);
          event.target.value = '';
          const epoch = getWorkflowEpoch();
          try {
            if (view === 'canvas' && !(await projectRuntime.current()?.save())) return;
            const response = await fetch(
              '/api/workflows/restore',
              projectArchiveRestoreRequest(file),
            );
            if (!response.ok) throw Error('备份导入未确认，请核对项目列表。');
            const restored = await response.json();
            if (typeof restored.id !== 'string') throw Error('备份回执无效，请核对项目列表。');
            if (getWorkflowEpoch() === epoch) await openProject(restored.id);
          } catch (error) {
            window.alert(error instanceof Error ? error.message : '备份导入未完成。');
          }
        },
        className: 'hidden',
      }),
      React.createElement('input', {
        key: 'merge-project-file',
        type: 'file',
        accept: '.json,application/json',
        ref: mergeProjectFileRef,
        style: { display: 'none' },
        onChange: handleMergeProjectFile,
      }),
      React.createElement(Sidebar, {
        key: 'sidebar',
        onAddClick: handleToolbarAdd,
        onWorkflowsClick: () =>
          window.dispatchEvent(new CustomEvent('fisherai:open-workflow-library')),
        onWorkflowPresetsClick: () =>
          window.dispatchEvent(new CustomEvent('fisherai:open-skill-community')),
        onHistoryClick: openHistory,
        onAssetsClick: openAssets,
        onToolsOpen: () => {
          closeWorkflowPanel();
          closeHistoryPanel();
          closeAssetLibrary();
          closeWorkflowPresetPanel();
        },
        onSettingsClick: () => {
          setSettingsOpen(true);
        },
        currentUserName: localUserName,
        currentUserColor: userColor,
      }),
      React.createElement(Scene, {
        key: 'scene',
        documentEpoch: getWorkflowEpoch(),
        nodes,
        viewport,
        selectedNodeIds,
        groups,
        visibleNodeIds,
        visibleGroups,
        nodesByGroupId,
        nodeDisplayData,
        alignmentGuides: isDragging ? alignCanvasDrag(nodes, selectedNodeIds,
          { getWidth: getNodeWidth, getHeight: getNodeHeight }, { x: 0, y: 0 }, viewport.zoom, 0.01).guides : [],
        isPanning,
        panModeHeld: spaceHeld,
        isDragging,
        isResizing,
        isDraggingConnection,
        isPendingConnection,
        connectionStart,
        tempConnectionEnd,
        batchConnectionSourceNodeIds: batchSourceNodeIds,
        connectionHoveredNodeId: bundlePreview?.targetId ?? connectionHoveredNodeId,
        connectionHoveredSide: hoveredSide,
        connectionHoveredPortIndex: hoveredPortIndex,
        isInvalidHover,
        selectedConnection,
        showGridSlider,
        gridColumns,
        isCompact,
        canvasRef,
        onPointerDown: onCanvasPointerDown,
        onPointerMove: onCanvasPointerMove,
        onPointerUp: onCanvasPointerUp,
        onWheel: onCanvasWheel,
        onDoubleClick: handleDoubleClick,
        onContextMenu: handleGlobalContextMenu,
        onDragOver,
        onDrop,
        onEdgeClick,
        onEdgeDoubleClick,
        onEdgeShiftDown: startEdgeRewire,
        rewiringEdge,
        bundlePreview,
        groupFrameOffset,
        onGroupBatchConnectorDown: startGroupConnection,
        onGroup: (ke: string[]) => groupNodes(ke, nodes, setNodes),
        onUngroup: (ke: string) => ungroupNodes(ke, nodes, setNodes),
        onRenameGroup: renameGroup,
        onGridLayout: (ke: number) => gridLayoutNodes(ke, isCompact),
        onToggleGridSlider: () => {
          if (!showGridSlider) {
            gridLayoutNodes(gridColumns, isCompact);
          }
          setShowGridSlider(!showGridSlider);
        },
        onCreateCollage: createCollage,
        onNodePointerDown: (ke: ReactTypes.PointerEvent<HTMLDivElement>, st: string) => {
          const Ge = window.__FISHERAI_CANVAS_SELECTION__;
          if (Ge) {
            setSelectedNodeIds(Ge.selectNode(selectedNodeIds, st, ke));
          } else {
            if (!selectedNodeIds.includes(st)) {
              setSelectedNodeIds(
                ke.shiftKey || ke.ctrlKey || ke.metaKey ? (ft) => [...ft, st] : [st],
              );
            }
          }
          if (!(ke.shiftKey || ke.ctrlKey || ke.metaKey)) {
            setSelectedConnection(null);
          }
          rememberDragOrigin();
          handleNodePointerDown(ke, st, void 0);
        },
        onNodeContextMenu: handleNodeContextMenu,
        onSelect: (ke: string) => {
          setSelectedNodeIds([ke]);
          setSelectedConnection(null);
        },
        onGroupPointerDown: (ke: ReactTypes.PointerEvent<HTMLDivElement>, st: string[]) => {
          rememberDragOrigin();
          const anchorId = st[0],
            anchor = anchorId ? nodes.find((node) => node.id === anchorId) : undefined;
          const group = st.length
            ? groups.find((candidate) => candidate.nodeIds.includes(anchorId))
            : undefined;
          groupDragRef.current =
            group && anchor
              ? { groupId: group.id, anchorId, anchorX: anchor.x, anchorY: anchor.y }
              : null;
          const ht = window.__FISHERAI_CANVAS_SELECTION__;
          if (ht) {
            setSelectedNodeIds(ht.selectGroup(selectedNodeIds, st, ke));
          } else {
            if (ke.shiftKey || ke.ctrlKey || ke.metaKey) {
              setSelectedNodeIds((Rt) => [...new Set([...Rt, ...st])]);
            } else {
              if (st.length > 0) {
                setSelectedNodeIds(st);
              }
            }
          }
          if (!(ke.shiftKey || ke.ctrlKey || ke.metaKey)) {
            setSelectedConnection(null);
          }
          if (st.length > 0) {
            handleNodePointerDown(ke, st[0], void 0);
          }
        },
        onConnectorDown: (
          ke: ReactTypes.PointerEvent<HTMLDivElement>,
          st: string,
          ot: 'left' | 'right',
          Ge: number,
        ) => {
          // Shift + 拖节点圆点 = 把这个端口上的全部连线当成一束搬走（右输出、左输入）。
          if (ke.shiftKey && startBundleDrag(ke, st, ot)) return;
          setBatchConnecting(false);
          setGroupBatchSourceIds(null);
          handleConnectorPointerDown(ke, st, ot, Ge);
        },
        onSelectionResizeStart: (
          ke: ReactTypes.PointerEvent<HTMLDivElement>,
          st: SelectionResizeHandle,
          ot: CanvasNodeFrame[],
        ) => startSelectionResize(ke, st, ot),
        onSelectionBatchConnectorDown: startBatchConnection,
        onGroupResizeStart: handleGroupFrameResize,
        onNodeUpload: replaceMedia,
        onExpand: handleExpandImage,
        onDragStart: handleNodeDragStart,
        onDragEnd: handleNodeDragEnd,
        onWriteContent: handleWriteContent,
        onTextToVideo: handleTextToVideo,
        onTextToImage: handleTextToImage,
        onMiniMaxH3T2VAGenerate: handleMiniMaxH3T2VAGenerate,
        onVideoSnapshot: handleVideoSnapshot,
        onVideoFirstLastSnapshot: handleVideoFirstLastSnapshot,
        onAudioTrim: handleAudioTrim,
        onOpenCompare: handleOpenCompare,
        onOpenComposite: openComposite,
        onNodeMouseEnter: () => {},
        onNodeMouseLeave: () => {},
        onResizeStart: handleResizeStart,
        onUpdateNode: updateNode,
        onGenerate: handleGenerate,
        onAddNext: handleAddNext,
        getCommonGroup,
        onSaveAsset: handleOpenCreateAsset,
        onAnnotate: handleStartAnnotation,
        onCrop: handleStartCrop,
        onResizeImage: handleStartResize,
        onUpscaleImage: handleUpscaleImage,
        projectId: workflowId || void 0,
      }),
      React.createElement(Controls, {
        key: 'controls',
        view,
        canvasRef,
        documentEpoch: getWorkflowEpoch(),
        nodes,
        viewport,
        onViewportChange: setViewport,
        isMinimapOpen,
        setIsMinimapOpen: setMinimapOpen,
        minimapWidth,
        zoomControlsRef,
        onResetCanvas: focusOnNodes,
        onSliderZoom: handleSliderZoom,
        showGridSlider,
        setShowGridSlider,
        gridColumns,
        setGridColumns,
        isCompact,
        setIsCompact: setCompact,
        onGridLayout: gridLayoutNodes,
        selectedNodeIds,
      }),
      React.createElement(SidePanels, {
        key: 'sidepanels',
        documentEpoch: getWorkflowEpoch(),
        isWorkflowPanelOpen,
        workflowPanelY,
        onCloseWorkflowPanel: closeWorkflowPanel,
        onLoadWorkflow: loadProject,
        workflowId: workflowId || void 0,
        isHistoryPanelOpen,
        historyPanelY,
        onCloseHistoryPanel: closeHistoryPanel,
        onSelectAsset: selectHistoryAsset,
        isAssetLibraryOpen,
        assetLibraryY,
        assetLibraryVariant,
        onCloseAssetLibrary: closeAssetLibrary,
        onLibrarySelect: importLibraryAsset,
        isWorkflowPresetPanelOpen,
        workflowPresetPanelY,
        onCloseWorkflowPresetPanel: closeWorkflowPresetPanel,
        onWorkflowPresetSelect: handleImportWorkflowPreset,
        isChatOpen,
        onToggleChat: toggleChat,
        onCloseChat: closeChat,
        localUserName,
        isDraggingNodeToChat,
        chatPanelWidth,
        onChatPanelWidthChange: setChatPanelWidth,
        projectId: workflowId || void 0,
        nodes,
        selectedAgentReferenceNodes: agentReferences,
        selectedNodeIds,
        onApplyPrompt: (proposal: PromptProposal) =>
          applyCanvasPromptProposal(getNodes(), proposal, updateNode),
        onCreateTextNode: (text: string) => {
          const runtime = getWorkflowEpoch() === documentEpoch ? controlRuntime.current() : null;
          if (!runtime) throw new Error('当前画布不可编辑，请结束拖拽后重试。');
          const before = runtime.snapshot();
          const node = runtime.create(
            'Text',
            { x: (160 - viewport.x) / viewport.zoom, y: (120 - viewport.y) / viewport.zoom },
            runtime.projectId,
          );
          node.title = 'Agent 提示词';
          node.textContent = text;
          node.textMode = 'editing';
          runtime.commit(before, { ...before, nodes: [...before.nodes, node] });
          runtime.focus?.([node.id]);
          return node.id;
        },
        onCanvasAction: canvasControl,
        canvasCreation,
        canvasProjects,
        canvasBudgets,
        canvasExternal,
        canvasProducts,
        onLocateNode: (ke: string) => {
          focusOnNodes(nodes, [ke]);
          setSelectedNodeIds([ke]);
        },
      }),
      React.createElement(Overlays, {
        key: 'overlays',
        contextMenu,
        onCloseContextMenu: () => {
          setContextMenu((ke) => ({ ...ke, isOpen: false }));
          cancelConnectionDrag();
        },
        onSelectType: handleContextMenuSelect,
        onUpload: handleContextUpload,
        onUndo: undo,
        onRedo: redo,
        onPaste: handlePaste,
        onCopy: handleCopy,
        onCreateAsset: handleContextMenuCreateAsset,
        onCreateWorkflow: handleContextMenuCreateWorkflowPreset,
        onAddAssets: openAssetsModal,
        canCreateWorkflow: canCreateWorkflowPreset,
        canUndo,
        canRedo,
        expandedImageUrl,
        expandedComparePayload,
        expandedCompositePayload,
        onCloseExpand: handleCloseExpand,
        onCloseCompare: handleCloseCompare,
        onCloseComposite: handleCloseComposite,
        isCreateAssetModalOpen,
        setIsCreateAssetModalOpen,
        nodeToSnapshot,
        assetCategories,
        assetDefaultOwnership: canvasTitle,
        onSaveAssetToLibrary: handleSaveAssetToLibrary,
        isCreateWorkflowPresetModalOpen,
        setIsCreateWorkflowPresetModalOpen,
        workflowPresetCoverUrl,
        workflowPresetCategories,
        workflowPresetDefaultName,
        onSaveWorkflowPreset: handleSaveWorkflowPreset,
      }),
      React.createElement(Settings, {
        key: 'settings',
        isOpen: settingsOpen,
        onClose: () => setSettingsOpen(false),
        localUserName,
        setLocalUserName,
        localUserId,
        localUserNo,
      }),
      annotatingNodeId &&
        React.createElement(Annotation, {
          key: 'annotation',
          node: nodes.find((ke) => ke.id === annotatingNodeId),
          onSave: saveAnnotation,
          onClose: handleCloseAnnotation,
          projectId: workflowId || undefined,
        }),
      cropNodeId &&
        React.createElement(Crop, {
          key: `crop:${workflowId}:${cropNodeId}:${imageEditorMode}`,
          mode: imageEditorMode,
          onPanorama: (id: string) => {
            if (!workflowId || view !== 'canvas') throw new Error('请先打开项目。');
            const result = createImageAngleDraft(getNodes(), id, null, workflowId, {
              create: createAgentNode,
              configure: configureAgentNode,
              connect: connectAgentNodes,
              width: getNodeWidth,
            });
            flushSync(() => {
              setNodes(result.nodes);
              setSelectedNodeIds([result.id]);
            });
            void handleGenerate(result.id);
          },
          onAngle: (id: string, angle: ImageAngle) => {
            if (!workflowId || view !== 'canvas') throw new Error('请先打开项目。');
            const result = createImageAngleDraft(getNodes(), id, angle, workflowId, {
              create: createAgentNode,
              configure: configureAgentNode,
              connect: connectAgentNodes,
              width: getNodeWidth,
            });
            flushSync(() => {
              setNodes(result.nodes);
              setSelectedNodeIds([result.id]);
            });
            void handleGenerate(result.id);
          },
          sources: nodes.filter(
            (node) => ['Image', 'Upload Image'].includes(node.type) && node.resultUrl,
          ),
          node: nodes.find((ke) => ke.id === cropNodeId),
          onSave: saveCrop,
          onClose: handleCloseCrop,
          projectId: workflowId || undefined,
        }),
      resizeNodeId &&
        React.createElement(Resize, {
          key: 'resize',
          node: nodes.find((ke) => ke.id === resizeNodeId),
          onSave: saveResize,
          onClose: handleCloseResize,
          projectId: workflowId || undefined,
        }),
      selectionBox.isActive &&
        React.createElement('div', {
          key: 'div',
          className: 'absolute pointer-events-none',
          style: {
            left: Math.min(selectionBox.startX, selectionBox.endX),
            top: Math.min(selectionBox.startY, selectionBox.endY),
            width: Math.abs(selectionBox.endX - selectionBox.startX),
            height: Math.abs(selectionBox.endY - selectionBox.startY),
            border: '2px solid #3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            borderRadius: '12px',
            zIndex: 1e3,
          },
        }),
    ],
  });
}
