import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { encodeTelemetryEnvelope } from '../packages/protocol/dist/index.js';

const collectorUrl = process.env.NODEFLOW_INTEGRATION_COLLECTOR_URL ?? 'http://127.0.0.1:7331';
const goCollectorUrl = process.env.NODEFLOW_INTEGRATION_GO_COLLECTOR_URL ?? 'http://127.0.0.1:4318';
const runId = Date.now().toString(36);
const gracefulClass = `GracefulRestartProbe${runId}`;
const durableClass = `DurableReplayProbe${runId}`;
const gracefulNodeId = `service:${gracefulClass.toLowerCase()}`;
const durableNodeId = `service:${durableClass.toLowerCase()}`;

await waitFor(`${goCollectorUrl}/readyz`, 'Go collector readiness');
const health = await fetchJSON(`${collectorUrl}/api/health`);
assert.equal(health.topologyEngine, 'go', 'durability suite is not exercising the Go authority');

await admitProbe(
  `graceful-restart-trace-${runId}`,
  `graceful-restart-span-${runId}`,
  gracefulClass,
);
await waitForNode(gracefulNodeId, 1);
compose('stop', '-t', '20', 'nodeflow-collector');
compose('start', 'nodeflow-collector');
await waitFor(`${goCollectorUrl}/readyz`, 'Go collector after SIGTERM');
await waitForNode(gracefulNodeId, 1);

let stateDirectoryLocked = false;
try {
  compose(
    'exec',
    '-T',
    '--user',
    'root',
    'nodeflow-collector',
    'chmod',
    '0500',
    '/var/lib/nodeflow/topology-state',
  );
  stateDirectoryLocked = true;
  await admitProbe(`durable-replay-trace-${runId}`, `durable-replay-span-${runId}`, durableClass);

  await waitForMetric(
    (metrics) => metrics.nodeflow_collector_spool_active_records >= 1,
    'durable record was not retained during the topology checkpoint outage',
  );
  await waitForMetric(
    (metrics) => metrics.nodeflow_collector_spool_retries_total >= 1,
    'topology checkpoint outage did not trigger a checkpointed retry',
  );

  compose('kill', '-s', 'SIGKILL', 'nodeflow-collector');
  compose('start', 'nodeflow-collector');
  await waitFor(`${goCollectorUrl}/readyz`, 'Go collector after SIGKILL');
  compose(
    'exec',
    '-T',
    '--user',
    'root',
    'nodeflow-collector',
    'chmod',
    '0700',
    '/var/lib/nodeflow/topology-state',
  );
  stateDirectoryLocked = false;

  await waitForNode(durableNodeId, 1);
  await waitForMetric(
    (metrics) =>
      metrics.nodeflow_collector_spool_replayed_total >= 1 &&
      metrics.nodeflow_collector_wal_replayed_total >= 1 &&
      metrics.nodeflow_collector_wal_pending_records === 0 &&
      metrics.nodeflow_collector_spool_active_records === 0,
    'replayed records were not checkpointed after recovery',
  );

  // A second admitted copy models the at-least-once crash window. Durable span
  // identity in the Go state checkpoint must keep topology metrics idempotent.
  await admitProbe(`durable-replay-trace-${runId}`, `durable-replay-span-${runId}`, durableClass);
  await waitForMetric(
    (metrics) => metrics.nodeflow_collector_spool_active_records === 0,
    'duplicate replay record was not acknowledged',
  );
  await waitForNode(durableNodeId, 1);
  await waitForNode(gracefulNodeId, 1);
} finally {
  if (stateDirectoryLocked) restoreTopologyStatePermissions();
}

console.log('SIGTERM restored topology state without telemetry replay.');
console.log('Checkpoint interruption retained the WAL record; SIGKILL restart replayed it once.');
console.log('A repeated admitted span remained one canonical Go topology call.');

function compose(...args) {
  execFileSync('docker', ['compose', ...args], { stdio: 'inherit' });
}

async function admitProbe(traceId, spanId, className) {
  const body = encodeTelemetryEnvelope({
    protocolVersion: '1.0',
    spanBatch: {
      serviceName: 'durability-probe',
      nodeVersion: process.version,
      spans: [
        {
          traceId,
          spanId,
          name: `${className}.execute`,
          kind: 'service',
          startTimeUnixMs: 1_700_000_000_000,
          durationMs: 7,
          status: 'ok',
          attributes: {
            'nodeflow.identity': `service:${className}`,
            'nodeflow.class': className,
          },
        },
      ],
    },
  });
  const response = await fetch(`${goCollectorUrl}/v1/telemetry`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf' },
    body,
  });
  assert.equal(response.status, 202, `durable admission returned ${response.status}`);
  await response.arrayBuffer();
}

async function waitForNode(id, requestCount) {
  let snapshot;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(`${collectorUrl}/api/snapshot`);
    if (response.ok) {
      snapshot = await response.json();
      if (snapshot.nodes.find((node) => node.id === id)?.requestCount === requestCount) return;
    }
    await delay(250);
  }
  throw new Error(
    `topology node ${id} did not reach requestCount=${requestCount}: ${JSON.stringify(snapshot)}`,
  );
}

async function fetchJSON(url) {
  const response = await fetch(url);
  assert(response.ok, `${url} returned ${response.status}`);
  return response.json();
}

function restoreTopologyStatePermissions() {
  try {
    compose('start', 'nodeflow-collector');
    compose(
      'exec',
      '-T',
      '--user',
      'root',
      'nodeflow-collector',
      'chmod',
      '0700',
      '/var/lib/nodeflow/topology-state',
    );
  } catch {
    // Preserve the original test failure; Compose teardown removes the test volume.
  }
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
