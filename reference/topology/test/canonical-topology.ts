import type { NodeFlowSnapshot } from '@mshamed1/node-flow-protocol';

export interface CanonicalNodeMetrics {
  calls: number;
  errors: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface CanonicalEdgeMetrics {
  calls: number;
  errors: number;
  avgMs: number;
  p95Ms: number;
}

export interface CanonicalPathMetrics {
  calls: number;
  errors: number;
  avgMs: number;
  p95Ms: number;
}

export interface CanonicalTopology {
  format: 'nodeflow.topology-golden.v1';
  snapshotVersion: string;
  applicationRuntime: string;
  services: string[];
  nodes: Array<{
    id: string;
    type: string;
    name: string;
    framework?: string;
    metrics: CanonicalNodeMetrics;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    type: string;
    metrics: CanonicalEdgeMetrics;
  }>;
  paths: Array<{
    entrypoint: string;
    nodes: string[];
    metrics: CanonicalPathMetrics;
  }>;
}

export function canonicalizeTopology(snapshot: NodeFlowSnapshot): CanonicalTopology {
  const services = new Set(snapshot.metadata?.serviceNames ?? []);
  if (snapshot.application.name) services.add(snapshot.application.name);
  return normalizeCanonicalTopology({
    format: 'nodeflow.topology-golden.v1',
    snapshotVersion: snapshot.version,
    applicationRuntime: snapshot.application.runtime,
    services: [...services],
    nodes: snapshot.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      name: node.name,
      ...(node.framework ? { framework: node.framework } : {}),
      metrics: {
        calls: node.metrics?.callCount ?? 0,
        errors: node.metrics?.errorCount ?? 0,
        avgMs: node.metrics?.avgDurationMs ?? 0,
        p50Ms: node.metrics?.p50DurationMs ?? 0,
        p95Ms: node.metrics?.p95DurationMs ?? 0,
        p99Ms: node.metrics?.p99DurationMs ?? 0,
      },
    })),
    edges: snapshot.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.type ?? 'runtime-dependency',
      metrics: {
        calls: edge.metrics?.callCount ?? 0,
        errors: edge.metrics?.errorCount ?? 0,
        avgMs: edge.metrics?.avgDurationMs ?? 0,
        p95Ms: edge.metrics?.p95DurationMs ?? 0,
      },
    })),
    paths: (snapshot.paths ?? []).map((path) => ({
      entrypoint: path.entrypoint,
      nodes: [...path.nodes],
      metrics: {
        calls: path.calls,
        errors: path.errors ?? 0,
        avgMs: path.avgDurationMs ?? 0,
        p95Ms: path.p95DurationMs ?? 0,
      },
    })),
  });
}

export function normalizeCanonicalTopology(value: CanonicalTopology): CanonicalTopology {
  return {
    ...value,
    services: [...value.services].sort(),
    nodes: [...value.nodes].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...value.edges].sort((left, right) => left.id.localeCompare(right.id)),
    paths: [...value.paths].sort((left, right) =>
      `${left.entrypoint}:${left.nodes.join('>')}`.localeCompare(
        `${right.entrypoint}:${right.nodes.join('>')}`,
      ),
    ),
  };
}
