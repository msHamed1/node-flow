import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

type RuntimeProcess = ChildProcessByStdio<null, Readable, Readable>;

const require = createRequire(import.meta.url);
const startupProtocolVersion = 1;
const supportedRuntimePackages: Readonly<Record<string, string>> = {
  'darwin-arm64': '@mshamed1/node-flow-collector-darwin-arm64',
  'darwin-x64': '@mshamed1/node-flow-collector-darwin-x64',
  'linux-arm64': '@mshamed1/node-flow-collector-linux-arm64',
  'linux-x64': '@mshamed1/node-flow-collector-linux-x64',
  'win32-x64': '@mshamed1/node-flow-collector-win32-x64',
};

interface RuntimeManifest {
  name?: string;
  version?: string;
  os?: string[];
  cpu?: string[];
  nodeflowRuntime?: { protocolVersion?: number; binary?: string };
}

interface RuntimeReadyEvent {
  type: 'nodeflow.runtime.ready';
  protocolVersion: number;
  address: string;
  url: string;
  runtimeVersion: string;
  pid: number;
}

export interface RuntimeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RunningRuntime {
  url: string;
  runtimeVersion: string;
  pid: number;
  exit: Promise<RuntimeExit>;
  close(signal?: NodeJS.Signals): Promise<void>;
}

export interface RuntimeOptions {
  host?: string;
  port?: number;
  dashboardDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export class RuntimeLaunchError extends Error {
  constructor(
    readonly code:
      | 'UNSUPPORTED_PLATFORM'
      | 'MISSING_PACKAGE'
      | 'INVALID_PACKAGE'
      | 'VERSION_MISMATCH'
      | 'BINARY_PERMISSION'
      | 'STARTUP_FAILED'
      | 'STARTUP_TIMEOUT',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeLaunchError';
  }
}

export async function startGoRuntime(options: RuntimeOptions = {}): Promise<RunningRuntime> {
  const environment = options.environment ?? process.env;
  const topologyEngine = environment.NODEFLOW_TOPOLOGY_ENGINE?.trim().toLowerCase();
  if (topologyEngine && topologyEngine !== 'go') {
    throw new RuntimeLaunchError(
      'STARTUP_FAILED',
      `The portable CLI starts the Go-authoritative runtime and cannot use NODEFLOW_TOPOLOGY_ENGINE=${environment.NODEFLOW_TOPOLOGY_ENGINE}. Use the documented Docker Compose typescript-rollback profile for an explicit TypeScript rollback.`,
    );
  }
  const runtime = resolveRuntimeBinary();
  const timeoutMs = positiveInteger(environment.NODEFLOW_STARTUP_TIMEOUT_MS, 15_000);
  const stopTimeoutMs = positiveInteger(environment.NODEFLOW_RUNTIME_STOP_TIMEOUT_MS, 10_000);
  const host = options.host ?? environment.NODEFLOW_HOST ?? '127.0.0.1';
  const port = options.port ?? parsePort(environment.NODEFLOW_PORT ?? '7331');
  const child = spawn(runtime.binary, [], {
    cwd: process.cwd(),
    env: {
      ...environment,
      NODEFLOW_GO_LISTEN_ADDR: listenAddress(host, port),
      NODEFLOW_TOPOLOGY_ENGINE: 'go',
      NODEFLOW_STARTUP_PROTOCOL: 'json-v1',
      ...(options.dashboardDirectory ? { NODEFLOW_DASHBOARD_DIR: options.dashboardDirectory } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr.pipe(options.stderr ?? process.stderr, { end: false });
  const exit = processExit(child);
  const startupStartedAt = Date.now();

  let ready: RuntimeReadyEvent;
  try {
    ready = await waitForStartupEvent(
      child,
      runtime.version,
      timeoutMs,
      options.stdout ?? process.stdout,
    );
    if (ready.pid !== child.pid) {
      throw new RuntimeLaunchError(
        'STARTUP_FAILED',
        `Go runtime readiness event reported PID ${ready.pid}; expected ${child.pid ?? 'unknown'}.`,
      );
    }
    const remainingTimeoutMs = timeoutMs - (Date.now() - startupStartedAt);
    if (remainingTimeoutMs <= 0) {
      throw new RuntimeLaunchError(
        'STARTUP_TIMEOUT',
        `NodeFlow Go runtime did not become healthy within ${timeoutMs}ms.`,
      );
    }
    await waitForReadiness(ready.url, child, remainingTimeoutMs);
  } catch (error) {
    await stopProcess(child, exit, 'SIGTERM', stopTimeoutMs);
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    url: ready.url,
    runtimeVersion: ready.runtimeVersion,
    pid: ready.pid,
    exit,
    close(signal = 'SIGTERM') {
      closePromise ??= stopProcess(child, exit, signal, stopTimeoutMs);
      return closePromise;
    },
  };
}

export function runtimePackageForHost(
  platform = process.platform,
  architecture = process.arch,
): string {
  const target = `${platform}-${architecture}`;
  const packageName = supportedRuntimePackages[target];
  if (!packageName) {
    throw new RuntimeLaunchError(
      'UNSUPPORTED_PLATFORM',
      `NodeFlow does not publish a Go runtime for ${target}. Supported targets: ${Object.keys(supportedRuntimePackages).join(', ')}.`,
    );
  }
  return packageName;
}

function resolveRuntimeBinary(): { binary: string; version: string } {
  const packageName = runtimePackageForHost();
  let manifestPath: string;
  try {
    manifestPath = require.resolve(`${packageName}/package.json`);
  } catch (error) {
    throw new RuntimeLaunchError(
      'MISSING_PACKAGE',
      `The optional runtime package ${packageName} is missing. Reinstall @mshamed1/node-flow with optional dependencies enabled for ${process.platform}-${process.arch}.`,
      { cause: error },
    );
  }

  const cliManifest = readManifest(new URL('../package.json', import.meta.url));
  const manifest = readManifest(manifestPath);
  const metadata = manifest.nodeflowRuntime;
  if (
    manifest.name !== packageName ||
    manifest.os?.[0] !== process.platform ||
    manifest.cpu?.[0] !== process.arch ||
    metadata?.protocolVersion !== startupProtocolVersion ||
    typeof metadata.binary !== 'string'
  ) {
    throw new RuntimeLaunchError(
      'INVALID_PACKAGE',
      `${packageName} has invalid runtime metadata; reinstall NodeFlow from a trusted registry.`,
    );
  }
  if (manifest.version !== cliManifest.version) {
    throw new RuntimeLaunchError(
      'VERSION_MISMATCH',
      `NodeFlow CLI ${cliManifest.version ?? 'unknown'} requires ${packageName}@${cliManifest.version}, but ${manifest.version ?? 'unknown'} is installed.`,
    );
  }

  const packageDirectory = resolve(manifestPath, '..');
  const binary = resolve(packageDirectory, metadata.binary);
  const pathFromPackage = relative(packageDirectory, binary);
  if (pathFromPackage.startsWith('..') || isAbsolute(pathFromPackage) || !existsSync(binary)) {
    throw new RuntimeLaunchError(
      'INVALID_PACKAGE',
      `${packageName} does not contain its declared runtime binary ${metadata.binary}.`,
    );
  }
  ensureExecutable(binary, packageName);
  return { binary, version: manifest.version! };
}

function ensureExecutable(binary: string, packageName: string): void {
  if (process.platform === 'win32') return;
  try {
    accessSync(binary, constants.X_OK);
  } catch {
    try {
      chmodSync(binary, 0o755);
      accessSync(binary, constants.X_OK);
    } catch (error) {
      throw new RuntimeLaunchError(
        'BINARY_PERMISSION',
        `${packageName} is installed, but its runtime binary is not executable: ${binary}`,
        { cause: error },
      );
    }
  }
}

function waitForStartupEvent(
  child: RuntimeProcess,
  expectedVersion: string,
  timeoutMs: number,
  output: NodeJS.WritableStream,
): Promise<RuntimeReadyEvent> {
  return new Promise((resolveReady, rejectReady) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      cleanup();
      rejectReady(
        new RuntimeLaunchError(
          'STARTUP_TIMEOUT',
          `NodeFlow Go runtime did not report readiness within ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);
    const onError = (error: Error): void => {
      cleanup();
      rejectReady(
        new RuntimeLaunchError(
          'STARTUP_FAILED',
          `Unable to start NodeFlow Go runtime: ${error.message}`,
          {
            cause: error,
          },
        ),
      );
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      rejectReady(
        new RuntimeLaunchError(
          'STARTUP_FAILED',
          `NodeFlow Go runtime exited before readiness (${code ?? signal ?? 'unknown'}).`,
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
    };

    child.once('error', onError);
    child.once('exit', onExit);
    lines.on('line', (line) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        output.write(`${line}\n`);
        return;
      }
      if (!isReadyEvent(value)) {
        output.write(`${line}\n`);
        return;
      }
      if (value.protocolVersion !== startupProtocolVersion) {
        cleanup();
        lines.close();
        rejectReady(
          new RuntimeLaunchError(
            'STARTUP_FAILED',
            `Unsupported Go runtime startup protocol ${value.protocolVersion}; expected ${startupProtocolVersion}.`,
          ),
        );
        return;
      }
      if (value.runtimeVersion !== expectedVersion) {
        cleanup();
        lines.close();
        rejectReady(
          new RuntimeLaunchError(
            'VERSION_MISMATCH',
            `Runtime reported version ${value.runtimeVersion}; expected ${expectedVersion}.`,
          ),
        );
        return;
      }
      cleanup();
      resolveReady(value);
    });
  });
}

async function waitForReadiness(
  runtimeUrl: string,
  child: RuntimeProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new RuntimeLaunchError(
        'STARTUP_FAILED',
        'NodeFlow Go runtime exited before its readiness endpoint became available.',
      );
    }
    try {
      const response = await fetch(`${runtimeUrl}/readyz`, {
        signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - Date.now()))),
      });
      if (response.ok) return;
    } catch {
      // The bound listener may need a brief scheduling turn before accepting requests.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new RuntimeLaunchError(
    'STARTUP_TIMEOUT',
    `NodeFlow Go runtime at ${runtimeUrl} did not become healthy within ${timeoutMs}ms.`,
  );
}

function processExit(child: RuntimeProcess): Promise<RuntimeExit> {
  return new Promise((resolveExit) => {
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

async function stopProcess(
  child: RuntimeProcess,
  exit: Promise<RuntimeExit>,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  let timer: NodeJS.Timeout | undefined;
  let exited = false;
  await Promise.race([
    exit.then(() => {
      exited = true;
    }),
    new Promise<void>((resolveTimeout) => {
      timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolveTimeout();
      }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!exited) {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exit;
  }
}

function isReadyEvent(value: unknown): value is RuntimeReadyEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<RuntimeReadyEvent>;
  return (
    event.type === 'nodeflow.runtime.ready' &&
    typeof event.protocolVersion === 'number' &&
    typeof event.address === 'string' &&
    typeof event.url === 'string' &&
    typeof event.runtimeVersion === 'string' &&
    typeof event.pid === 'number'
  );
}

function listenAddress(host: string, port: number): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]:${port}` : `${host}:${port}`;
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RuntimeLaunchError(
      'STARTUP_FAILED',
      `NODEFLOW_PORT must be an integer from 0 to 65535; received ${raw}.`,
    );
  }
  return port;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new RuntimeLaunchError(
      'STARTUP_FAILED',
      `Expected a positive integer duration in milliseconds; received ${raw}.`,
    );
  }
  return value;
}

function readManifest(location: string | URL): RuntimeManifest {
  try {
    return JSON.parse(readFileSync(location, 'utf8')) as RuntimeManifest;
  } catch (error) {
    throw new RuntimeLaunchError(
      'INVALID_PACKAGE',
      `Unable to read package metadata from ${String(location)}.`,
      { cause: error },
    );
  }
}
