import type {
  ArchitectureEdge,
  ArchitectureEdgeMetrics,
  ArchitectureNode,
  ArchitectureNodeMetrics,
  NodeFlowSnapshot,
} from '@mshamed1/node-flow-protocol';

export const SNAPSHOT_VERSION = '1.0';

export type ChangeSeverity = 'info' | 'warning' | 'critical';

export interface StructuralChange<T> {
  id: string;
  before: T;
  after: T;
  severity: ChangeSeverity;
}

export type ArchitectureMetricName =
  | 'callCount'
  | 'errorCount'
  | 'avgDurationMs'
  | 'p50DurationMs'
  | 'p95DurationMs'
  | 'p99DurationMs';

export interface MetricDelta {
  metric: ArchitectureMetricName;
  before: number;
  after: number;
  absoluteChange: number;
  percentChange?: number;
}

export interface MetricChange<T> {
  id: string;
  before: T;
  after: T;
  changes: MetricDelta[];
  severity: ChangeSeverity;
}

export interface ArchitectureDiff {
  before: { nodes: number; edges: number };
  after: { nodes: number; edges: number };
  nodes: {
    added: Array<ArchitectureNode & { severity: ChangeSeverity }>;
    removed: Array<ArchitectureNode & { severity: ChangeSeverity }>;
    changed: StructuralChange<ArchitectureNode>[];
  };
  edges: {
    added: Array<ArchitectureEdge & { severity: ChangeSeverity }>;
    removed: Array<ArchitectureEdge & { severity: ChangeSeverity }>;
    changed: StructuralChange<ArchitectureEdge>[];
  };
  metrics: {
    nodes: MetricChange<ArchitectureNode>[];
    edges: MetricChange<ArchitectureEdge>[];
  };
  summary: {
    addedNodes: number;
    removedNodes: number;
    changedNodes: number;
    addedEdges: number;
    removedEdges: number;
    changedEdges: number;
  };
}

export interface MetricThreshold {
  absolute: number;
  percent: number;
}

export interface ComparisonThresholds {
  callCount: MetricThreshold;
  errorCount: MetricThreshold;
  avgDurationMs: MetricThreshold;
  p50DurationMs: MetricThreshold;
  p95DurationMs: MetricThreshold;
  p99DurationMs: MetricThreshold;
}

export const defaultComparisonThresholds: ComparisonThresholds = {
  callCount: { absolute: 10, percent: 10 },
  errorCount: { absolute: 1, percent: 10 },
  avgDurationMs: { absolute: 5, percent: 20 },
  p50DurationMs: { absolute: 5, percent: 20 },
  p95DurationMs: { absolute: 10, percent: 25 },
  p99DurationMs: { absolute: 10, percent: 25 },
};

export class SnapshotValidationError extends Error {
  constructor(
    message: string,
    readonly code: 'malformed' | 'unsupported-version',
  ) {
    super(message);
    this.name = 'SnapshotValidationError';
  }
}

export function serializeSnapshot(snapshot: NodeFlowSnapshot): string {
  validateSnapshot(snapshot);
  return `${JSON.stringify(normalizeSnapshot(snapshot), null, 2)}\n`;
}

export function deserializeSnapshot(value: string): NodeFlowSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new SnapshotValidationError(
      `Snapshot is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'malformed',
    );
  }
  validateSnapshot(parsed);
  return normalizeSnapshot(parsed);
}

export function validateSnapshot(value: unknown): asserts value is NodeFlowSnapshot {
  if (!isRecord(value)) throw malformed('Snapshot must be a JSON object.');
  if (typeof value.version !== 'string') throw malformed('Snapshot version must be a string.');
  if (value.version !== SNAPSHOT_VERSION) {
    throw new SnapshotValidationError(
      `Unsupported NodeFlow snapshot version "${value.version}". Supported version: ${SNAPSHOT_VERSION}.`,
      'unsupported-version',
    );
  }
  if (typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) {
    throw malformed('Snapshot generatedAt must be an ISO date string.');
  }
  if (!isRecord(value.application)) throw malformed('Snapshot application must be an object.');
  if (
    typeof value.application.runtime !== 'string' ||
    typeof value.application.nodeVersion !== 'string' ||
    (value.application.name !== undefined && typeof value.application.name !== 'string')
  ) {
    throw malformed('Snapshot application metadata is invalid.');
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw malformed('Snapshot nodes and edges must be arrays.');
  }

  const nodeIds = new Set<string>();
  for (const node of value.nodes) {
    validateNode(node);
    if (nodeIds.has(node.id)) throw malformed(`Duplicate node id "${node.id}".`);
    nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const edge of value.edges) {
    validateEdge(edge);
    if (edgeIds.has(edge.id)) throw malformed(`Duplicate edge id "${edge.id}".`);
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw malformed(`Edge "${edge.id}" references a node that does not exist.`);
    }
    edgeIds.add(edge.id);
  }

  if (value.paths !== undefined) {
    if (!Array.isArray(value.paths)) throw malformed('Snapshot paths must be an array.');
    const pathIds = new Set<string>();
    for (const path of value.paths) {
      if (
        !isRecord(path) ||
        typeof path.id !== 'string' ||
        typeof path.entrypoint !== 'string' ||
        !Array.isArray(path.nodes) ||
        !path.nodes.every((nodeId) => typeof nodeId === 'string' && nodeIds.has(nodeId)) ||
        !isNonNegativeNumber(path.calls) ||
        (path.avgDurationMs !== undefined && !isNonNegativeNumber(path.avgDurationMs)) ||
        (path.p95DurationMs !== undefined && !isNonNegativeNumber(path.p95DurationMs)) ||
        (path.errors !== undefined && !isNonNegativeNumber(path.errors))
      ) {
        throw malformed('Snapshot contains an invalid runtime path.');
      }
      if (pathIds.has(path.id)) throw malformed(`Duplicate runtime path id "${path.id}".`);
      pathIds.add(path.id);
    }
  }
  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    throw malformed('Snapshot metadata must be an object.');
  }
}

export function compareSnapshots(
  before: NodeFlowSnapshot,
  after: NodeFlowSnapshot,
  thresholds: ComparisonThresholds = defaultComparisonThresholds,
): ArchitectureDiff {
  validateSnapshot(before);
  validateSnapshot(after);

  const beforeNodes = indexById(before.nodes);
  const afterNodes = indexById(after.nodes);
  const beforeEdges = indexById(before.edges);
  const afterEdges = indexById(after.edges);

  const addedNodes = after.nodes
    .filter((node) => !beforeNodes.has(node.id))
    .map((node) => ({ ...node, severity: severityForAddedNode(node) }));
  const removedNodes = before.nodes
    .filter((node) => !afterNodes.has(node.id))
    .map((node) => ({ ...node, severity: 'info' as const }));
  const changedNodes = structuralChanges(beforeNodes, afterNodes, sameNodeStructure);
  const addedEdges = after.edges
    .filter((edge) => !beforeEdges.has(edge.id))
    .map((edge) => ({ ...edge, severity: severityForAddedEdge(edge, afterNodes) }));
  const removedEdges = before.edges
    .filter((edge) => !afterEdges.has(edge.id))
    .map((edge) => ({ ...edge, severity: 'info' as const }));
  const changedEdges = structuralChanges(beforeEdges, afterEdges, sameEdgeStructure);
  const nodeMetrics = metricChanges(beforeNodes, afterNodes, thresholds);
  const edgeMetrics = metricChanges(beforeEdges, afterEdges, thresholds);

  return {
    before: { nodes: before.nodes.length, edges: before.edges.length },
    after: { nodes: after.nodes.length, edges: after.edges.length },
    nodes: {
      added: addedNodes.sort(byId),
      removed: removedNodes.sort(byId),
      changed: changedNodes,
    },
    edges: {
      added: addedEdges.sort(byId),
      removed: removedEdges.sort(byId),
      changed: changedEdges,
    },
    metrics: { nodes: nodeMetrics, edges: edgeMetrics },
    summary: {
      addedNodes: addedNodes.length,
      removedNodes: removedNodes.length,
      changedNodes: changedNodes.length,
      addedEdges: addedEdges.length,
      removedEdges: removedEdges.length,
      changedEdges: changedEdges.length + edgeMetrics.length,
    },
  };
}

function normalizeSnapshot(snapshot: NodeFlowSnapshot): NodeFlowSnapshot {
  return {
    ...snapshot,
    nodes: [...snapshot.nodes].sort(byId),
    edges: [...snapshot.edges].sort(byId),
    ...(snapshot.paths ? { paths: [...snapshot.paths].sort(byId) } : {}),
  };
}

function validateNode(value: unknown): asserts value is ArchitectureNode {
  const types = new Set([
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
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.name !== 'string' ||
    !types.has(String(value.type)) ||
    (value.framework !== undefined && typeof value.framework !== 'string')
  ) {
    throw malformed('Snapshot contains an invalid architecture node.');
  }
  validateMetrics(value.metrics, [
    'callCount',
    'errorCount',
    'avgDurationMs',
    'p50DurationMs',
    'p95DurationMs',
    'p99DurationMs',
  ]);
}

function validateEdge(value: unknown): asserts value is ArchitectureEdge {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    typeof value.source !== 'string' ||
    typeof value.target !== 'string' ||
    (value.type !== undefined && typeof value.type !== 'string')
  ) {
    throw malformed('Snapshot contains an invalid architecture edge.');
  }
  validateMetrics(value.metrics, ['callCount', 'errorCount', 'avgDurationMs', 'p95DurationMs']);
}

function validateMetrics(value: unknown, keys: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw malformed('Snapshot metrics must be an object.');
  for (const key of keys) {
    if (value[key] !== undefined && !isNonNegativeNumber(value[key])) {
      throw malformed(`Snapshot metric "${key}" must be a non-negative number.`);
    }
  }
}

function structuralChanges<T extends { id: string }>(
  before: Map<string, T>,
  after: Map<string, T>,
  isSame: (left: T, right: T) => boolean,
): StructuralChange<T>[] {
  const changes: StructuralChange<T>[] = [];
  for (const [id, left] of before) {
    const right = after.get(id);
    if (right && !isSame(left, right)) {
      changes.push({ id, before: left, after: right, severity: 'info' });
    }
  }
  return changes.sort(byId);
}

function metricChanges<T extends ArchitectureNode | ArchitectureEdge>(
  before: Map<string, T>,
  after: Map<string, T>,
  thresholds: ComparisonThresholds,
): MetricChange<T>[] {
  const changes: MetricChange<T>[] = [];
  for (const [id, left] of before) {
    const right = after.get(id);
    if (!right) continue;
    const deltas = compareMetrics(left.metrics, right.metrics, thresholds);
    if (deltas.length === 0) continue;
    const warning = deltas.some(
      (delta) =>
        delta.after > delta.before &&
        (delta.metric === 'avgDurationMs' ||
          delta.metric === 'p95DurationMs' ||
          delta.metric === 'p99DurationMs'),
    );
    changes.push({
      id,
      before: left,
      after: right,
      changes: deltas,
      severity: warning ? 'warning' : 'info',
    });
  }
  return changes.sort(byId);
}

function compareMetrics(
  before: ArchitectureNodeMetrics | ArchitectureEdgeMetrics | undefined,
  after: ArchitectureNodeMetrics | ArchitectureEdgeMetrics | undefined,
  thresholds: ComparisonThresholds,
): MetricDelta[] {
  const keys = Object.keys(thresholds) as ArchitectureMetricName[];
  return keys.flatMap((metric) => {
    const left = before?.[metric as keyof typeof before];
    const right = after?.[metric as keyof typeof after];
    if (typeof left !== 'number' || typeof right !== 'number' || left === right) return [];
    const absoluteChange = right - left;
    const percentChange = left === 0 ? undefined : (absoluteChange / left) * 100;
    const threshold = thresholds[metric];
    const meaningfulPercent =
      percentChange === undefined ? right > 0 : Math.abs(percentChange) >= threshold.percent;
    if (Math.abs(absoluteChange) < threshold.absolute || !meaningfulPercent) return [];
    return [{ metric, before: left, after: right, absoluteChange, percentChange }];
  });
}

function sameNodeStructure(left: ArchitectureNode, right: ArchitectureNode): boolean {
  return left.name === right.name && left.type === right.type && left.framework === right.framework;
}

function sameEdgeStructure(left: ArchitectureEdge, right: ArchitectureEdge): boolean {
  return left.source === right.source && left.target === right.target && left.type === right.type;
}

function severityForAddedNode(node: ArchitectureNode): ChangeSeverity {
  return node.type === 'external-service' ? 'warning' : 'info';
}

function severityForAddedEdge(
  edge: ArchitectureEdge,
  nodes: Map<string, ArchitectureNode>,
): ChangeSeverity {
  return nodes.get(edge.target)?.type === 'external-service' ? 'warning' : 'info';
}

function indexById<T extends { id: string }>(values: T[]): Map<string, T> {
  return new Map(values.map((value) => [value.id, value]));
}

function byId<T extends { id: string }>(left: T, right: T): number {
  return left.id.localeCompare(right.id);
}

function malformed(message: string): SnapshotValidationError {
  return new SnapshotValidationError(message, 'malformed');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
