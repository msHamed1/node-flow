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
  p95LatencyMs: number;
}

export interface TopologyNode extends MetricSummary {
  id: string;
  name: string;
  type: TopologyNodeType;
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
  spans: TelemetrySpan[];
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
  traces: RecentTrace[];
  runtime?: RuntimeMetrics;
  activity: {
    nodeIds: string[];
    edgeIds: string[];
  };
}

export type CollectorMessage =
  | { type: 'snapshot'; payload: TopologySnapshot }
  | { type: 'connected'; payload: { version: string } };

export const collectorPaths = {
  spans: '/api/spans',
  runtime: '/api/runtime',
  snapshot: '/api/snapshot',
  health: '/api/health',
  websocket: '/ws',
} as const;
