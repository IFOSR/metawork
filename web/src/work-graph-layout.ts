import type { WorkGraphPresentationProjection } from './api/types';

type GraphNode = WorkGraphPresentationProjection['nodes'][number];

export const DAG_NODE_WIDTH = 244;
export const DAG_NODE_HEIGHT = 112;
const COLUMN_GAP = 96;
const ROW_GAP = 40;
const PADDING = 24;
const HEADER = 36;

/** Coordinates only: topology, phases and execution eligibility stay Server-owned. */
export function layoutWorkGraph(projection: WorkGraphPresentationProjection) {
  const phases = [...new Set(projection.nodes.map(node => node.phase))].sort((a, b) => a - b);
  const groups = phases.map(phase => projection.nodes.filter(node => node.phase === phase));
  const rows = Math.max(1, ...groups.map(group => group.length));
  const bodyHeight = rows * DAG_NODE_HEIGHT + (rows - 1) * ROW_GAP;
  const nodes = groups.flatMap((group, column) => {
    const groupHeight = group.length * DAG_NODE_HEIGHT + (group.length - 1) * ROW_GAP;
    return group.map((node, row) => ({
      node,
      x: PADDING + column * (DAG_NODE_WIDTH + COLUMN_GAP),
      y: PADDING + HEADER + (bodyHeight - groupHeight) / 2 + row * (DAG_NODE_HEIGHT + ROW_GAP),
    }));
  });
  const positions = new Map(nodes.map(position => [position.node.id, position]));
  const edges: Array<{ from: string; to: string; path: string; labels: string[] }> = [];
  let missingDependencies = 0;
  for (const target of nodes) {
    for (const from of new Set(target.node.dependencies)) {
      const source = positions.get(from);
      if (!source) { missingDependencies++; continue; }
      const x1 = source.x + DAG_NODE_WIDTH;
      const y1 = source.y + DAG_NODE_HEIGHT / 2;
      const x2 = target.x;
      const y2 = target.y + DAG_NODE_HEIGHT / 2;
      // Route long edges through the gutter above intervening layers, never
      // through their cards. Adjacent layers use a compact cubic curve.
      const path = x2 - x1 > COLUMN_GAP
        ? `M ${x1} ${y1} H ${x1 + 24} V ${PADDING + HEADER / 2} H ${x2 - 24} V ${y2} H ${x2}`
        : `M ${x1} ${y1} C ${x1 + COLUMN_GAP / 2} ${y1}, ${x2 - COLUMN_GAP / 2} ${y2}, ${x2} ${y2}`;
      edges.push({
        from,
        to: target.node.id,
        path,
        labels: projection.edges.filter(edge => edge.from === from && edge.to === target.node.id)
          .map(edge => edge.label),
      });
    }
  }
  return {
    nodes,
    edges,
    phases: phases.map((phase, column) => ({ phase, x: PADDING + column * (DAG_NODE_WIDTH + COLUMN_GAP) })),
    width: PADDING * 2 + Math.max(1, phases.length) * DAG_NODE_WIDTH + Math.max(0, phases.length - 1) * COLUMN_GAP,
    height: PADDING * 2 + HEADER + bodyHeight,
    missingDependencies,
  };
}

export function workGraphNodeLabel(node: GraphNode): string {
  return node.title || '未命名子任务';
}
