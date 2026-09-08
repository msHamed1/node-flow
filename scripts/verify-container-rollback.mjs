import { spawnSync } from 'node:child_process';

const [currentImage, previousImage] = process.argv.slice(2);
for (const [label, image] of [
  ['current', currentImage],
  ['previous', previousImage],
]) {
  if (!image || !/@sha256:[a-f0-9]{64}$/i.test(image)) {
    throw new Error(
      `${label} image must be an immutable registry reference ending in @sha256:<digest>`,
    );
  }
}

const suffix = `${Date.now()}-${process.pid}`;
const volume = `nodeflow-rollback-${suffix}`;
const currentContainer = `nodeflow-current-${suffix}`;
const previousContainer = `nodeflow-previous-${suffix}`;

try {
  docker('volume', 'create', volume);
  await verifyImage(currentImage, currentContainer, 'before-rollback', false);
  await verifyImage(previousImage, previousContainer, 'after-rollback', true);
  console.log('Collector rollback preserved topology state and accepted new writes.');
} finally {
  removeContainer(currentContainer);
  removeContainer(previousContainer);
  dockerAllowFailure('volume', 'rm', volume);
}

async function verifyImage(image, name, serviceName, expectExistingState) {
  docker(
    'run',
    '--detach',
    '--name',
    name,
    '--publish',
    '127.0.0.1::4318',
    '--volume',
    `${volume}:/var/lib/nodeflow`,
    '--env',
    'NODEFLOW_GO_LISTEN_ADDR=0.0.0.0:4318',
    '--env',
    'NODEFLOW_SPOOL_MODE=group-commit',
    '--env',
    'NODEFLOW_SPOOL_DIR=/var/lib/nodeflow/spool',
    '--env',
    'NODEFLOW_TOPOLOGY_STATE_PATH=/var/lib/nodeflow/topology-state.json',
    image,
  );
  const address = docker('port', name, '4318/tcp').trim();
  const url = `http://${address}`;
  await waitForReady(url, name);
  if (expectExistingState) {
    const restored = await getJson(`${url}/api/architecture`);
    if (!JSON.stringify(restored).includes('before-rollback')) {
      throw new Error('previous image did not restore topology written by the current image');
    }
  }
  const response = await fetch(`${url}/api/spans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      serviceName,
      spans: [
        {
          traceId: `${serviceName}-trace`,
          spanId: `${serviceName}-span`,
          name: 'rollback verification',
          kind: 'service',
          startTimeUnixMs: Date.now(),
          durationMs: 1,
          status: 'ok',
        },
      ],
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== 202) {
    throw new Error(`${name} rejected rollback verification data with ${response.status}`);
  }
  const snapshot = await getJson(`${url}/api/architecture`);
  if (!JSON.stringify(snapshot).includes(serviceName)) {
    throw new Error(`${name} did not persist ${serviceName}`);
  }
  docker('stop', '--time', '20', name);
  docker('rm', name);
}

async function waitForReady(url, name) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // Container startup is still in progress.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  const logs = dockerAllowFailure('logs', name);
  throw new Error(`${name} did not become ready\n${logs}`);
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function removeContainer(name) {
  dockerAllowFailure('rm', '--force', name);
}

function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      [`docker ${args.join(' ')} failed`, result.stdout.trim(), result.stderr.trim()]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return result.stdout;
}

function dockerAllowFailure(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  return result.stdout || result.stderr;
}
