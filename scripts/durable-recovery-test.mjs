import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const collectorUrl = process.env.NODEFLOW_INTEGRATION_COLLECTOR_URL ?? 'http://127.0.0.1:7331';
const goCollectorUrl = process.env.NODEFLOW_INTEGRATION_GO_COLLECTOR_URL ?? 'http://127.0.0.1:4318';

await waitFor(`${goCollectorUrl}/readyz`, 'Go collector readiness');
compose('stop', 'nodeflow');
await waitFor(`${goCollectorUrl}/readyz`, 'durable admission during sink outage');

const response = await fetch(`${goCollectorUrl}/api/spans`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    serviceName: 'durability-probe',
    nodeVersion: process.version,
    spans: [
      {
        traceId: 'durable-replay-trace',
        spanId: 'durable-replay-span',
        name: 'DurableReplayProbe.execute',
        kind: 'service',
        startTimeUnixMs: 1_700_000_000_000,
        durationMs: 7,
        status: 'ok',
        attributes: {
          'nodeflow.identity': 'service:DurableReplayProbe',
          'nodeflow.class': 'DurableReplayProbe',
        },
      },
    ],
  }),
});
assert.equal(response.status, 202, `durable admission returned ${response.status}`);
await response.arrayBuffer();

await waitForMetric(
  (metrics) => metrics.nodeflow_collector_spool_active_records >= 1,
  'durable record was not retained during the sink outage',
);
await waitForMetric(
  (metrics) => metrics.nodeflow_collector_spool_retries_total >= 1,
  'sink outage did not trigger a checkpointed retry',
);

compose('kill', '-s', 'SIGKILL', 'nodeflow-collector');
compose('start', 'nodeflow');
await waitFor(`${collectorUrl}/api/health`, 'restarted TypeScript topology service');
compose('start', 'nodeflow-collector');
await waitFor(`${goCollectorUrl}/readyz`, 'restarted Go collector');

let snapshot;
for (let attempt = 0; attempt < 80; attempt += 1) {
  const snapshotResponse = await fetch(`${collectorUrl}/api/snapshot`);
  if (snapshotResponse.ok) {
    snapshot = await snapshotResponse.json();
    const probe = snapshot.nodes.find((node) => node.id === 'service:durablereplayprobe');
    if (probe?.requestCount === 1) break;
  }
  await delay(250);
}
const probe = snapshot?.nodes.find((node) => node.id === 'service:durablereplayprobe');
assert.equal(probe?.requestCount, 1, 'controlled restart did not produce one canonical probe call');

await waitForMetric(
  (metrics) =>
    metrics.nodeflow_collector_spool_replayed_total >= 1 &&
    metrics.nodeflow_collector_spool_active_records === 0,
  'replayed records were not checkpointed after recovery',
);

console.log('Sink outage retained telemetry, SIGKILL preserved it, and restart replayed it.');
console.log(
  'The TypeScript topology engine observed one canonical DurableReplayProbe call in this run.',
);

function compose(...args) {
  execFileSync('docker', ['compose', ...args], { stdio: 'inherit' });
}

async function waitFor(url, name) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const result = await fetch(url);
      if (result.ok) return;
    } catch {
      // The container is still restarting.
    }
    await delay(250);
  }
  throw new Error(`${name} did not become ready`);
}

async function waitForMetric(predicate, errorMessage) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(`${goCollectorUrl}/metrics`);
    if (response.ok) {
      const metrics = parseMetrics(await response.text());
      if (predicate(metrics)) return;
    }
    await delay(100);
  }
  throw new Error(errorMessage);
}

function parseMetrics(text) {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => line && !line.startsWith('#') && !line.includes('{'))
      .map((line) => {
        const [name, value] = line.split(/\s+/);
        return [name, Number(value)];
      }),
  );
}
