import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGoRuntime } from '../cli/dist/runtime-launcher.js';

const fixture = mkdtempSync(join(tmpdir(), 'nodeflow-launcher-smoke-'));
const dashboard = join(fixture, 'dashboard');
mkdirSync(dashboard);
writeFileSync(
  join(dashboard, 'index.html'),
  '<!doctype html><title>NodeFlow runtime smoke</title>',
);

const runtime = await startGoRuntime({
  host: '127.0.0.1',
  port: 0,
  dashboardDirectory: dashboard,
  environment: {
    ...process.env,
    NODEFLOW_SPOOL_MODE: 'memory',
    NODEFLOW_TOPOLOGY_STATE_PATH: join(fixture, 'topology-state.json'),
    NODEFLOW_STARTUP_TIMEOUT_MS: '15000',
  },
});

try {
  const health = await fetch(`${runtime.url}/api/health`, {
    signal: AbortSignal.timeout(5_000),
  });
  const payload = await health.json();
  if (!health.ok || payload.language !== 'go' || payload.topologyEngine !== 'go') {
    throw new Error(`unexpected launcher health response: ${JSON.stringify(payload)}`);
  }
  const page = await fetch(runtime.url, { signal: AbortSignal.timeout(5_000) });
  if (!page.ok || !(await page.text()).includes('NodeFlow runtime smoke')) {
    throw new Error('launcher runtime did not serve the configured dashboard');
  }
  console.log(
    `Launcher verified ${runtime.runtimeVersion} on ${process.platform}-${process.arch} at ${runtime.url}`,
  );
} finally {
  await runtime.close();
  await runtime.exit;
  rmSync(fixture, { recursive: true, force: true });
}
