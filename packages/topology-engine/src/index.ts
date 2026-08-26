import type {
  ArchitectureNode,
  MetricSummary,
  NodeFlowSnapshot,
  RecentTrace,
  RuntimePath,
  RuntimeMetrics,
  TelemetrySpan,
  TopologyEdge,
  TopologyNode,
  TopologyNodeType,
  TopologySnapshot,
  TraceSpan,
} from '@mshamed1/node-flow-protocol';
import { SNAPSHOT_VERSION } from './snapshot.js';

interface MetricAccumulator {
  count: number;
  errors: number;
  totalLatencyMs: number;
  latencies: number[];
}

interface NodeState {
  id: string;
  name: string;
  type: TopologyNodeType;
  framework?: string;
  operation?: string;
  metrics: MetricAccumulator;
}

interface RuntimePathState {
  id: string;
  entrypoint: string;
  nodes: string[];
  metrics: MetricAccumulator;
  lastUpdatedAt: number;
}

interface EdgeState {
  id: string;
  source: string;
  target: string;
  metrics: MetricAccumulator;
}

interface TraceState {
  traceId: string;
  spans: Map<string, TelemetrySpan>;
  lastUpdatedAt: number;
  pathContributions: Map<string, { durationMs: number; failed: boolean }>;
}

export interface TopologyEngineOptions {
  maxRecentTraces?: number;
  maxLatencySamples?: number;
  maxRuntimePaths?: number;
  applicationName?: string;
  nodeVersion?: string;
}

const topologyKinds = new Set<TopologyNodeType>([
  'http-route',
  'controller',
  'service',
  'database',
  'redis',
  'queue',
  'worker',
  'external-http',
]);

const traceKinds = new Set([...topologyKinds, 'custom']);

export class TopologyEngine {
  private readonly nodes = new Map<string, NodeState>();
  private readonly edges = new Map<string, EdgeState>();
  private readonly paths = new Map<string, RuntimePathState>();
  private readonly traces = new Map<string, TraceState>();
  private readonly seenSpanIds = new Set<string>();
  private readonly seenEdgeSpanIds = new Set<string>();
  private readonly maxRecentTraces: number;
  private readonly maxLatencySamples: number;
  private readonly maxRuntimePaths: number;
  private readonly applicationNames = new Set<string>();
  private nodeVersion: string;
  private runtime?: RuntimeMetrics;
  private revision = 0;
  private traceClock = 0;
  private activity = { nodeIds: [] as string[], edgeIds: [] as string[] };

  constructor(options: TopologyEngineOptions = {}) {
    this.maxRecentTraces = options.maxRecentTraces ?? 50;
    this.maxLatencySamples = options.maxLatencySamples ?? 1_000;
    this.maxRuntimePaths = options.maxRuntimePaths ?? 1_000;
    this.nodeVersion = options.nodeVersion ?? process.version;
    if (options.applicationName) this.applicationNames.add(options.applicationName);
  }

  registerApplication(name: string, nodeVersion?: string): void {
    if (name.trim()) this.applicationNames.add(name.trim());
    if (nodeVersion?.trim()) this.nodeVersion = nodeVersion.trim();
  }

  ingest(spans: TelemetrySpan[]): TopologySnapshot {
    const activeNodeIds = new Set<string>();
    const activeEdgeIds = new Set<string>();

    for (const span of spans) {
      if (this.seenSpanIds.has(span.spanId)) continue;
      this.seenSpanIds.add(span.spanId);

      const trace = this.traces.get(span.traceId) ?? {
        traceId: span.traceId,
        spans: new Map<string, TelemetrySpan>(),
        lastUpdatedAt: 0,
        pathContributions: new Map(),
      };
      trace.spans.set(span.spanId, span);
      trace.lastUpdatedAt = ++this.traceClock;
      this.traces.set(span.traceId, trace);

      const node = this.resolveNode(span);
      if (node) {
        this.record(node.metrics, span.durationMs, span.status === 'error');
        activeNodeIds.add(node.id);
      }
    }

    // Re-evaluate every trace touched by this batch. Child spans often export
    // before parents, so edge creation cannot depend on arrival order.
    const touchedTraceIds = new Set(spans.map((span) => span.traceId));
    for (const traceId of touchedTraceIds) {
      const trace = this.traces.get(traceId);
      if (!trace) continue;
      for (const child of trace.spans.values()) {
        if (!child.parentSpanId) continue;
        const edgeSpanKey = `${child.traceId}:${child.spanId}`;
        if (this.seenEdgeSpanIds.has(edgeSpanKey)) continue;
        const parentNode = this.findNearestParentNode(trace, child.parentSpanId);
        const childNode = this.resolveNode(child, false);
        if (!parentNode || !childNode || parentNode.id === childNode.id) continue;
        const edgeId = createStableEdgeId(parentNode.id, childNode.id);
        const edge: EdgeState = this.edges.get(edgeId) ?? {
          id: edgeId,
          source: parentNode.id,
          target: childNode.id,
          metrics: emptyMetrics(),
        };
        this.edges.set(edgeId, edge);
        this.record(edge.metrics, child.durationMs, child.status === 'error');
        this.seenEdgeSpanIds.add(edgeSpanKey);
        activeEdgeIds.add(edgeId);
      }
    }

    for (const traceId of touchedTraceIds) {
      const trace = this.traces.get(traceId);
      if (trace) this.aggregateRuntimePaths(trace);
    }

    this.trimTraces();
    this.revision += 1;
    this.activity = { nodeIds: [...activeNodeIds], edgeIds: [...activeEdgeIds] };
    return this.snapshot();
  }

  updateRuntime(metrics: RuntimeMetrics): TopologySnapshot {
    this.runtime = metrics;
    this.revision += 1;
    this.activity = { nodeIds: [], edgeIds: [] };
    return this.snapshot();
  }

  snapshot(): TopologySnapshot {
    return {
      revision: this.revision,
      generatedAt: Date.now(),
      nodes: [...this.nodes.values()].map(toNode).sort((a, b) => a.name.localeCompare(b.name)),
      edges: [...this.edges.values()].map(toEdge).sort((a, b) => a.id.localeCompare(b.id)),
      paths: this.buildRuntimePaths(),
      traces: this.buildRecentTraces(),
      runtime: this.runtime,
      activity: this.activity,
    };
  }

  createSnapshot(): NodeFlowSnapshot {
    const applicationNames = [...this.applicationNames].sort();
    return {
      version: SNAPSHOT_VERSION,
      generatedAt: new Date().toISOString(),
      application: {
        ...(applicationNames[0] ? { name: applicationNames[0] } : {}),
        runtime: 'nodejs',
        nodeVersion: this.nodeVersion,
      },
      nodes: [...this.nodes.values()]
        .map(toArchitectureNode)
        .sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...this.edges.values()]
        .map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'runtime-dependency',
          metrics: toArchitectureEdgeMetrics(edge.metrics),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      paths: this.buildRuntimePaths(),
      ...(applicationNames.length > 1 ? { metadata: { serviceNames: applicationNames } } : {}),
    };
  }

  private resolveNode(span: TelemetrySpan, create = true): NodeState | undefined {
    if (!topologyKinds.has(span.kind as TopologyNodeType)) return undefined;
    const type = span.kind as TopologyNodeType;
    const identity = String(span.attributes?.['nodeflow.identity'] ?? span.name);
    const className = stringAttribute(span, 'nodeflow.class');
    const framework = stringAttribute(span, 'nodeflow.framework');
    const nodeName =
      (type === 'controller' || type === 'service') && className
        ? className
        : (stringAttribute(span, 'nodeflow.topology_name') ?? span.name);
    const id = createStableNodeId(type, identity, framework);
    let node = this.nodes.get(id);
    if (!node && create) {
      node = {
        id,
        name: nodeName,
        type,
        framework,
        operation:
          stringAttribute(span, 'nodeflow.method') ?? stringAttribute(span, 'nodeflow.operation'),
        metrics: emptyMetrics(),
      };
      this.nodes.set(id, node);
    }
    return node;
  }

  private findNearestParentNode(trace: TraceState, parentSpanId: string): NodeState | undefined {
    let current = trace.spans.get(parentSpanId);
    const visited = new Set<string>();
    while (current && !visited.has(current.spanId)) {
      visited.add(current.spanId);
      const node = this.resolveNode(current, false);
      if (node) return node;
      current = current.parentSpanId ? trace.spans.get(current.parentSpanId) : undefined;
    }
    return undefined;
  }

  private record(metrics: MetricAccumulator, durationMs: number, failed: boolean): void {
    metrics.count += 1;
    metrics.errors += failed ? 1 : 0;
    metrics.totalLatencyMs += durationMs;
    metrics.latencies.push(durationMs);
    if (metrics.latencies.length > this.maxLatencySamples) metrics.latencies.shift();
  }

  private aggregateRuntimePaths(trace: TraceState): void {
    const recentTrace = buildTrace(trace.spans);
    const entrypointRoots = recentTrace.spans.filter(
      (span) =>
        span.nodeId &&
        (span.kind === 'http-route' ||
          span.kind === 'worker' ||
          span.kind === 'controller' ||
          span.kind === 'service'),
    );
    if (entrypointRoots.length === 0) return;

    const uniquePaths = new Map<string, { entrypoint: string; nodes: string[] }>();
    for (const root of entrypointRoots) {
      for (const nodes of collectNodePaths(root)) {
        if (nodes.length === 0) continue;
        uniquePaths.set(nodes.join('>'), { entrypoint: root.name, nodes });
      }
    }

    const failed = recentTrace.status === 'error';
    const desired = new Map<
      string,
      { path: { entrypoint: string; nodes: string[] }; durationMs: number; failed: boolean }
    >();
    for (const path of uniquePaths.values()) {
      desired.set(createStablePathId(path.entrypoint, path.nodes), {
        path,
        durationMs: recentTrace.durationMs,
        failed,
      });
    }

    for (const [pathId, contribution] of trace.pathContributions) {
      const next = desired.get(pathId);
      if (
        next &&
        next.durationMs === contribution.durationMs &&
        next.failed === contribution.failed
      ) {
        continue;
      }
      const state = this.paths.get(pathId);
      if (!state) continue;
      this.removeRecord(state.metrics, contribution.durationMs, contribution.failed);
      if (state.metrics.count === 0) this.paths.delete(pathId);
    }

    const nextContributions = new Map<string, { durationMs: number; failed: boolean }>();
    for (const [id, contribution] of desired) {
      nextContributions.set(id, {
        durationMs: contribution.durationMs,
        failed: contribution.failed,
      });
      const previous = trace.pathContributions.get(id);
      if (
        previous &&
        previous.durationMs === contribution.durationMs &&
        previous.failed === contribution.failed &&
        this.paths.has(id)
      ) {
        continue;
      }
      let state = this.paths.get(id);
      if (!state) {
        if (this.paths.size >= this.maxRuntimePaths) this.removeLeastUsefulPath();
        state = {
          id,
          entrypoint: contribution.path.entrypoint,
          nodes: contribution.path.nodes,
          metrics: emptyMetrics(),
          lastUpdatedAt: 0,
        };
        this.paths.set(id, state);
      }
      this.record(state.metrics, contribution.durationMs, contribution.failed);
      state.lastUpdatedAt = ++this.traceClock;
    }
    trace.pathContributions = nextContributions;
  }

  private removeRecord(metrics: MetricAccumulator, durationMs: number, failed: boolean): void {
    metrics.count = Math.max(0, metrics.count - 1);
    metrics.errors = Math.max(0, metrics.errors - (failed ? 1 : 0));
    metrics.totalLatencyMs = Math.max(0, metrics.totalLatencyMs - durationMs);
    const sampleIndex = metrics.latencies.indexOf(durationMs);
    if (sampleIndex >= 0) metrics.latencies.splice(sampleIndex, 1);
  }

  private removeLeastUsefulPath(): void {
    const candidate = [...this.paths.values()].sort(
      (a, b) => a.metrics.count - b.metrics.count || a.lastUpdatedAt - b.lastUpdatedAt,
    )[0];
    if (candidate) this.paths.delete(candidate.id);
  }

  private buildRuntimePaths(): RuntimePath[] {
    return [...this.paths.values()]
      .map((path) => ({
        id: path.id,
        entrypoint: path.entrypoint,
        nodes: [...path.nodes],
        calls: path.metrics.count,
        avgDurationMs:
          path.metrics.count === 0 ? 0 : round(path.metrics.totalLatencyMs / path.metrics.count),
        p95DurationMs: percentile(path.metrics.latencies, 0.95),
        errors: path.metrics.errors,
      }))
      .sort((a, b) => b.calls - a.calls || a.id.localeCompare(b.id));
  }

  private trimTraces(): void {
    if (this.traces.size <= this.maxRecentTraces) return;
    const oldest = [...this.traces.values()]
      .sort((a, b) => a.lastUpdatedAt - b.lastUpdatedAt)
      .slice(0, this.traces.size - this.maxRecentTraces);
    for (const trace of oldest) {
      this.traces.delete(trace.traceId);
      for (const spanId of trace.spans.keys()) {
        this.seenSpanIds.delete(spanId);
        this.seenEdgeSpanIds.delete(`${trace.traceId}:${spanId}`);
      }
    }
  }

  private buildRecentTraces(): RecentTrace[] {
    return [...this.traces.values()]
      .filter((trace) =>
        [...trace.spans.values()].some((span) => topologyKinds.has(span.kind as TopologyNodeType)),
      )
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
      .map((trace) => buildTrace(trace.spans));
  }
}

export function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return round(sorted[index] ?? 0);
}

function buildTrace(spans: Map<string, TelemetrySpan>): RecentTrace {
  const traceSpans = new Map<string, TraceSpan>();
  for (const span of spans.values()) {
    if (traceKinds.has(span.kind)) {
      traceSpans.set(span.spanId, {
        ...span,
        ...(topologyKinds.has(span.kind as TopologyNodeType)
          ? {
              nodeId: createStableNodeId(
                span.kind as TopologyNodeType,
                String(span.attributes?.['nodeflow.identity'] ?? span.name),
                stringAttribute(span, 'nodeflow.framework'),
              ),
            }
          : {}),
        children: [],
      });
    }
  }

  const roots: TraceSpan[] = [];
  for (const span of traceSpans.values()) {
    const parent = findNearestTraceParent(span, spans, traceSpans);
    if (parent) parent.children.push(span);
    else roots.push(span);
  }
  const orderedRoots = sortTraceSpans(roots);
  const earliest = Math.min(...[...spans.values()].map((span) => span.startTimeUnixMs));
  const latest = Math.max(
    ...[...spans.values()].map((span) => span.startTimeUnixMs + span.durationMs),
  );
  const root = orderedRoots[0];
  return {
    id: root?.traceId ?? '',
    name: root?.name ?? 'Trace',
    startedAt: Number.isFinite(earliest) ? earliest : Date.now(),
    durationMs: Number.isFinite(latest - earliest) ? round(latest - earliest) : 0,
    status: [...spans.values()].some((span) => span.status === 'error') ? 'error' : 'ok',
    spans: orderedRoots,
  };
}

function findNearestTraceParent(
  span: TraceSpan,
  allSpans: Map<string, TelemetrySpan>,
  topologySpans: Map<string, TraceSpan>,
): TraceSpan | undefined {
  let parentId = span.parentSpanId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const topologyParent = topologySpans.get(parentId);
    if (topologyParent) return topologyParent;
    parentId = allSpans.get(parentId)?.parentSpanId;
  }
  return undefined;
}

function sortTraceSpans(spans: TraceSpan[]): TraceSpan[] {
  return spans
    .sort((a, b) => a.startTimeUnixMs - b.startTimeUnixMs)
    .map((span) => ({ ...span, children: sortTraceSpans(span.children) }));
}

function collectNodePaths(span: TraceSpan, parentNodes: string[] = []): string[][] {
  const nodes = [...parentNodes];
  if (span.nodeId && nodes.at(-1) !== span.nodeId) nodes.push(span.nodeId);
  if (span.children.length === 0) return [nodes];
  return span.children.flatMap((child) => collectNodePaths(child, nodes));
}

function emptyMetrics(): MetricAccumulator {
  return { count: 0, errors: 0, totalLatencyMs: 0, latencies: [] };
}

function summarize(metrics: MetricAccumulator): MetricSummary {
  return {
    requestCount: metrics.count,
    errorCount: metrics.errors,
    errorRate: metrics.count === 0 ? 0 : round((metrics.errors / metrics.count) * 100),
    avgLatencyMs: metrics.count === 0 ? 0 : round(metrics.totalLatencyMs / metrics.count),
    p50LatencyMs: percentile(metrics.latencies, 0.5),
    p95LatencyMs: percentile(metrics.latencies, 0.95),
    p99LatencyMs: percentile(metrics.latencies, 0.99),
  };
}

function toNode(node: NodeState): TopologyNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    framework: node.framework,
    operation: node.operation,
    ...summarize(node.metrics),
  };
}

function toArchitectureNode(node: NodeState): ArchitectureNode {
  return {
    id: node.id,
    type: toArchitectureNodeType(node.type),
    name: node.name,
    framework: node.framework,
    metrics: {
      callCount: node.metrics.count,
      errorCount: node.metrics.errors,
      avgDurationMs:
        node.metrics.count === 0 ? 0 : round(node.metrics.totalLatencyMs / node.metrics.count),
      p50DurationMs: percentile(node.metrics.latencies, 0.5),
      p95DurationMs: percentile(node.metrics.latencies, 0.95),
      p99DurationMs: percentile(node.metrics.latencies, 0.99),
    },
  };
}

function toArchitectureNodeType(type: TopologyNodeType): ArchitectureNode['type'] {
  return {
    'http-route': 'http',
    controller: 'controller',
    service: 'service',
    database: 'database',
    redis: 'cache',
    queue: 'queue',
    worker: 'provider',
    'external-http': 'external-service',
  }[type] as ArchitectureNode['type'];
}

function toArchitectureEdgeMetrics(
  metrics: MetricAccumulator,
): NonNullable<import('@mshamed1/node-flow-protocol').ArchitectureEdge['metrics']> {
  return {
    callCount: metrics.count,
    errorCount: metrics.errors,
    avgDurationMs: metrics.count === 0 ? 0 : round(metrics.totalLatencyMs / metrics.count),
    p95DurationMs: percentile(metrics.latencies, 0.95),
  };
}

function toEdge(edge: EdgeState): TopologyEdge {
  return { id: edge.id, source: edge.source, target: edge.target, ...summarize(edge.metrics) };
}

function stringAttribute(span: TelemetrySpan, key: string): string | undefined {
  const value = span.attributes?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function normalizeSemanticIdentity(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .split(':')
    .map((part) =>
      part
        .trim()
        .replace(/[^a-z0-9._/-]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter(Boolean)
    .join(':');
}

export function createStableNodeId(
  type: TopologyNodeType,
  identity: string,
  framework?: string,
): string {
  const normalizedType = normalizeSemanticIdentity(type);
  let normalizedIdentity = normalizeSemanticIdentity(identity) || 'unknown';
  if (
    normalizedIdentity !== normalizedType &&
    !normalizedIdentity.startsWith(`${normalizedType}:`)
  ) {
    normalizedIdentity = `${normalizedType}:${normalizedIdentity}`;
  }
  const normalizedFramework = framework ? normalizeSemanticIdentity(framework) : '';
  if (normalizedFramework && !normalizedIdentity.startsWith(`${normalizedFramework}:`)) {
    normalizedIdentity = `${normalizedFramework}:${normalizedIdentity}`;
  }
  return normalizedIdentity;
}

export function createStableEdgeId(source: string, target: string): string {
  return `dependency:${source}->${target}`;
}

function createStablePathId(entrypoint: string, nodes: string[]): string {
  return stableHash('path', `${normalizeSemanticIdentity(entrypoint)}:${nodes.join('>')}`);
}

function stableHash(prefix: string, value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}:${(hash >>> 0).toString(36)}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export * from './snapshot.js';
