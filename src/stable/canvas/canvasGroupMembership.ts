/**
 * 组的成员跟着位置走：拖进组框就加入，拖出去就离开。
 *
 * 只在一次拖动结束时结算一次，不在拖动过程中改数据 —— 拖动中改 nodeIds 会让
 * 组框每帧改变大小，手感会抖。
 *
 * 组框（group.frame）是**独立存的一份**，可以手动缩放、不随成员移动而改变。
 * 因此成员去留直接看"节点中心是否在组框里"：
 *  - 拖出框 → 离开；拖进框 → 加入；框不会因为成员移动而变大，所以出得去。
 *  - 整组平移时由 translateGroupFrames 把框一起搬走。
 * 历史教训：早期用"按成员算包围盒"再判离组，会自我指涉（框跟着被拖的节点变大，
 * 永远出不去）；后来又用"到其他成员的距离"判退组，把相距较远的正常组员判成离组，
 * 导致刚打好的组在下次拖动后自动散开。这两条都不要退回去。
 */
import { GROUP_FRAME_PADDING } from './canvasGroups';

export interface MembershipNode {
  id: string;
  x: number;
  y: number;
  groupId?: string;
  [key: string]: unknown;
}

export interface MembershipGroup {
  id: string;
  nodeIds: string[];
  [key: string]: unknown;
}

export interface MembershipMeasurer<TNode extends MembershipNode> {
  width(node: TNode): number;
  height(node: TNode): number;
}

/** 组只剩下一个成员时不再算组，直接解散。 */
const MIN_MEMBERS = 2;
/** 冻结框判定容差：中心点贴在框上不算出去。 */
const EDGE_TOLERANCE = 6;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function rectOf<TNode extends MembershipNode>(
  node: TNode,
  measure: MembershipMeasurer<TNode>,
): Rect {
  const width = Math.max(0, measure.width(node)),
    height = Math.max(0, measure.height(node));
  return {
    left: node.x,
    top: node.y,
    right: node.x + width,
    bottom: node.y + height,
  };
}

/** 读取组自己存的 frame；旧数据缺失/非法时返回 null，由调用方补算。 */
function readGroupFrame(group: MembershipGroup): Rect | null {
  const frame = (group as { frame?: Record<string, unknown> }).frame;
  if (!frame) return null;
  const x = Number(frame.x),
    y = Number(frame.y),
    width = Number(frame.width),
    height = Number(frame.height);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { left: x, top: y, right: x + width, bottom: y + height };
}

function centerOf(rect: Rect) {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

/**
 * 返回 null 表示没有任何变化 —— 调用方据此跳过 setState，避免无意义的历史记录。
 */
export function syncCanvasGroupMembership<
  TNode extends MembershipNode,
  TGroup extends MembershipGroup,
>(
  nodes: readonly TNode[],
  groups: readonly TGroup[],
  measure: MembershipMeasurer<TNode>,
): { nodes: TNode[]; groups: TGroup[] } | null {
  if (!groups.length) return null;
  const groupIds = new Set(groups.map((group) => group.id));

  const rects = new Map<string, Rect>();
  const membersByGroup = new Map<string, TNode[]>();
  for (const node of nodes) {
    rects.set(node.id, rectOf(node, measure));
    const groupId = typeof node.groupId === 'string' ? node.groupId : undefined;
    if (!groupId || !groupIds.has(groupId)) continue;
    const list = membersByGroup.get(groupId) || [];
    list.push(node);
    membersByGroup.set(groupId, list);
  }

  /** 旧组数据没有 frame 时，按成员包围盒补一份并写回，之后就一直用它。 */
  const boxOfMembers = (groupId: string): Rect | null => {
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const member of membersByGroup.get(groupId) || []) {
      const rect = rects.get(member.id);
      if (!rect) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    if (![left, top, right, bottom].every(Number.isFinite)) return null;
    return {
      left: left - GROUP_FRAME_PADDING,
      top: top - GROUP_FRAME_PADDING,
      right: right + GROUP_FRAME_PADDING,
      bottom: bottom + GROUP_FRAME_PADDING,
    };
  };

  const frames = new Map<string, Rect>();
  let framesPatched = false;
  const resolvedGroups = groups.map((group) => {
    const stored = readGroupFrame(group);
    if (stored) {
      frames.set(group.id, stored);
      return group;
    }
    const box = boxOfMembers(group.id);
    if (!box) return group;
    frames.set(group.id, box);
    framesPatched = true;
    return {
      ...group,
      frame: {
        x: box.left,
        y: box.top,
        width: box.right - box.left,
        height: box.bottom - box.top,
      },
    } as TGroup;
  });

  // 成员去留只看"组框"：节点中心在框内就留，出框就走。
  // 组框是独立存的一份，不会随成员移动而变大，所以拖着成员往外走时能真正出组。
  const nextGroupId = new Map<string, string | undefined>();
  for (const node of nodes) {
    const currentGroupId =
      typeof node.groupId === 'string' && groupIds.has(node.groupId) ? node.groupId : undefined;
    if (!currentGroupId) continue;
    const rect = rects.get(node.id),
      frame = frames.get(currentGroupId);
    if (!rect || !frame) {
      nextGroupId.set(node.id, currentGroupId);
      continue;
    }
    const { x, y } = centerOf(rect);
    const inside =
      x >= frame.left - EDGE_TOLERANCE &&
      x <= frame.right + EDGE_TOLERANCE &&
      y >= frame.top - EDGE_TOLERANCE &&
      y <= frame.bottom + EDGE_TOLERANCE;
    nextGroupId.set(node.id, inside ? currentGroupId : undefined);
  }

  // 没有归属的节点，看看中心点落进了哪个组框（多个重叠时取面积最小的）。
  for (const node of nodes) {
    if (nextGroupId.get(node.id)) continue;
    const rect = rects.get(node.id);
    if (!rect) continue;
    const point = centerOf(rect);
    let picked: { id: string; area: number } | null = null;
    for (const group of resolvedGroups) {
      // 刚从这个组离开的节点，同一次手势里不再放回去（否则原地打转、永远拖不出去）。
      if (group.id === node.groupId) continue;
      const frame = frames.get(group.id);
      if (!frame) continue;
      if (
        point.x < frame.left ||
        point.x > frame.right ||
        point.y < frame.top ||
        point.y > frame.bottom
      )
        continue;
      const area = (frame.right - frame.left) * (frame.bottom - frame.top);
      if (!picked || area < picked.area) picked = { id: group.id, area };
    }
    if (picked) nextGroupId.set(node.id, picked.id);
  }

  let changed = false;
  for (const node of nodes) {
    if (nextGroupId.get(node.id) !== node.groupId) {
      changed = true;
      break;
    }
  }
  // 新补的组框也要写回，否则旧组永远停在"按成员算框"的状态。
  if (!changed && !framesPatched) return null;

  const nodesWithGroup = nodes.map((node) => {
    const target = nextGroupId.get(node.id);
    if (target === node.groupId) return node;
    if (!target) {
      const stripped = { ...node };
      delete stripped.groupId;
      return stripped;
    }
    return { ...node, groupId: target };
  });

  const groupsNext: TGroup[] = [];
  let groupsChanged = false;
  for (const group of resolvedGroups) {
    const memberIds = nodesWithGroup
      .filter((node) => node.groupId === group.id)
      .map((node) => node.id);
    if (memberIds.length < MIN_MEMBERS) {
      groupsChanged = true;
      continue;
    }
    const same =
      memberIds.length === group.nodeIds.length &&
      memberIds.every((id, index) => group.nodeIds[index] === id);
    if (same) {
      groupsNext.push(group);
      continue;
    }
    groupsChanged = true;
    groupsNext.push({ ...group, nodeIds: memberIds });
  }

  return {
    // 组被解散时，残留的成员也要去掉 groupId，否则会指向不存在的组。
    nodes: groupsChanged
      ? nodesWithGroup.map((node) => {
          if (!node.groupId) return node;
          if (groupsNext.some((group) => group.id === node.groupId)) return node;
          const stripped = { ...node };
          delete stripped.groupId;
          return stripped;
        })
      : nodesWithGroup,
    groups: groupsChanged || framesPatched ? (groupsChanged ? groupsNext : resolvedGroups) : resolvedGroups,
  };
}

/** 组连线（组 → 下游）在成员身上的表示：成员 → 下游 各连一条。 */
interface GroupLinkNode {
  id: string;
  type?: string;
  groupId?: string;
  parentIds?: string[];
  sourcePortIndices?: number[];
  [key: string]: unknown;
}

/**
 * 成员被移出组时，把它与"本组仍然连着的下游"之间的连线一起删掉。
 *
 * 原因：组传给下游的其实是每个成员各连一条（下游要靠 parentIds 拿到全部参考图）。
 * 成员拖出组以后，组框里少了一张图，但那条线还挂着，看起来就像"它还在组里"。
 * 判定条件用"组里还有别的成员连着同一个下游"，避免误删用户单独连过的线。
 */
export function dropDepartedGroupLinks<TNode extends GroupLinkNode>(
  nodes: readonly TNode[],
  previousGroupIds: ReadonlyMap<string, string | undefined>,
): TNode[] {
  const groupIdOf = (node: GroupLinkNode): string | undefined =>
    typeof node.groupId === 'string' ? node.groupId : undefined;

  const remainingByGroup = new Map<string, Set<string>>();
  for (const node of nodes) {
    const groupId = groupIdOf(node);
    if (!groupId) continue;
    const bucket = remainingByGroup.get(groupId) ?? new Set<string>();
    bucket.add(node.id);
    remainingByGroup.set(groupId, bucket);
  }

  const departed = nodes.filter((node) => {
    const before = previousGroupIds.get(node.id);
    return typeof before === 'string' && before !== groupIdOf(node);
  });
  if (!departed.length) return nodes as TNode[];

  const dropped = new Set<string>();
  const key = (parentId: string, childId: string) => `${parentId}\u0000${childId}`;
  for (const node of departed) {
    const before = previousGroupIds.get(node.id);
    if (!before) continue;
    const remaining = remainingByGroup.get(before);
    // 整组解散时不删线：那些线就变成普通的个体连结了。
    if (!remaining || !remaining.size) continue;
    for (const child of nodes) {
      const parents = child.parentIds ?? [];
      if (!parents.includes(node.id)) continue;
      if (!parents.some((parentId) => parentId && parentId !== node.id && remaining.has(parentId)))
        continue;
      dropped.add(key(node.id, child.id));
    }
  }
  if (!dropped.size) return nodes as TNode[];

  let changed = false;
  const next = nodes.map((node) => {
    const parents = node.parentIds ?? [];
    if (!parents.some((parentId) => dropped.has(key(parentId, node.id)))) return node;
    changed = true;
    const ports = node.sourcePortIndices ?? [];
    const nextParents: string[] = [];
    const nextPorts: number[] = [];
    parents.forEach((parentId, index) => {
      if (dropped.has(key(parentId, node.id))) {
        // ComfyUI 用空串占位，保持输入槽位不位移。
        if (node.type === 'ComfyUI') {
          nextParents.push('');
          nextPorts.push(0);
        }
        return;
      }
      nextParents.push(parentId);
      nextPorts.push(ports[index] ?? 0);
    });
    return { ...node, parentIds: nextParents, sourcePortIndices: nextPorts };
  });
  return changed ? next : (nodes as TNode[]);
}

/**
 * 成员被拖进组时，自动接到"这一组已经连着的下游"上。
 *
 * 和 dropDepartedGroupLinks 对称：组的下游是靠每个成员各连一条实现的，
 * 新成员进来如果没这条线，它在视觉上进了组却不会参与下游生成。
 * 只连"组里别的成员也在连"的下游，避免把无关的连线带进来。
 */
export function connectJoinedGroupLinks<TNode extends GroupLinkNode>(
  nodes: readonly TNode[],
  previousGroupIds: ReadonlyMap<string, string | undefined>,
): TNode[] {
  const groupIdOf = (node: GroupLinkNode): string | undefined =>
    typeof node.groupId === 'string' ? node.groupId : undefined;

  const membersByGroup = new Map<string, Set<string>>();
  for (const node of nodes) {
    const groupId = groupIdOf(node);
    if (!groupId) continue;
    const bucket = membersByGroup.get(groupId) ?? new Set<string>();
    bucket.add(node.id);
    membersByGroup.set(groupId, bucket);
  }

  const joined = nodes.filter((node) => {
    const groupId = groupIdOf(node);
    if (!groupId) return false;
    return previousGroupIds.get(node.id) !== groupId;
  });
  if (!joined.length) return nodes as TNode[];

  let next = nodes as TNode[];
  for (const node of joined) {
    const groupId = groupIdOf(node);
    if (!groupId) continue;
    const members = membersByGroup.get(groupId);
    if (!members) continue;
    // 这一组共同连接的下游：至少有一个"别的成员"连着的子节点。
    const targets = next.filter(
      (child) =>
        child.id !== node.id &&
        (child.parentIds ?? []).some(
          (parentId) => parentId && parentId !== node.id && members.has(parentId),
        ),
    );
    for (const child of targets) {
      next = next.map((candidate) => {
        if (candidate.id !== child.id) return candidate;
        const parents = [...(candidate.parentIds ?? [])];
        if (parents.includes(node.id)) return candidate;
        const ports = [...(candidate.sourcePortIndices ?? [])];
        while (ports.length < parents.length) ports.push(0);
        if (candidate.type === 'ComfyUI') {
          const slot = parents.findIndex((id) => !id);
          if (slot < 0) return candidate;
          parents[slot] = node.id;
          ports[slot] = 0;
        } else {
          parents.push(node.id);
          ports.push(0);
        }
        return { ...candidate, parentIds: parents, sourcePortIndices: ports };
      });
    }
  }
  return next;
}

/**
 * 整组平移时，把组框一起搬走。
 *
 * 组框是独立存的一份，成员动了框不会自动跟着走 —— 只有"所有成员位移相同"才说明
 * 拖的是整个组（或框），这时才平移框；拖单个成员时位移不一致，框保持不动。
 */
export function translateGroupFrames<TGroup extends MembershipGroup>(
  groups: readonly TGroup[],
  nodes: readonly { id: string; x: number; y: number }[],
  origins: ReadonlyMap<string, { x: number; y: number }>,
): TGroup[] {
  if (!groups.length || !origins.size) return groups as TGroup[];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let changed = false;
  const next = groups.map((group) => {
    const frame = (group as { frame?: { x: number; y: number; width: number; height: number } })
      .frame;
    if (!frame) return group;
    let dx: number | null = null,
      dy: number | null = null,
      moved = true;
    for (const nodeId of group.nodeIds) {
      const origin = origins.get(nodeId),
        node = byId.get(nodeId);
      if (!origin || !node) {
        moved = false;
        break;
      }
      const deltaX = node.x - origin.x,
        deltaY = node.y - origin.y;
      if (dx === null) {
        dx = deltaX;
        dy = deltaY;
      } else if (Math.abs(deltaX - dx) > 0.5 || Math.abs(deltaY - (dy ?? 0)) > 0.5) {
        moved = false;
        break;
      }
    }
    if (!moved || dx === null || dy === null) return group;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return group;
    changed = true;
    return { ...group, frame: { ...frame, x: frame.x + dx, y: frame.y + dy } };
  });
  return changed ? next : (groups as TGroup[]);
}
