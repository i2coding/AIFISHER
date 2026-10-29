/**
 * 整束搬移的落位：直接改 parentIds，不经过 connectCanvasNodes 的一堆前置校验
 * （那个函数在「类型不兼容 / 容量不足 / 槽位被占」时会静默返回原数组，
 *  表现就是"明明松手了却没接上"）。
 *
 * 两个方向必须分开处理，这是语义问题不是实现细节：
 *  - 抓**输出口**（side='right'）：这一束线的"来源"换人 → 落点节点成为新的上游。
 *  - 抓**输入口**（side='left'）：这一束线的"去向"换人 → 落点节点成为新的下游。
 * 两种都当成"换上游"的话，抓输入口就会变成 B→A，看着像绕回原点。
 */

interface BundleNode {
  id: string;
  type?: string;
  parentIds?: string[];
  sourcePortIndices?: number[];
  imageMode?: string;
  [key: string]: unknown;
}

export interface BundleItem {
  parentId: string;
  childId: string;
  portIndex: number;
  sourcePortIndex: number;
}

/** 往子节点的 parentIds 里补一条上游：ComfyUI 找空槽，普通节点追加。 */
function attachParent<TNode extends BundleNode>(
  node: TNode,
  parentId: string,
  sourcePort: number,
  capacityHint: number,
): TNode | null {
  const parents = [...(node.parentIds ?? [])];
  const ports = [...(node.sourcePortIndices ?? [])];
  while (ports.length < parents.length) ports.push(0);
  if (node.type === 'ComfyUI') {
    const capacity = Math.max(parents.length, capacityHint);
    while (parents.length < capacity) parents.push('');
    while (ports.length < capacity) ports.push(0);
    const slot = parents.findIndex((id) => !id);
    if (slot < 0) return null;
    parents[slot] = parentId;
    ports[slot] = sourcePort;
  } else {
    if (parents.includes(parentId)) return null;
    parents.push(parentId);
    ports.push(sourcePort);
  }
  return { ...node, parentIds: parents, sourcePortIndices: ports };
}

/**
 * - side='right'：每条 item 的 childId 换掉上游 → target 成为这些 child 的新上游。
 * - side='left'：每条 item 的 parentId 换掉去向 → target 成为这些上游的新下游。
 */
export function reattachBundle<TNode extends BundleNode>(
  nodes: readonly TNode[],
  items: readonly BundleItem[],
  snapshots: ReadonlyMap<string, TNode>,
  targetId: string,
  side: 'left' | 'right',
): TNode[] {
  if (!items.length) return nodes as TNode[];
  const ordered = [...items].sort((a, b) => a.portIndex - b.portIndex);

  if (side === 'left') {
    // 下游换人：落点节点接管这一束上游。
    return nodes.map((node) => {
      if (node.id !== targetId) return node;
      let current = node;
      const capacityHint = current.parentIds?.length ?? 0;
      for (const item of ordered) {
        if (item.parentId === targetId) continue;
        const attached = attachParent(current, item.parentId, item.sourcePortIndex, capacityHint);
        if (!attached) break;
        current = attached;
      }
      return current;
    });
  }

  let next = nodes as TNode[];
  for (const item of ordered) {
    const snapshot = snapshots.get(item.childId);
    next = next.map((node) => {
      if (node.id !== item.childId) return node;
      if (node.type === 'ComfyUI') {
        const parents = [...(node.parentIds ?? [])];
        const ports = [...(node.sourcePortIndices ?? [])];
        while (ports.length < parents.length) ports.push(0);
        const capacity = Math.max(parents.length, snapshot?.parentIds?.length ?? 0);
        while (parents.length < capacity) parents.push('');
        while (ports.length < capacity) ports.push(0);
        const slot =
          item.portIndex >= 0 && item.portIndex < capacity
            ? item.portIndex
            : parents.findIndex((id) => !id);
        if (slot < 0) return node;
        parents[slot] = targetId;
        ports[slot] = 0;
        return { ...node, parentIds: parents, sourcePortIndices: ports };
      }
      const keptParents: string[] = [];
      const keptPorts: number[] = [];
      (node.parentIds ?? []).forEach((id, index) => {
        // 去掉被换掉的原上游，以及可能已存在的目标，避免重复或残留。
        if (id === targetId || id === item.parentId) return;
        keptParents.push(id);
        keptPorts.push((node.sourcePortIndices ?? [])[index] ?? 0);
      });
      const index = Math.min(Math.max(item.portIndex, 0), keptParents.length);
      keptParents.splice(index, 0, targetId);
      keptPorts.splice(index, 0, 0);
      return {
        ...node,
        parentIds: keptParents,
        sourcePortIndices: keptPorts,
        // 断开时 Image 节点可能被改成 text-to-image，接回来要还原成原来的模式。
        ...(snapshot?.imageMode ? { imageMode: snapshot.imageMode } : {}),
      };
    });
  }
  return next;
}
