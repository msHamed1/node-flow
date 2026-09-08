import { describe, expect, it } from 'vitest';
import type { NodeFlowSnapshot } from '@mshamed1/node-flow-protocol';
import {
  compareSnapshots,
  deserializeSnapshot,
  serializeSnapshot,
  SnapshotValidationError,
} from './snapshot.js';

describe('architecture snapshots', () => {
  it('serializes and deserializes a normalized versioned snapshot', () => {
    const snapshot = fixture();
    snapshot.nodes.reverse();
    const serialized = serializeSnapshot(snapshot);
    const restored = deserializeSnapshot(serialized);

    expect(restored.version).toBe('1.0');
    expect(restored.nodes.map((node) => node.id)).toEqual([
      'database:postgresql',
      'nestjs:service:paymentsservice',
    ]);
    expect(restored).toEqual(JSON.parse(serialized));
  });

  it('rejects malformed files and unsupported snapshot versions', () => {
    expect(() => deserializeSnapshot('{not-json')).toThrow(SnapshotValidationError);
    expect(() => deserializeSnapshot(JSON.stringify({ version: '1.0' }))).toThrow(/generatedAt/);
    expect(() => deserializeSnapshot(JSON.stringify({ ...fixture(), version: '2.0' }))).toThrow(
      /Unsupported NodeFlow snapshot version/,
    );
    expect(() => deserializeSnapshot(JSON.stringify({ ...fixture(), version: '0.9' }))).toThrow(
      /Unsupported NodeFlow snapshot version/,
    );
  });

  it('detects added and removed nodes and edges independently of metrics', () => {
    const before = fixture();
    const after = fixture();
    before.nodes.push({
      id: 'provider:legacypaymentadapter',
      type: 'provider',
      name: 'LegacyPaymentAdapter',
    });
    before.edges.push({
      id: 'dependency:nestjs:service:paymentsservice->provider:legacypaymentadapter',
      source: 'nestjs:service:paymentsservice',
      target: 'provider:legacypaymentadapter',
      type: 'runtime-dependency',
    });
    after.nodes.push({ id: 'service:fraudservice', type: 'service', name: 'FraudService' });
    after.edges.push({
      id: 'dependency:nestjs:service:paymentsservice->service:fraudservice',
      source: 'nestjs:service:paymentsservice',
      target: 'service:fraudservice',
      type: 'runtime-dependency',
    });

    const diff = compareSnapshots(before, after);
    expect(diff.nodes.added.map((node) => node.name)).toEqual(['FraudService']);
    expect(diff.nodes.removed.map((node) => node.name)).toEqual(['LegacyPaymentAdapter']);
    expect(diff.edges.added.map((edge) => [edge.source, edge.target])).toContainEqual([
      'nestjs:service:paymentsservice',
      'service:fraudservice',
    ]);
    expect(diff.edges.removed.map((edge) => [edge.source, edge.target])).toContainEqual([
      'nestjs:service:paymentsservice',
      'provider:legacypaymentadapter',
    ]);
  });

  it('detects meaningful metric changes without classifying them as structural changes', () => {
    const before = fixture();
    const after = fixture();
    after.edges[0] = {
      ...after.edges[0]!,
      metrics: { callCount: 1_200, avgDurationMs: 31, p95DurationMs: 96 },
    };

    const diff = compareSnapshots(before, after);
    expect(diff.edges.added).toHaveLength(0);
    expect(diff.edges.removed).toHaveLength(0);
    expect(diff.edges.changed).toHaveLength(0);
    expect(diff.metrics.edges[0]).toMatchObject({
      severity: 'warning',
      changes: expect.arrayContaining([
        expect.objectContaining({ metric: 'avgDurationMs', before: 18, after: 31 }),
        expect.objectContaining({ metric: 'p95DurationMs', before: 41, after: 96 }),
      ]),
    });
  });

  it('suppresses insignificant metric drift by default', () => {
    const before = fixture();
    const after = fixture();
    before.edges[0]!.metrics = { avgDurationMs: 21, p95DurationMs: 41 };
    after.edges[0]!.metrics = { avgDurationMs: 21.1, p95DurationMs: 42 };
    expect(compareSnapshots(before, after).metrics.edges).toHaveLength(0);
  });

  it('reports unchanged architecture when arrays are reordered', () => {
    const before = fixture();
    const after = fixture();
    after.nodes.reverse();
    after.edges.reverse();
    const diff = compareSnapshots(before, after);

    expect(diff.summary).toEqual({
      addedNodes: 0,
      removedNodes: 0,
      changedNodes: 0,
      addedEdges: 0,
      removedEdges: 0,
      changedEdges: 0,
    });
    expect(diff.metrics.nodes).toHaveLength(0);
    expect(diff.metrics.edges).toHaveLength(0);
  });

  it('returns an empty architecture diff for identical snapshots', () => {
    const snapshot = fixture();
    const diff = compareSnapshots(snapshot, structuredClone(snapshot));
    expect(diff.summary).toEqual({
      addedNodes: 0,
      removedNodes: 0,
      changedNodes: 0,
      addedEdges: 0,
      removedEdges: 0,
      changedEdges: 0,
    });
    expect(diff.metrics).toEqual({ nodes: [], edges: [] });
  });

  it('marks a new external dependency as a warning without inferring critical severity', () => {
    const before = fixture();
    const after = fixture();
    const external = {
      id: 'external-http:api.stripe.com',
      type: 'external-service' as const,
      name: 'api.stripe.com',
    };
    after.nodes.push(external);
    after.edges.push({
      id: `dependency:nestjs:service:paymentsservice->${external.id}`,
      source: 'nestjs:service:paymentsservice',
      target: external.id,
      type: 'runtime-dependency',
    });
    const diff = compareSnapshots(before, after);
    expect(diff.nodes.added[0]?.severity).toBe('warning');
    expect(diff.edges.added[0]?.severity).toBe('warning');
  });
});

function fixture(): NodeFlowSnapshot {
  return {
    version: '1.0',
    generatedAt: '2026-08-26T10:00:00.000Z',
    application: { name: 'payments-api', runtime: 'nodejs', nodeVersion: 'v22.1.0' },
    nodes: [
      {
        id: 'nestjs:service:paymentsservice',
        type: 'service',
        name: 'PaymentsService',
        framework: 'nestjs',
        metrics: { callCount: 1_000, avgDurationMs: 20, p95DurationMs: 45 },
      },
      {
        id: 'database:postgresql',
        type: 'database',
        name: 'PostgreSQL',
        metrics: { callCount: 1_000, avgDurationMs: 18, p95DurationMs: 41 },
      },
    ],
    edges: [
      {
        id: 'dependency:nestjs:service:paymentsservice->database:postgresql',
        source: 'nestjs:service:paymentsservice',
        target: 'database:postgresql',
        type: 'runtime-dependency',
        metrics: { callCount: 1_000, avgDurationMs: 18, p95DurationMs: 41 },
      },
    ],
  };
}
