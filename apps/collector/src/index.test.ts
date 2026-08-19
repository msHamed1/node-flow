import { afterEach, describe, expect, it } from 'vitest';
import type { RunningCollector } from './index.js';
import { startCollector } from './index.js';

let collector: RunningCollector | undefined;
afterEach(async () => collector?.close());

describe('collector integration', () => {
  it('receives telemetry and exposes an aggregated topology snapshot', async () => {
    collector = await startCollector({ port: 0 });
    const response = await fetch(`${collector.url}/api/spans`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serviceName: 'integration-test',
        spans: [
          { traceId: 't1', spanId: 's1', name: 'POST /payments', kind: 'http-route', startTimeUnixMs: Date.now(), durationMs: 20, status: 'ok' },
          { traceId: 't1', spanId: 's2', parentSpanId: 's1', name: 'PaymentsController', kind: 'controller', startTimeUnixMs: Date.now() + 1, durationMs: 18, status: 'ok' },
        ],
      }),
    });
    expect(response.status).toBe(202);
    const snapshot = await fetch(`${collector.url}/api/snapshot`).then((result) => result.json()) as { nodes: unknown[]; edges: unknown[] };
    expect(snapshot.nodes).toHaveLength(2);
    expect(snapshot.edges).toHaveLength(1);
  });
});
