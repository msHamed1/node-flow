import { describe, expect, it } from 'vitest';
import type { TelemetrySpan } from '@mshamed1/node-flow-protocol';
import { percentile, TopologyEngine } from './index.js';

describe('TopologyEngine', () => {
  it('aggregates repeated nodes and edges using stable IDs', () => {
    const engine = new TopologyEngine();
    for (let request = 0; request < 100; request += 1) {
      engine.ingest(trace(`trace-${request}`, request, 10));
    }
    const snapshot = engine.snapshot();
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.edges).toHaveLength(1);
    expect(snapshot.nodes.every((node) => node.requestCount === 100)).toBe(true);
    expect(snapshot.edges[0]?.requestCount).toBe(100);
  });

  it('calculates average, errors, error rate, and p95 latency', () => {
    const engine = new TopologyEngine();
    const durations = [1, 2, 3, 4, 100];
    durations.forEach((duration, index) => {
      const spans = trace(`trace-${index}`, index, duration);
      if (index === 4) spans[1] = { ...spans[1]!, status: 'error' };
      engine.ingest(spans);
    });
    const database = engine.snapshot().nodes.find((node) => node.type === 'database');
    expect(database).toMatchObject({
      requestCount: 5,
      errorCount: 1,
      errorRate: 20,
      avgLatencyMs: 22,
      p95LatencyMs: 100,
    });
    expect(percentile([40, 10, 30, 20], 0.95)).toBe(40);
  });

  it('correlates children that arrive before their parent', () => {
    const engine = new TopologyEngine();
    const spans = trace('out-of-order', 1, 12);
    engine.ingest([spans[1]!]);
    expect(engine.snapshot().edges).toHaveLength(0);
    engine.ingest([spans[0]!]);
    expect(engine.snapshot().edges).toHaveLength(1);
  });

  it('retains only the configured number of recent traces', () => {
    const engine = new TopologyEngine({ maxRecentTraces: 2 });
    engine.ingest(trace('one', 1, 1));
    engine.ingest(trace('two', 2, 1));
    engine.ingest(trace('three', 3, 1));
    expect(engine.snapshot().traces.map((item) => item.id)).toEqual(['three', 'two']);
  });

  it('aggregates provider methods into one node while retaining method trace detail', () => {
    const engine = new TopologyEngine();
    engine.ingest([
      providerSpan('a', 'validatePayment', 1),
      providerSpan('b', 'calculateFees', 2),
      providerSpan('c', 'processPayment', 3),
    ]);

    const snapshot = engine.snapshot();
    const serviceNodes = snapshot.nodes.filter((node) => node.type === 'service');
    expect(serviceNodes).toHaveLength(1);
    expect(serviceNodes[0]).toMatchObject({ name: 'PaymentsService', requestCount: 3 });
    expect(snapshot.traces.map((trace) => trace.spans[0]?.name)).toEqual([
      'PaymentsService.processPayment',
      'PaymentsService.calculateFees',
      'PaymentsService.validatePayment',
    ]);
  });

  it('collapses layered Mongoose and MongoDB spans into one architecture node', () => {
    const engine = new TopologyEngine();
    engine.ingest([
      databaseOperationSpan('mongoose', 'mongoose.PaymentAudit.save'),
      databaseOperationSpan('mongodb', 'mongodb.insert'),
    ]);

    const snapshot = engine.snapshot();
    expect(snapshot.nodes.filter((node) => node.type === 'database')).toEqual([
      expect.objectContaining({ name: 'MongoDB', requestCount: 2 }),
    ]);
    expect(snapshot.traces.map((trace) => trace.spans[0]?.name).sort()).toEqual([
      'mongodb.insert',
      'mongoose.PaymentAudit.save',
    ]);
  });

  it('keeps optional custom spans in trace detail without adding topology nodes', () => {
    const engine = new TopologyEngine();
    const route = trace('custom-detail', 1, 10)[0]!;
    engine.ingest([
      route,
      {
        traceId: route.traceId,
        spanId: 'custom-span',
        parentSpanId: route.spanId,
        name: 'calculate-settlement',
        kind: 'custom',
        startTimeUnixMs: route.startTimeUnixMs + 1,
        durationMs: 4,
        status: 'ok',
      },
    ]);

    const snapshot = engine.snapshot();
    expect(snapshot.nodes).toHaveLength(1);
    expect(snapshot.nodes[0]?.type).toBe('http-route');
    expect(snapshot.traces[0]?.spans[0]?.children[0]?.name).toBe('calculate-settlement');
  });
});

function trace(traceId: string, seed: number, databaseDuration: number): TelemetrySpan[] {
  const start = 1_700_000_000_000 + seed * 1_000;
  return [
    {
      traceId,
      spanId: `${traceId}-route`,
      name: 'POST /payments',
      kind: 'http-route',
      startTimeUnixMs: start,
      durationMs: databaseDuration + 5,
      status: 'ok',
    },
    {
      traceId,
      spanId: `${traceId}-db`,
      parentSpanId: `${traceId}-route`,
      name: 'PostgreSQL',
      kind: 'database',
      startTimeUnixMs: start + 2,
      durationMs: databaseDuration,
      status: 'ok',
    },
  ];
}

function providerSpan(traceId: string, method: string, seed: number): TelemetrySpan {
  return {
    traceId,
    spanId: `${traceId}-service`,
    name: `PaymentsService.${method}`,
    kind: 'service',
    startTimeUnixMs: 1_700_000_000_000 + seed * 1_000,
    durationMs: seed,
    status: 'ok',
    attributes: {
      'nodeflow.identity': 'service:PaymentsService',
      'nodeflow.class': 'PaymentsService',
      'nodeflow.method': method,
    },
  };
}

function databaseOperationSpan(traceId: string, operation: string): TelemetrySpan {
  return {
    traceId,
    spanId: `${traceId}-database`,
    name: operation,
    kind: 'database',
    startTimeUnixMs: 1_700_000_000_000,
    durationMs: 1,
    status: 'ok',
    attributes: {
      'nodeflow.identity': 'database:MongoDB',
      'nodeflow.topology_name': 'MongoDB',
      'nodeflow.operation': operation,
    },
  };
}
