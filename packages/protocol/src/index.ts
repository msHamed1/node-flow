export type TopologyNodeType =
  | 'http-route'
  | 'controller'
  | 'service'
  | 'database'
  | 'redis'
  | 'queue'
  | 'worker'
  | 'external-http';

export type TelemetrySpanKind = TopologyNodeType | 'custom' | 'internal';

export interface MetricSummary {
  requestCount: number;
  errorCount: number;
  errorRate: number;
  avgLatencyMs: number;
  p50LatencyMs?: number;
  p95LatencyMs: number;
  p99LatencyMs?: number;
}

export interface TopologyNode extends MetricSummary {
  id: string;
  name: string;
  type: TopologyNodeType;
  framework?: string;
  operation?: string;
}

export interface TopologyEdge extends MetricSummary {
  id: string;
  source: string;
  target: string;
}

export interface TelemetrySpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: TelemetrySpanKind;
  startTimeUnixMs: number;
  durationMs: number;
  status: 'ok' | 'error';
  attributes?: Record<string, string | number | boolean>;
}

export interface SpanBatch {
  serviceName: string;
  nodeVersion?: string;
  spans: TelemetrySpan[];
}

export interface RuntimePath {
  id: string;
  entrypoint: string;
  nodes: string[];
  calls: number;
  avgDurationMs?: number;
  p95DurationMs?: number;
  errors?: number;
}

export interface TraceSpan extends TelemetrySpan {
  nodeId?: string;
  children: TraceSpan[];
}

export interface RecentTrace {
  id: string;
  name: string;
  startedAt: number;
  durationMs: number;
  status: 'ok' | 'error';
  spans: TraceSpan[];
}

export interface RuntimeMetrics {
  timestamp: number;
  serviceName: string;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  cpuPercent: number;
  eventLoopUtilization: number;
  uptimeSeconds: number;
}

export interface TopologySnapshot {
  revision: number;
  generatedAt: number;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  paths?: RuntimePath[];
  traces: RecentTrace[];
  runtime?: RuntimeMetrics;
  activity: {
    nodeIds: string[];
    edgeIds: string[];
  };
}

export type ArchitectureNodeType =
  | 'controller'
  | 'service'
  | 'provider'
  | 'database'
  | 'cache'
  | 'queue'
  | 'external-service'
  | 'http'
  | 'unknown';

export interface ArchitectureNodeMetrics {
  callCount?: number;
  errorCount?: number;
  avgDurationMs?: number;
  p50DurationMs?: number;
  p95DurationMs?: number;
  p99DurationMs?: number;
}

export interface ArchitectureNode {
  id: string;
  type: ArchitectureNodeType;
  name: string;
  framework?: string;
  metrics?: ArchitectureNodeMetrics;
}

export interface ArchitectureEdgeMetrics {
  callCount?: number;
  errorCount?: number;
  avgDurationMs?: number;
  p95DurationMs?: number;
}

export interface ArchitectureEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  metrics?: ArchitectureEdgeMetrics;
}

export interface NodeFlowSnapshot {
  version: string;
  generatedAt: string;
  application: {
    name?: string;
    runtime: string;
    nodeVersion: string;
  };
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  paths?: RuntimePath[];
  metadata?: Record<string, unknown>;
}

export type CollectorMessage =
  | { type: 'snapshot'; payload: TopologySnapshot }
  | { type: 'connected'; payload: { version: string } };

export const collectorPaths = {
  spans: '/api/spans',
  runtime: '/api/runtime',
  snapshot: '/api/snapshot',
  architecture: '/api/architecture',
  health: '/api/health',
  websocket: '/ws',
} as const;
