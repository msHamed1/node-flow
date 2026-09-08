import type {
  ArchitectureEdge,
  ArchitectureNode,
  ArchitectureNodeType,
  NodeFlowSnapshot,
  RuntimePath,
  TopologyEdge,
  TopologyNode,
  TopologyNodeType,
  TopologySnapshot,
} from '@mshamed1/node-flow-protocol';

export type GraphPerspective = 'architecture' | 'traffic' | 'latency' | 'errors';
export type PathDisplayMode = 'dim' | 'hide';
export type DiffStatus = 'added' | 'removed' | 'changed';
export type ArchitectureLayer = 'entrypoints' | 'application' | 'services' | 'infrastructure';

export interface NodePosition {
  x: number;
  y: number;
  layer: ArchitectureLayer;
}

export interface ArchitectureSummary {
  components: number;
  dependencies: number;
  entrypoints: number;
  runtimePaths: number;
  databases: number;
  caches: number;
  queues: number;
  externalServices: number;
}

export interface DependencyRow {
  edge: TopologyEdge;
  node: TopologyNode;
  percentage?: number;
}

export interface RuntimePathGroup {
  entrypoint: string;
  calls: number;
  avgDurationMs?: number;
  p95DurationMs?: number;
  errors?: number;
  nodeIds: string[];
  edgeKeys: string[];
  externalSystems: TopologyNode[];
}

export interface ArchitectureInsight {
  id: string;
  kind: 'external' | 'fanout' | 'latency' | 'runtime';
  title: string;
  detail: string;
}

export interface SnapshotComparison {
  snapshot: TopologySnapshot;
  nodeStatuses: Map<string, DiffStatus>;
  edgeStatuses: Map<string, DiffStatus>;
  insights: ArchitectureInsight[];
}

const layerOrder: ArchitectureLayer[] = [
  'entrypoints',
  'application',
  'services',
  'infrastructure',
];

export function topologyStructureKey(snapshot: TopologySnapshot): string {
  return `${snapshot.nodes
    .map((node) => node.id)
    .sort()
    .join('|')}::${snapshot.edges
    .map((edge) => `${edge.source}>${edge.target}`)
    .sort()
    .join('|')}`;
}

export function layoutArchitecture(snapshot: TopologySnapshot): Map<string, NodePosition> {
  const byLayer = new Map<ArchitectureLayer, TopologyNode[]>(
    layerOrder.map((layer) => [layer, []]),
  );
  for (const node of snapshot.nodes) byLayer.get(layerForNode(node))?.push(node);

  const positions = new Map<string, NodePosition>();
  for (const [layerIndex, layer] of layerOrder.entries()) {
    const nodes = byLayer.get(layer) ?? [];
    nodes.sort((left, right) => left.name.localeCompare(right.name));
    const columns = Math.max(1, Math.ceil(Math.sqrt(nodes.length * 1.8)));
    const width = Math.min(columns, nodes.length) * 268;
    nodes.forEach((node, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      positions.set(node.id, {
        x: column * 268 - width / 2 + 134,
        y: layerIndex * 190 + row * 104,
        layer,
      });
    });
  }
  return positions;
}

export function layerForNode(node: Pick<TopologyNode, 'type'>): ArchitectureLayer {
  switch (node.type) {
    case 'http-route':
    case 'worker':
      return 'entrypoints';
    case 'controller':
      return 'application';
    case 'service':
      return 'services';
    case 'database':
    case 'redis':
    case 'queue':
    case 'external-http':
      return 'infrastructure';
  }
}

export function architectureSummary(snapshot: TopologySnapshot): ArchitectureSummary {
  return {
    components: snapshot.nodes.length,
    dependencies: snapshot.edges.length,
    entrypoints: snapshot.nodes.filter(
      (node) => node.type === 'http-route' || node.type === 'worker',
    ).length,
    runtimePaths: new Set((snapshot.paths ?? []).map((path) => path.entrypoint)).size,
    databases: snapshot.nodes.filter((node) => node.type === 'database').length,
    caches: snapshot.nodes.filter((node) => node.type === 'redis').length,
    queues: snapshot.nodes.filter((node) => node.type === 'queue').length,
    externalServices: snapshot.nodes.filter((node) => node.type === 'external-http').length,
  };
}

export function dependencyRows(
  nodeId: string,
  direction: 'inbound' | 'outbound',
  snapshot: TopologySnapshot,
): DependencyRow[] {
  const edges = snapshot.edges.filter((edge) =>
    direction === 'inbound' ? edge.target === nodeId : edge.source === nodeId,
  );
  const total = edges.reduce((sum, edge) => sum + edge.requestCount, 0);
  return edges
    .map((edge) => {
      const dependencyId = direction === 'inbound' ? edge.source : edge.target;
      const node = snapshot.nodes.find((candidate) => candidate.id === dependencyId);
      return node
        ? {
            edge,
            node,
            ...(total > 0 ? { percentage: (edge.requestCount / total) * 100 } : {}),
          }
        : undefined;
    })
    .filter((row): row is DependencyRow => Boolean(row))
    .sort(
      (left, right) =>
        (right.percentage ?? -1) - (left.percentage ?? -1) ||
        left.node.name.localeCompare(right.node.name),
    );
}

export function groupRuntimePaths(snapshot: TopologySnapshot): RuntimePathGroup[] {
  const grouped = new Map<string, RuntimePath[]>();
  for (const path of snapshot.paths ?? []) {
    grouped.set(path.entrypoint, [...(grouped.get(path.entrypoint) ?? []), path]);
  }
  return [...grouped.entries()]
    .map(([entrypoint, paths]) => {
      const representative = [...paths].sort((left, right) => right.calls - left.calls)[0];
      const nodeIds = [...new Set(paths.flatMap((path) => path.nodes))];
      const edgeKeys = [
        ...new Set(
          paths.flatMap((path) =>
            path.nodes.slice(1).map((nodeId, index) => `${path.nodes[index]}->${nodeId}`),
          ),
        ),
      ];
      return {
        entrypoint,
        calls: representative?.calls ?? 0,
        ...(representative?.avgDurationMs !== undefined
          ? { avgDurationMs: representative.avgDurationMs }
          : {}),
        ...(representative?.p95DurationMs !== undefined
          ? { p95DurationMs: representative.p95DurationMs }
          : {}),
        ...(representative?.errors !== undefined ? { errors: representative.errors } : {}),
        nodeIds,
        edgeKeys,
        externalSystems: snapshot.nodes.filter(
          (node) =>
            nodeIds.includes(node.id) &&
            ['database', 'redis', 'queue', 'external-http'].includes(node.type),
        ),
      };
    })
    .sort(
      (left, right) => right.calls - left.calls || left.entrypoint.localeCompare(right.entrypoint),
    );
}

export function searchArchitecture(snapshot: TopologySnapshot, query: string): TopologyNode[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return snapshot.nodes
    .filter((node) => {
      const searchable = [node.name, node.type, node.operation, labelForSearch(node.type)]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    })
    .sort(
      (left, right) =>
        Number(!left.name.toLocaleLowerCase().startsWith(terms[0] ?? '')) -
          Number(!right.name.toLocaleLowerCase().startsWith(terms[0] ?? '')) ||
        left.name.localeCompare(right.name),
    )
    .slice(0, 12);
}

export function liveInsights(snapshot: TopologySnapshot): ArchitectureInsight[] {
  const insights: ArchitectureInsight[] = [];
  for (const node of snapshot.nodes) {
    const outbound = snapshot.edges.filter((edge) => edge.source === node.id);
    if (outbound.length >= 5) {
      insights.push({
        id: `fanout:${node.id}`,
        kind: 'fanout',
        title: 'High fan-out',
        detail: `${node.name} has ${outbound.length} outbound runtime dependencies.`,
      });
    }
  }
  return insights.slice(0, 5);
}

export function comparisonFromSnapshots(
  before: NodeFlowSnapshot,
  after: NodeFlowSnapshot,
): SnapshotComparison {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  const nodeStatuses = new Map<string, DiffStatus>();
  const edgeStatuses = new Map<string, DiffStatus>();
  const mergedNodes = [...after.nodes];
  const mergedEdges = [...after.edges];

  for (const node of after.nodes) {
    const previous = beforeNodes.get(node.id);
    if (!previous) nodeStatuses.set(node.id, 'added');
    else if (!sameArchitectureNode(previous, node)) nodeStatuses.set(node.id, 'changed');
  }
  for (const node of before.nodes) {
    if (!afterNodes.has(node.id)) {
      nodeStatuses.set(node.id, 'removed');
      mergedNodes.push(node);
    }
  }
  for (const edge of after.edges) {
    const previous = beforeEdges.get(edge.id);
    if (!previous) edgeStatuses.set(edge.id, 'added');
    else if (!sameArchitectureEdge(previous, edge)) edgeStatuses.set(edge.id, 'changed');
  }
  for (const edge of before.edges) {
    if (!afterEdges.has(edge.id)) {
      edgeStatuses.set(edge.id, 'removed');
      mergedEdges.push(edge);
    }
  }

  return {
    snapshot: architectureToTopology({ ...after, nodes: mergedNodes, edges: mergedEdges }),
    nodeStatuses,
    edgeStatuses,
    insights: comparisonInsights(before, after),
  };
}

export function architectureToTopology(snapshot: NodeFlowSnapshot): TopologySnapshot {
  return {
    revision: 0,
    generatedAt: Date.parse(snapshot.generatedAt),
    nodes: snapshot.nodes.map(toTopologyNode),
    edges: snapshot.edges.map(toTopologyEdge),
    paths: snapshot.paths ?? [],
    traces: [],
    activity: { nodeIds: [], edgeIds: [] },
  };
}

export function validateSnapshotShape(value: unknown): value is NodeFlowSnapshot {
  if (!isRecord(value) || value.version !== '1.0') return false;
  if (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) {
    return false;
  }
  if (
    !isRecord(value.application) ||
    typeof value.application.runtime !== 'string' ||
    typeof value.application.nodeVersion !== 'string' ||
    !Array.isArray(value.nodes) ||
    !Array.isArray(value.edges)
  ) {
    return false;
  }
  const allowedTypes = new Set<ArchitectureNodeType>([
    'controller',
    'service',
    'provider',
    'database',
    'cache',
    'queue',
    'external-service',
    'http',
    'unknown',
  ]);
  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    if (
      !isRecord(node) ||
      typeof node.id !== 'string' ||
      !node.id ||
      typeof node.name !== 'string' ||
      !allowedTypes.has(node.type as ArchitectureNodeType) ||
      !validMetrics(node.metrics)
    ) {
      return false;
    }
    nodeIds.add(node.id);
  }
  if (nodeIds.size !== value.nodes.length) return false;

  const edgeIds = new Set<string>();
  for (const edge of value.edges) {
    if (
      !isRecord(edge) ||
      typeof edge.id !== 'string' ||
      !edge.id ||
      typeof edge.source !== 'string' ||
      typeof edge.target !== 'string' ||
      !nodeIds.has(edge.source) ||
      !nodeIds.has(edge.target) ||
      !validMetrics(edge.metrics)
    ) {
      return false;
    }
    edgeIds.add(edge.id);
  }
  return edgeIds.size === value.edges.length;
}

export function edgeVisualWeight(
  edges: TopologyEdge[],
  edge: TopologyEdge,
  metric: GraphPerspective,
): number {
  const value = edgeMetric(edge, metric);
  const maximum = Math.max(0, ...edges.map((candidate) => edgeMetric(candidate, metric)));
  if (metric === 'architecture' || maximum === 0) return 1.5;
  const normalized = Math.log1p(value) / Math.log1p(maximum);
  return 1.5 + normalized * 2.5;
}

function edgeMetric(edge: TopologyEdge, perspective: GraphPerspective): number {
  if (perspective === 'traffic') return edge.requestCount;
  if (perspective === 'latency') return edge.p95LatencyMs;
  if (perspective === 'errors') return edge.errorCount;
  return 0;
}

function comparisonInsights(
  before: NodeFlowSnapshot,
  after: NodeFlowSnapshot,
): ArchitectureInsight[] {
  const insights: ArchitectureInsight[] = [];
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));

  for (const edge of after.edges) {
    if (beforeEdges.has(edge.id)) continue;
    const target = afterNodes.get(edge.target);
    const source = afterNodes.get(edge.source);
    if (target?.type === 'external-service' && source) {
      insights.push({
        id: `external:${edge.id}`,
        kind: 'external',
        title: 'New external dependency',
        detail: `${source.name} now communicates with ${target.name}.`,
      });
    }
  }
  for (const edge of after.edges) {
    const previous = beforeEdges.get(edge.id);
    const oldP95 = previous?.metrics?.p95DurationMs;
    const newP95 = edge.metrics?.p95DurationMs;
    if (
      oldP95 !== undefined &&
      newP95 !== undefined &&
      newP95 - oldP95 >= 10 &&
      (oldP95 === 0 || ((newP95 - oldP95) / oldP95) * 100 >= 25)
    ) {
      const source = afterNodes.get(edge.source)?.name ?? edge.source;
      const target = afterNodes.get(edge.target)?.name ?? edge.target;
      insights.push({
        id: `latency:${edge.id}`,
        kind: 'latency',
        title: 'Latency change',
        detail: `${source} → ${target} p95 increased from ${formatMetric(oldP95)} ms to ${formatMetric(newP95)} ms.`,
      });
    }
  }
  for (const node of before.nodes) {
    if (!afterNodes.has(node.id)) {
      insights.push({
        id: `runtime:${node.id}`,
        kind: 'runtime',
        title: 'Unused in this runtime',
        detail: `${node.name} appeared previously but not in the current runtime architecture.`,
      });
    }
  }
  return [...insights, ...liveInsights(architectureToTopology(after))].slice(0, 8);
}

function toTopologyNode(node: ArchitectureNode): TopologyNode {
  const metrics = node.metrics;
  const requestCount = metrics?.callCount ?? 0;
  const errorCount = metrics?.errorCount ?? 0;
  return {
    id: node.id,
    name: node.name,
    type: architectureTypeToTopology(node.type),
    ...(node.framework ? { framework: node.framework } : {}),
    requestCount,
    errorCount,
    errorRate: requestCount ? (errorCount / requestCount) * 100 : 0,
    avgLatencyMs: metrics?.avgDurationMs ?? 0,
    ...(metrics?.p50DurationMs !== undefined ? { p50LatencyMs: metrics.p50DurationMs } : {}),
    p95LatencyMs: metrics?.p95DurationMs ?? 0,
    ...(metrics?.p99DurationMs !== undefined ? { p99LatencyMs: metrics.p99DurationMs } : {}),
  };
}

function toTopologyEdge(edge: ArchitectureEdge): TopologyEdge {
  const metrics = edge.metrics;
  const requestCount = metrics?.callCount ?? 0;
  const errorCount = metrics?.errorCount ?? 0;
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    requestCount,
    errorCount,
    errorRate: requestCount ? (errorCount / requestCount) * 100 : 0,
    avgLatencyMs: metrics?.avgDurationMs ?? 0,
    p95LatencyMs: metrics?.p95DurationMs ?? 0,
  };
}

function architectureTypeToTopology(type: ArchitectureNodeType): TopologyNodeType {
  return {
    controller: 'controller',
    service: 'service',
    provider: 'service',
    database: 'database',
    cache: 'redis',
    queue: 'queue',
    'external-service': 'external-http',
    http: 'http-route',
    unknown: 'service',
  }[type] as TopologyNodeType;
}

function sameArchitectureNode(left: ArchitectureNode, right: ArchitectureNode): boolean {
  return (
    left.name === right.name &&
    left.type === right.type &&
    left.framework === right.framework &&
    JSON.stringify(left.metrics ?? {}) === JSON.stringify(right.metrics ?? {})
  );
}

function sameArchitectureEdge(left: ArchitectureEdge, right: ArchitectureEdge): boolean {
  return (
    left.source === right.source &&
    left.target === right.target &&
    left.type === right.type &&
    JSON.stringify(left.metrics ?? {}) === JSON.stringify(right.metrics ?? {})
  );
}

function labelForSearch(type: TopologyNodeType): string {
  return {
    'http-route': 'entrypoint endpoint route',
    controller: 'application controller',
    service: 'service provider',
    database: 'database infrastructure',
    redis: 'cache infrastructure',
    queue: 'queue infrastructure',
    worker: 'worker entrypoint',
    'external-http': 'external service api infrastructure',
  }[type];
}

function formatMetric(value: number): string {
  return value < 10 ? value.toFixed(1) : Math.round(value).toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validMetrics(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    Object.values(value).every(
      (metric) => typeof metric === 'number' && Number.isFinite(metric) && metric >= 0,
    )
  );
}
