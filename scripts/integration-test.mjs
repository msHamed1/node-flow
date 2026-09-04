import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';

const apiUrl = process.env.NODEFLOW_INTEGRATION_API_URL ?? 'http://127.0.0.1:3000';
const collectorUrl = process.env.NODEFLOW_INTEGRATION_COLLECTOR_URL ?? 'http://127.0.0.1:7331';
const goCollectorUrl = process.env.NODEFLOW_INTEGRATION_GO_COLLECTOR_URL ?? 'http://127.0.0.1:4318';

await assertAutomaticInstrumentationSources();
await waitFor(`${apiUrl}/health`, 'integration API');
await waitFor(`${collectorUrl}/api/health`, 'NodeFlow collector');
await waitFor(`${goCollectorUrl}/readyz`, 'NodeFlow Go collector');

// Prove aggregation under load before retaining the richer scenarios below in
// the collector's bounded recent-trace window.
await Promise.all(Array.from({ length: 100 }, () => post('/integration/postgres')));

await post('/integration/mongoose');
await post('/integration/redis');
await post('/integration/rabbitmq');
await post('/integration/http');

const fullFlow = await post('/integration/full-flow', { amount: 125, currency: 'USD' });
const paymentId = fullFlow.payment?.id;
assert(typeof paymentId === 'string', 'full flow did not return a payment ID');
await waitForPaymentStatus(paymentId, 'settled');
await get('/players/integration-player');
const cachedPlayer = await get('/players/integration-player');
assert(cachedPlayer.source === 'redis', 'second player lookup was not served from Redis');

await expectStatus('/integration/http?fail=true', 502);
for (const failAt of ['business', 'redis', 'postgres', 'mongodb', 'rabbitmq']) {
  await expectStatus('/integration/full-flow', 500, {
    amount: 125,
    currency: 'USD',
    failAt,
  });
}
await expectStatus('/integration/full-flow', 502, {
  amount: 125,
  currency: 'USD',
  failAt: 'http',
});
await post('/integration/full-flow', {
  amount: 125,
  currency: 'USD',
  failAt: 'worker',
});

const snapshot = await waitForCompleteTopology();
await assertGoCollectorMetrics();
const spans = snapshot.traces.flatMap((trace) => flatten(trace.spans));
const nodeSummary = snapshot.nodes.map((node) => `${node.type}:${node.name}`);

for (const expected of [
  ['http-route', 'POST /integration/full-flow'],
  ['controller', 'IntegrationController'],
  ['service', 'IntegrationService'],
  ['service', 'PaymentWorker'],
  ['service', 'AuditListener'],
  ['database', 'PostgreSQL'],
  ['database', 'MongoDB'],
  ['redis', 'Redis'],
  ['queue', 'RabbitMQ'],
]) {
  assert(
    snapshot.nodes.some((node) => node.type === expected[0] && node.name === expected[1]),
    `missing topology node ${expected.join(': ')}\nObserved: ${nodeSummary.join(', ')}`,
  );
}
assert(
  snapshot.nodes.some((node) => node.type === 'external-http'),
  `missing external HTTP topology node\nObserved: ${nodeSummary.join(', ')}`,
);

for (const [type, name] of [
  ['database', 'PostgreSQL'],
  ['database', 'MongoDB'],
  ['redis', 'Redis'],
  ['queue', 'RabbitMQ'],
]) {
  const matches = snapshot.nodes.filter((node) => node.type === type && node.name === name);
  assert(matches.length === 1, `expected one stable ${name} node, received ${matches.length}`);
}
assert(
  !snapshot.nodes.some((node) => node.type === 'database' && node.name === 'Mongoose'),
  'Mongoose and MongoDB created duplicate architecture nodes',
);
for (const frameworkProvider of ['EventSubscribersLoader', 'useFactory']) {
  assert(
    !snapshot.nodes.some((node) => node.name === frameworkProvider),
    `framework provider leaked into the main topology: ${frameworkProvider}`,
  );
}
const postgresNode = snapshot.nodes.find(
  (node) => node.type === 'database' && node.name === 'PostgreSQL',
);
assert(
  postgresNode.requestCount >= 400,
  `100 transactions did not aggregate into the PostgreSQL node (${postgresNode.requestCount} spans)`,
);

assertOperations(spans, [
  ['PostgreSQL BEGIN', (span) => span.name.startsWith('pg.query:BEGIN')],
  ['PostgreSQL INSERT', (span) => span.name.startsWith('pg.query:INSERT')],
  ['PostgreSQL SELECT', (span) => span.name.startsWith('pg.query:SELECT')],
  ['PostgreSQL UPDATE', (span) => span.name.startsWith('pg.query:UPDATE')],
  ['PostgreSQL COMMIT', (span) => span.name.startsWith('pg.query:COMMIT')],
  ['Mongoose find', named('mongoose.PaymentAudit.find')],
  ['Mongoose findOne/findById', named('mongoose.PaymentAudit.findOne')],
  ['Mongoose create/save', named('mongoose.PaymentAudit.save')],
  ['Mongoose updateOne', named('mongoose.PaymentAudit.updateOne')],
  ['Mongoose findOneAndUpdate', named('mongoose.PaymentAudit.findOneAndUpdate')],
  ['Mongoose deleteOne', named('mongoose.PaymentAudit.deleteOne')],
  ['Mongoose aggregate', named('mongoose.PaymentAudit.aggregate')],
  ['Redis GET', named('redis-GET')],
  ['Redis SET', named('redis-SET')],
  ['Redis DEL', named('redis-DEL')],
  ['Redis INCR', named('redis-INCR')],
  ['Redis MGET', named('redis-MGET')],
  ['Redis EXPIRE', named('redis-EXPIRE')],
  ['Redis TTL', named('redis-TTL')],
  ['RabbitMQ publish', (span) => span.name.startsWith('publish nodeflow.payments')],
  ['RabbitMQ payments.created consumer', named('payments.created process')],
  ['RabbitMQ payments.settled consumer', named('payments.settled process')],
  ['outgoing HTTP', (span) => span.kind === 'external-http'],
  ['Nest local-event handler', named('AuditListener.handlePaymentCreated')],
]);

assert(
  snapshot.traces.some((trace) => trace.status === 'error'),
  'no failed trace was recorded',
);
assert(
  spans.some(
    (span) => span.status === 'error' && span.name === 'mongodb.nodeflowInvalidWorkerCommand',
  ),
  'RabbitMQ worker nack scenario did not retain its MongoDB failure span',
);

const successfulFullTrace = snapshot.traces.find((trace) => {
  const traceSpans = flatten(trace.spans);
  return (
    trace.status === 'ok' &&
    traceSpans.some(isFullFlowRoute) &&
    traceSpans.some(named('PaymentWorker.processCreatedMessage'))
  );
});
assert(successfulFullTrace, 'no correlated successful API-to-worker full-flow trace was retained');
const fullTraceSpans = flatten(successfulFullTrace.spans);
for (const expected of [
  ['controller', (span) => span.name.includes('IntegrationController.fullFlow')],
  ['service', (span) => span.name.includes('IntegrationService.fullFlow')],
  ['PostgreSQL', (span) => span.kind === 'database' && span.name.startsWith('pg.query:INSERT')],
  ['MongoDB/Mongoose', (span) => span.kind === 'database' && span.name.includes('PaymentAudit')],
  ['Redis', (span) => span.kind === 'redis'],
  ['outgoing HTTP', (span) => span.kind === 'external-http'],
  ['RabbitMQ', (span) => span.kind === 'queue'],
  ['worker', named('PaymentWorker.processCreatedMessage')],
]) {
  assert(
    fullTraceSpans.some(expected[1]),
    `successful full-flow trace does not include ${expected[0]}`,
  );
}

console.log(`Validated ${snapshot.nodes.length} stable topology nodes and 100 transactions.`);
console.log(`Validated ${snapshot.traces.length} recent traces with operation-level detail.`);
console.log(
  'Real PostgreSQL, MongoDB/Mongoose, Redis, RabbitMQ, HTTP, local-event, worker, and deterministic error flows passed.',
);
console.log('TypeScript instrumentation → Protobuf → Go collector/topology passed.');

async function post(path, body = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await readBody(response);
  assert(response.ok, `${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function get(path) {
  const response = await fetch(`${apiUrl}${path}`);
  const payload = await readBody(response);
  assert(response.ok, `${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function expectStatus(path, status, body = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await response.arrayBuffer();
  assert(response.status === status, `${path} returned ${response.status}; expected ${status}`);
}

async function waitForCompleteTopology() {
  let latest;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const response = await fetch(`${collectorUrl}/api/snapshot`);
    latest = await response.json();
    const names = new Set(latest.nodes.map((node) => node.name));
    const currentSpans = latest.traces.flatMap((trace) => flatten(trace.spans));
    if (
      names.has('PostgreSQL') &&
      names.has('MongoDB') &&
      names.has('Redis') &&
      names.has('RabbitMQ') &&
      names.has('POST /integration/full-flow') &&
      latest.nodes.some((node) => node.type === 'external-http') &&
      currentSpans.some(
        (span) => span.status === 'error' && span.name === 'mongodb.nodeflowInvalidWorkerCommand',
      )
    )
      return latest;
    await delay(500);
  }
  throw new Error(`topology did not converge: ${JSON.stringify(latest?.nodes ?? [])}`);
}

async function waitForPaymentStatus(paymentId, expectedStatus) {
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    const payment = await get(`/payments/${paymentId}`);
    if (payment.status === expectedStatus) {
      await delay(500);
      return;
    }
    await delay(250);
  }
  throw new Error(`payment ${paymentId} did not reach ${expectedStatus}`);
}

async function waitFor(url, name) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await delay(1_000);
  }
  throw new Error(`${name} did not become ready`);
}

async function readBody(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function flatten(spans) {
  return spans.flatMap((span) => [span, ...flatten(span.children)]);
}

function isFullFlowRoute(span) {
  return span.kind === 'http-route' && span.name.includes('/integration/full-flow');
}

function named(name) {
  return (span) => span.name === name;
}

function assertOperations(spans, expectations) {
  for (const [label, predicate] of expectations) {
    assert(spans.some(predicate), `missing trace operation: ${label}`);
  }
}

async function assertAutomaticInstrumentationSources() {
  for (const sourcePath of [
    'apps/integration-api/src/integration.service.ts',
    'apps/integration-worker/src/payment.worker.ts',
  ]) {
    const source = await readFile(sourcePath, 'utf8');
    for (const forbidden of ['traceBoundary(', 'nodeflow.span(', '/src/']) {
      assert(!source.includes(forbidden), `${sourcePath} contains forbidden ${forbidden}`);
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertGoCollectorMetrics() {
  let observed;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${goCollectorUrl}/metrics`);
    assert(response.ok, `Go collector metrics returned ${response.status}`);
    const metrics = await response.text();
    const snapshotResponse = await fetch(`${collectorUrl}/api/snapshot`);
    assert(snapshotResponse.ok, `topology snapshot returned ${snapshotResponse.status}`);
    const currentSnapshot = await snapshotResponse.json();
    const value = (name) => {
      const match = metrics.match(new RegExp(`^${name} ([0-9.eE+-]+)$`, 'm'));
      return match ? Number(match[1]) : undefined;
    };
    observed = {
      received: value('nodeflow_collector_telemetry_received_total'),
      processed: value('nodeflow_collector_telemetry_processed_total'),
      nodes: value('nodeflow_collector_topology_nodes'),
      edges: value('nodeflow_collector_topology_edges'),
    };
    if (
      (observed.received ?? 0) > 0 &&
      (observed.processed ?? 0) > 0 &&
      observed.nodes === currentSnapshot.nodes.length &&
      observed.edges === currentSnapshot.edges.length
    ) {
      return;
    }
    await delay(250);
  }
  throw new Error(
    `Go collector metrics did not converge with topology: ${JSON.stringify(observed)}`,
  );
}
