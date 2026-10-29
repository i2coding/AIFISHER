/**
 * 组的成员跟着位置走：拖进组框就加入，拖出去就离开。
 *
 * 只在一次拖动结束时结算一次，不在拖动过程中改数据 —— 拖动中改 nodeIds 会让
 * 组框每帧改变大小，手感会抖。
 *
 * 关键点：组框本身是由成员包围盒算出来的，所以不能拿"当前组框"判断成员是否离开
 * （拖一个成员走，框跟着走，永远出不去）。这里用两种依据：
 *  1. 拖动开始时冻结的组框（frozen）：节点的中心点跑出这个"拖之前"的框就算离开。
 *     这是主判据，符合"把节点拖出框外"的直觉。
 *  2. 没有冻结框时退化成"到组内其他节点的矩形距离"。
 * 保留 STAY 阈值是为了兼容整组平移等场景（成员之间相对位置不变，没人会掉出去）。
 */
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

/** 拖动开始时冻结的组框（画布坐标）。 */
export interface FrozenGroupFrame {
  groupId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 组只剩下一个成员时不再算组，直接解散。 */
const MIN_MEMBERS = 2;
/** 拖进来：和组内任一节点的矩形距离小于这个值就加入。 */
const JOIN_DISTANCE = 110;
/** 拖出去（没有冻结框时）：超过这个距离才离开，留出缓冲区避免手抖掉组。 */
const STAY_DISTANCE = 280;
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

function centerOf(rect: Rect) {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

/** 两个矩形的最近距离；相交或相邻时为 0。 */
function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.left - b.right, b.left - a.right),
    dy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
  return Math.hypot(dx, dy);
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
  frozen?: FrozenGroupFrame | null,
): { nodes: TNode[]; groups: TGroup[] } | null {
  if (!groups.length) return null;
  const groupIds = new Set(groups.map((group) => group.id));

  const rects = new Map<string, Rect>();
  const membersByGroup = new Map<string, TNode[]>();
  const boxesByGroup = new Map<string, Rect>();
  for (const node of nodes) {
    rects.set(node.id, rectOf(node, measure));
    if (!node.groupId || !groupIds.has(node.groupId)) continue;
    const list = membersByGroup.get(node.groupId) || [];
    list.push(node);
    membersByGroup.set(node.groupId, list);
  }
  for (const [groupId, members] of membersByGroup) {
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const member of members) {
      const rect = rects.get(member.id);
      if (!rect) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    if ([left, top, right, bottom].every(Number.isFinite))
      boxesByGroup.set(groupId, { left, top, right, bottom });
  }

  /** 某组的包围盒；excludeId 用于排除"正在被判定的这个节点自己"。 */
  const boxOfGroup = (groupId: string, excludeId?: string): Rect | null => {
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const member of membersByGroup.get(groupId) || []) {
      if (member.id === excludeId) continue;
      const rect = rects.get(member.id);
      if (!rect) continue;
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }
    if (![left, top, right, bottom].every(Number.isFinite)) return null;
    return { left, top, right, bottom };
  };

  const distanceToGroup = (node: TNode, groupId: string) => {
    const rect = rects.get(node.id);
    if (!rect) return Infinity;
    let nearest = Infinity;
    for (const member of membersByGroup.get(groupId) || []) {
      if (member.id === node.id) continue;
      const other = rects.get(member.id);
      if (!other) continue;
      nearest = Math.min(nearest, rectDistance(rect, other));
    }
    return nearest;
  };

  const nextGroupId = new Map<string, string | undefined>();
  for (const node of nodes) {
    const currentGroupId = node.groupId && groupIds.has(node.groupId) ? node.groupId : undefined;
    if (!currentGroupId) continue;
    const rect = rects.get(node.id);
    if (!rect) {
      nextGroupId.set(node.id, currentGroupId);
      continue;
    }
    if (frozen && frozen.groupId === currentGroupId) {
      // 主判据：中心点还在"拖动前那个框"里就算还在组内。
      const { x, y } = centerOf(rect);
      const inside =
        x >= frozen.left - EDGE_TOLERANCE &&
        x <= frozen.right + EDGE_TOLERANCE &&
        y >= frozen.top - EDGE_TOLERANCE &&
        y <= frozen.bottom + EDGE_TOLERANCE;
      nextGroupId.set(node.id, inside ? currentGroupId : undefined);
      continue;
    }
    const distance = distanceToGroup(node, currentGroupId);
    // 只有一个成员的组没有"其他成员"，交给解散逻辑处理，这里先留住。
    nextGroupId.set(node.id, distance <= STAY_DISTANCE ? currentGroupId : undefined);
  }

  // 已经离开（或本来就不在组里）的节点，看看有没有落进别的组。
  for (const node of nodes) {
    if (nextGroupId.get(node.id)) continue;
    const rect = rects.get(node.id);
    if (!rect) continue;
    const point = centerOf(rect);
    let picked: { id: string; distance: number } | null = null;
    for (const groupId of membersByGroup.keys()) {
      // 刚从这个组离开的节点，同一次手势里不再放回去（否则会原地打转、永远拖不出去）。
      if (groupId === node.groupId) continue;
      // 关键：算包围盒要排除节点自己，否则它自己撑大的框会把它重新吸回去。
      const box = boxOfGroup(groupId, node.id) ?? boxesByGroup.get(groupId);
      const inside = !!(
        box &&
        point.x >= box.left &&
        point.x <= box.right &&
        point.y >= box.top &&
        point.y <= box.bottom
      );
      const distance = distanceToGroup(node, groupId);
      if (!inside && distance > JOIN_DISTANCE) continue;
      if (!picked || distance < picked.distance) picked = { id: groupId, distance };
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
  if (!changed) return null;

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
  for (const group of groups) {
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
    groups: groupsChanged ? groupsNext : (groups as TGroup[]),
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
