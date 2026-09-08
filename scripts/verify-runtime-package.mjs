import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimePackageFor, runtimeProtocolVersion } from './runtime-packages.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = runtimePackageFor(process.platform, process.arch);
if (!target) throw new Error(`unsupported verification host ${process.platform}-${process.arch}`);
const manifest = JSON.parse(readFileSync(resolve(root, target.directory, 'package.json'), 'utf8'));
const binary = resolve(root, target.directory, manifest.nodeflowRuntime.binary);
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true });
if (version.status !== 0 || version.stdout.trim() !== manifest.version) {
  throw new Error(
    `${target.packageName} reported version ${version.stdout.trim() || version.stderr.trim() || 'unknown'}`,
  );
}
const fixture = mkdtempSync(join(tmpdir(), 'nodeflow-runtime-check-'));
const child = spawn(binary, [], {
  cwd: fixture,
  env: {
    ...process.env,
    NODEFLOW_GO_LISTEN_ADDR: '127.0.0.1:0',
    NODEFLOW_SPOOL_MODE: 'memory',
    NODEFLOW_TOPOLOGY_STATE_PATH: join(fixture, 'topology-state.json'),
    NODEFLOW_STARTUP_PROTOCOL: 'json-v1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => (stderr += chunk));

try {
  const event = await startupEvent(child, 10_000);
  if (event.protocolVersion !== runtimeProtocolVersion) {
    throw new Error(`unexpected startup protocol ${event.protocolVersion}`);
  }
  if (event.runtimeVersion !== manifest.version) {
    throw new Error(`runtime ${event.runtimeVersion} does not match package ${manifest.version}`);
  }
  const ready = await fetch(`${event.url}/readyz`, { signal: AbortSignal.timeout(5_000) });
  if (!ready.ok) throw new Error(`runtime readiness returned ${ready.status}`);
  const health = await fetch(`${event.url}/api/health`, { signal: AbortSignal.timeout(5_000) });
  const healthPayload = await health.json();
  if (!health.ok || healthPayload.language !== 'go' || healthPayload.topologyEngine !== 'go') {
    throw new Error(`unexpected runtime health ${JSON.stringify(healthPayload)}`);
  }
  console.log(
    `Verified ${target.packageName}@${manifest.version} on ${process.platform}-${process.arch} at ${event.url}`,
  );
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise((resolveExit) => {
    if (child.exitCode !== null) resolveExit();
    else child.once('exit', resolveExit);
  });
  rmSync(fixture, { recursive: true, force: true });
}

function startupEvent(runtime, timeoutMs) {
  return new Promise((resolveEvent, rejectEvent) => {
    const lines = createInterface({ input: runtime.stdout });
    const timeout = setTimeout(() => {
      lines.close();
      rejectEvent(
        new Error(`runtime startup timed out after ${timeoutMs}ms${stderr ? `: ${stderr}` : ''}`),
      );
    }, timeoutMs);
    const finish = (callback) => {
      clearTimeout(timeout);
      lines.close();
      callback();
    };
    lines.on('line', (line) => {
      try {
        const event = JSON.parse(line);
        if (event?.type === 'nodeflow.runtime.ready') finish(() => resolveEvent(event));
      } catch {
        // Normal structured logs are not part of the startup control protocol.
      }
    });
    runtime.once('error', (error) => finish(() => rejectEvent(error)));
    runtime.once('exit', (code, signal) => {
      finish(() =>
        rejectEvent(
          new Error(
            `runtime exited before readiness (${code ?? signal})${stderr ? `: ${stderr.trim()}` : ''}`,
          ),
        ),
      );
    });
  });
}
