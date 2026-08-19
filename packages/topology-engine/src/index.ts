import type {
  MetricSummary,
  RecentTrace,
  RuntimeMetrics,
  TelemetrySpan,
  TopologyEdge,
  TopologyNode,
  TopologyNodeType,
  TopologySnapshot,
  TraceSpan,
} from '@mshamed1/node-flow-protocol';

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
  operation?: string;
  metrics: MetricAccumulator;
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
}

export interface TopologyEngineOptions {
  maxRecentTraces?: number;
  maxLatencySamples?: number;
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
  private readonly traces = new Map<string, TraceState>();
  private readonly seenSpanIds = new Set<string>();
  private readonly seenEdgeSpanIds = new Set<string>();
  private readonly maxRecentTraces: number;
  private readonly maxLatencySamples: number;
  private runtime?: RuntimeMetrics;
  private revision = 0;
  private traceClock = 0;
  private activity = { nodeIds: [] as string[], edgeIds: [] as string[] };

  constructor(options: TopologyEngineOptions = {}) {
    this.maxRecentTraces = options.maxRecentTraces ?? 50;
    this.maxLatencySamples = options.maxLatencySamples ?? 1_000;
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
        const edgeId = stableId('edge', `${parentNode.id}->${childNode.id}`);
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
      edges: [...this.edges.values()].map(toEdge),
      traces: this.buildRecentTraces(),
      runtime: this.runtime,
      activity: this.activity,
    };
  }

  private resolveNode(span: TelemetrySpan, create = true): NodeState | undefined {
    if (!topologyKinds.has(span.kind as TopologyNodeType)) return undefined;
    const type = span.kind as TopologyNodeType;
    const identity = String(span.attributes?.['nodeflow.identity'] ?? span.name);
    const className = stringAttribute(span, 'nodeflow.class');
    const nodeName =
      (type === 'controller' || type === 'service') && className ? className : span.name;
    const id = stableId(type, identity);
    let node = this.nodes.get(id);
    if (!node && create) {
      node = {
        id,
        name: nodeName,
        type,
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
      traceSpans.set(span.spanId, { ...span, children: [] });
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

function emptyMetrics(): MetricAccumulator {
  return { count: 0, errors: 0, totalLatencyMs: 0, latencies: [] };
}

function summarize(metrics: MetricAccumulator): MetricSummary {
  return {
    requestCount: metrics.count,
    errorCount: metrics.errors,
    errorRate: metrics.count === 0 ? 0 : round((metrics.errors / metrics.count) * 100),
    avgLatencyMs: metrics.count === 0 ? 0 : round(metrics.totalLatencyMs / metrics.count),
    p95LatencyMs: percentile(metrics.latencies, 0.95),
  };
}

function toNode(node: NodeState): TopologyNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    operation: node.operation,
    ...summarize(node.metrics),
  };
}

function toEdge(edge: EdgeState): TopologyEdge {
  return { id: edge.id, source: edge.source, target: edge.target, ...summarize(edge.metrics) };
}

function stringAttribute(span: TelemetrySpan, key: string): string | undefined {
  const value = span.attributes?.[key];
  return typeof value === 'string' ? value : undefined;
}

function stableId(prefix: string, value: string): string {
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
