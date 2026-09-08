import { describe, expect, it } from 'vitest';
import type {
  NodeFlowSnapshot,
  TopologyEdge,
  TopologyNode,
  TopologyNodeType,
  TopologySnapshot,
} from '@mshamed1/node-flow-protocol';
import { buildFlow } from './App.js';
import {
  architectureSummary,
  architectureToTopology,
  comparisonFromSnapshots,
  dependencyRows,
  edgeVisualWeight,
  groupRuntimePaths,
  layoutArchitecture,
  liveInsights,
  searchArchitecture,
  topologyStructureKey,
  validateSnapshotShape,
} from './explorer.js';

describe('architecture explorer transformations', () => {
  it('selects a node without changing graph structure', () => {
    const snapshot = paymentTopology();
    const graph = flow(snapshot, { selectedNodeId: 'service' });

    expect(graph.nodes.find((node) => node.id === 'service')?.data.selected).toBe(true);
    expect(graph.nodes).toHaveLength(snapshot.nodes.length);
    expect(graph.edges).toHaveLength(snapshot.edges.length);
  });

  it('calculates navigable dependency rows and only reports meaningful percentages', () => {
    const snapshot = paymentTopology();
    const outbound = dependencyRows('service', 'outbound', snapshot);

    expect(outbound.map((row) => row.node.id)).toEqual(['postgres', 'redis', 'risk-api', 'queue']);
    expect(outbound.map((row) => Math.round(row.percentage ?? 0))).toEqual([60, 20, 13, 7]);

    snapshot.edges = snapshot.edges.map((candidate) =>
      candidate.source === 'service'
        ? edge(candidate.id, candidate.source, candidate.target, 0)
        : candidate,
    );
    expect(
      dependencyRows('service', 'outbound', snapshot).every((row) => row.percentage === undefined),
    ).toBe(true);
  });

  it('groups branching runtime paths without double-counting request calls', () => {
    const [path] = groupRuntimePaths(paymentTopology());

    expect(path?.calls).toBe(12);
    expect(path?.nodeIds).toEqual(
      expect.arrayContaining(['route', 'controller', 'service', 'redis', 'postgres']),
    );
    expect(path?.edgeKeys).toContain('service->postgres');
    expect(path?.externalSystems.map((node) => node.name)).toEqual(['Redis', 'PostgreSQL']);
  });

  it('dims or hides nodes outside a selected runtime path', () => {
    const snapshot = paymentTopology();
    const path = groupRuntimePaths(snapshot)[0];
    const dimmed = flow(snapshot, { selectedPath: path, pathDisplayMode: 'dim' });
    const hidden = flow(snapshot, { selectedPath: path, pathDisplayMode: 'hide' });

    expect(dimmed.nodes.find((node) => node.id === 'isolated')?.data.dimmed).toBe(true);
    expect(dimmed.edges.find((edge) => edge.id === 'isolated-edge')?.className).toContain('dimmed');
    expect(hidden.nodes.some((node) => node.id === 'isolated')).toBe(false);
    expect(hidden.edges.some((edge) => edge.id === 'isolated-edge')).toBe(false);
  });

  it('searches names, semantic types, entrypoints, and external services', () => {
    const snapshot = paymentTopology();

    expect(searchArchitecture(snapshot, 'PaymentsService').map((node) => node.id)).toEqual([
      'service',
    ]);
    expect(searchArchitecture(snapshot, 'entrypoint payments').map((node) => node.id)).toEqual([
      'route',
    ]);
    expect(searchArchitecture(snapshot, 'cache').map((node) => node.id)).toEqual(['redis']);
    expect(searchArchitecture(snapshot, 'external service').map((node) => node.id)).toEqual([
      'risk-api',
    ]);
  });

  it('switches the same graph between architecture, traffic, latency, and error views', () => {
    const snapshot = paymentTopology();
    const traffic = flow(snapshot, { perspective: 'traffic' });
    const latency = flow(snapshot, { perspective: 'latency' });
    const errors = flow(snapshot, { perspective: 'errors' });

    expect(traffic.nodes).toHaveLength(latency.nodes.length);
    expect(latency.nodes).toHaveLength(errors.nodes.length);
    expect(traffic.edges[0]?.label).toMatch(/calls/);
    expect(latency.edges[0]?.label).toMatch(/p95/);
    expect(errors.edges[0]?.label).toMatch(/errors/);
    expect(edgeVisualWeight(snapshot.edges, snapshot.edges[0]!, 'traffic')).toBeGreaterThanOrEqual(
      1.5,
    );
    expect(edgeVisualWeight(snapshot.edges, snapshot.edges[0]!, 'traffic')).toBeLessThanOrEqual(4);
  });

  it('summarizes empty, connected, and disconnected topology', () => {
    expect(architectureSummary(emptyTopology())).toEqual({
      components: 0,
      dependencies: 0,
      entrypoints: 0,
      runtimePaths: 0,
      databases: 0,
      caches: 0,
      queues: 0,
      externalServices: 0,
    });
    expect(architectureSummary(paymentTopology())).toMatchObject({
      components: 8,
      dependencies: 7,
      entrypoints: 2,
      runtimePaths: 1,
      databases: 1,
      caches: 1,
      externalServices: 1,
    });
  });

  it('emits conservative high-fan-out observations', () => {
    const snapshot = syntheticTopology(10);
    snapshot.edges = snapshot.nodes
      .slice(1, 7)
      .map((node, index) => edge(`fan-${index}`, 'node-0', node.id, 1));

    expect(liveInsights(snapshot)).toEqual([
      expect.objectContaining({
        title: 'High fan-out',
        detail: expect.stringContaining('6 outbound'),
      }),
    ]);
  });

  it('loads snapshot metrics defensively and marks accessible snapshot differences', () => {
    const before = architectureSnapshot();
    const after = architectureSnapshot();
    after.nodes[1] = { ...after.nodes[1]!, metrics: { callCount: 20, p95DurationMs: 90 } };
    after.nodes.push({ id: 'external', type: 'external-service', name: 'risk.example.com' });
    after.edges.push({ id: 'service-external', source: 'service', target: 'external' });

    const comparison = comparisonFromSnapshots(before, after);
    expect(comparison.nodeStatuses.get('service')).toBe('changed');
    expect(comparison.nodeStatuses.get('external')).toBe('added');
    expect(comparison.edgeStatuses.get('service-external')).toBe('added');
    expect(comparison.insights).toContainEqual(
      expect.objectContaining({ title: 'New external dependency' }),
    );

    const missingMetrics = architectureToTopology(after).nodes.find(
      (node) => node.id === 'external',
    );
    expect(missingMetrics).toMatchObject({ requestCount: 0, errorCount: 0, p95LatencyMs: 0 });
    expect(validateSnapshotShape(after)).toBe(true);
    expect(
      validateSnapshotShape({
        ...after,
        nodes: [{ id: 'bad', name: 'Bad', type: 'alien' }],
      }),
    ).toBe(false);
  });

  it.each([10, 50, 100, 250])('lays out a %i-node graph with stable, finite positions', (size) => {
    const snapshot = syntheticTopology(size);
    const positions = layoutArchitecture(snapshot);
    const secondPass = layoutArchitecture({ ...snapshot, revision: 999 });

    expect(positions.size).toBe(size);
    expect(
      new Set([...positions.values()].map((position) => `${position.x}:${position.y}`)).size,
    ).toBe(size);
    expect(
      [...positions.values()].every(
        (position) => Number.isFinite(position.x) && Number.isFinite(position.y),
      ),
    ).toBe(true);
    expect(secondPass).toEqual(positions);
    expect(topologyStructureKey({ ...snapshot, revision: 999 })).toBe(
      topologyStructureKey(snapshot),
    );
  });
});

function flow(
  snapshot: TopologySnapshot,
  overrides: Partial<Parameters<typeof buildFlow>[0]> = {},
): ReturnType<typeof buildFlow> {
  return buildFlow({
    snapshot,
    positions: layoutArchitecture(snapshot),
    pathDisplayMode: 'dim',
    perspective: 'architecture',
    showTrafficLabels: true,
    ...overrides,
  });
}

function paymentTopology(): TopologySnapshot {
  const nodes = [
    node('route', 'POST /payments', 'http-route', 12),
    node('controller', 'PaymentsController', 'controller', 12),
    node('service', 'PaymentsService', 'service', 12),
    node('redis', 'Redis', 'redis', 3),
    node('postgres', 'PostgreSQL', 'database', 9),
    node('risk-api', 'risk.example.com', 'external-http', 2),
    node('isolated', 'DisconnectedWorker', 'worker', 1),
    node('queue', 'RabbitMQ', 'queue', 1),
  ];
  return {
    revision: 1,
    generatedAt: 1,
    nodes,
    edges: [
      edge('route-controller', 'route', 'controller', 12),
      edge('controller-service', 'controller', 'service', 12),
      edge('service-redis', 'service', 'redis', 3),
      edge('service-postgres', 'service', 'postgres', 9),
      edge('service-risk', 'service', 'risk-api', 2),
      edge('isolated-edge', 'isolated', 'queue', 1),
      edge('service-queue', 'service', 'queue', 1),
    ],
    paths: [
      {
        id: 'path-a',
        entrypoint: 'POST /payments',
        nodes: ['route', 'controller', 'service', 'redis'],
        calls: 12,
        avgDurationMs: 32,
        p95DurationMs: 44,
        errors: 1,
      },
      {
        id: 'path-b',
        entrypoint: 'POST /payments',
        nodes: ['route', 'controller', 'service', 'postgres'],
        calls: 12,
        avgDurationMs: 32,
        p95DurationMs: 44,
        errors: 1,
      },
    ],
    traces: [],
    activity: { nodeIds: [], edgeIds: [] },
  };
}

function syntheticTopology(size: number): TopologySnapshot {
  const types: TopologyNodeType[] = [
    'http-route',
    'controller',
    'service',
    'database',
    'redis',
    'queue',
    'worker',
    'external-http',
  ];
  const nodes = Array.from({ length: size }, (_, index) =>
    node(`node-${index}`, `Node ${index}`, types[index % types.length]!, index + 1),
  );
  return {
    revision: 1,
    generatedAt: 1,
    nodes,
    edges: nodes
      .slice(1)
      .map((candidate, index) => edge(`edge-${index}`, nodes[index]!.id, candidate.id, index + 1)),
    paths: [],
    traces: [],
    activity: { nodeIds: [], edgeIds: [] },
  };
}

function architectureSnapshot(): NodeFlowSnapshot {
  return {
    version: '1.0',
    generatedAt: '2026-08-26T00:00:00.000Z',
    application: { runtime: 'nodejs', nodeVersion: 'v22.0.0' },
    nodes: [
      { id: 'route', type: 'http', name: 'POST /payments', metrics: { callCount: 10 } },
      {
        id: 'service',
        type: 'service',
        name: 'PaymentsService',
        metrics: { callCount: 10, p95DurationMs: 40 },
      },
    ],
    edges: [
      {
        id: 'route-service',
        source: 'route',
        target: 'service',
        metrics: { callCount: 10, p95DurationMs: 40 },
      },
    ],
  };
}

function node(
  id: string,
  name: string,
  type: TopologyNodeType,
  requestCount: number,
): TopologyNode {
  return {
    id,
    name,
    type,
    requestCount,
    errorCount: 0,
    errorRate: 0,
    avgLatencyMs: 10,
    p95LatencyMs: 20,
  };
}

function edge(id: string, source: string, target: string, requestCount: number): TopologyEdge {
  return {
    id,
    source,
    target,
    requestCount,
    errorCount: 0,
    errorRate: 0,
    avgLatencyMs: 5,
    p95LatencyMs: 8,
  };
}

function emptyTopology(): TopologySnapshot {
  return {
    revision: 0,
    generatedAt: 0,
    nodes: [],
    edges: [],
    paths: [],
    traces: [],
    activity: { nodeIds: [], edgeIds: [] },
  };
}
