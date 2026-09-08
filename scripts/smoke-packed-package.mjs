import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishedPackages } from './release-packages.mjs';
import { runtimePackageFor } from './runtime-packages.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = mkdtempSync(join(tmpdir(), 'node-flow-package-smoke-'));
const packsDirectory = join(fixture, 'packs');
const consumerDirectory = join(fixture, 'consumer');
const fakeToolsDirectory = join(fixture, 'no-go-toolchain');
const currentRuntime = runtimePackageFor(process.platform, process.arch);
if (!currentRuntime) {
  throw new Error(`packed runtime smoke test does not support ${process.platform}-${process.arch}`);
}
mkdirSync(packsDirectory);
mkdirSync(consumerDirectory);
mkdirSync(fakeToolsDirectory);

const baseEnvironment = {
  ...process.env,
  npm_config_cache: join(fixture, '.npm-cache'),
  PATH: `${fakeToolsDirectory}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    env: { ...baseEnvironment, ...options.env },
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(' ')} failed with status ${result.status}`,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return result.stdout.trim();
};

try {
  installFailingGoShim();
  const tarballs = new Map();
  for (const releasePackage of publishedPackages) {
    const output = run('npm', ['pack', '--json', '--pack-destination', packsDirectory], {
      cwd: resolve(root, releasePackage.directory),
    });
    const packed = JSON.parse(output)[0];
    tarballs.set(releasePackage.name, join(packsDirectory, packed.filename));
    console.log(`Packed ${releasePackage.name} as ${packed.filename}`);
  }

  writeFileSync(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ name: 'node-flow-packed-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );
  const installableTarballs = publishedPackages
    .filter(
      (releasePackage) =>
        releasePackage.name !== '@mshamed1/node-flow-collector' &&
        (!releasePackage.runtimeTarget || releasePackage.name === currentRuntime.packageName),
    )
    .map((releasePackage) => tarballs.get(releasePackage.name));
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '@nestjs/common@^11.1.0',
      '@nestjs/core@^11.1.0',
      'reflect-metadata@^0.2.2',
      'rxjs@^7.8.2',
      ...installableTarballs,
    ],
    { cwd: consumerDirectory, timeout: 120_000 },
  );

  writeFileSync(
    join(consumerDirectory, 'consumer.mjs'),
    [
      "import { nodeflow, traceBoundary } from '@mshamed1/node-flow';",
      "import { NodeFlowModule } from '@mshamed1/node-flow/nestjs';",
      '',
      "if (typeof nodeflow.span !== 'function') throw new Error('nodeflow.span export is missing');",
      "if (typeof traceBoundary !== 'function') throw new Error('traceBoundary export is missing');",
      "if (typeof NodeFlowModule !== 'function') throw new Error('NodeFlowModule export is missing');",
      "console.log('NodeFlow imports are usable');",
      '',
    ].join('\n'),
  );

  const importOutput = run('node', ['consumer.mjs'], { cwd: consumerDirectory });
  if (!importOutput.includes('NodeFlow imports are usable')) {
    throw new Error(`unexpected consumer output: ${importOutput}`);
  }

  const binary = join(consumerDirectory, 'node_modules', '.bin', 'node-flow');
  const helpOutput = run(binary, ['--help'], { cwd: consumerDirectory });
  if (!helpOutput.includes('Usage: node-flow dev -- <command> [args...]')) {
    throw new Error(`unexpected CLI help output: ${helpOutput}`);
  }

  const runtimeUrl = await smokeCollector(binary);
  smokeDev(binary);
  smokeApplicationCrash(binary);
  smokeRuntimeCrash(binary);

  const installed = JSON.parse(
    readFileSync(
      join(consumerDirectory, 'node_modules', '@mshamed1', 'node-flow', 'package.json'),
      'utf8',
    ),
  );
  const oldCollector = join(consumerDirectory, 'node_modules', '@mshamed1', 'node-flow-collector');
  try {
    readFileSync(join(oldCollector, 'package.json'));
    throw new Error('the TypeScript collector was installed by the normal CLI dependency graph');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  console.log(
    `Installed ${installed.name}@${installed.version} with ${currentRuntime.packageName} from ${basename(tarballs.get(currentRuntime.packageName))}.`,
  );
  console.log(`Packed collector and dev commands used the Go runtime at ${runtimeUrl}.`);
  console.log(
    'No repository, Go toolchain, workspace links, or global node-flow install was used.',
  );
} finally {
  if (process.env.NODEFLOW_KEEP_SMOKE_FIXTURE === '1') {
    console.log(`Kept smoke fixture at ${fixture}`);
  } else {
    rmSync(fixture, { recursive: true, force: true });
  }
}

async function smokeCollector(binary) {
  const statePath = join(fixture, 'collector-state.json');
  const child = spawn(binary, ['collector'], {
    cwd: consumerDirectory,
    env: runtimeEnvironment(statePath),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  try {
    const url = await waitForCollectorUrl(
      child,
      () => stdout,
      () => stderr,
    );
    const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5_000) });
    const payload = await health.json();
    if (!health.ok || payload.language !== 'go' || payload.topologyEngine !== 'go') {
      throw new Error(`unexpected packed collector health: ${JSON.stringify(payload)}`);
    }
    const dashboard = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!dashboard.ok || !(await dashboard.text()).includes('<!doctype html>')) {
      throw new Error('packed Go collector did not serve the installed dashboard');
    }
    return url;
  } finally {
    if (child.exitCode === null) child.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
    const result = await waitForExit(child, 15_000, stdout, stderr);
    if (result.code !== 0) {
      throw new Error(`packed collector signal shutdown returned ${result.code ?? result.signal}`);
    }
  }
}

function smokeDev(binary) {
  const childScript = [
    'const url = process.env.NODEFLOW_COLLECTOR_URL',
    "const health = await fetch(url + '/api/health').then((response) => response.json())",
    'const dashboard = await fetch(url).then((response) => response.text())',
    "if (health.language !== 'go' || health.topologyEngine !== 'go') throw new Error(JSON.stringify(health))",
    "if (!dashboard.includes('<!doctype html>')) throw new Error('dashboard missing')",
    "console.log('PACKED_DEV_OK=' + url + ':' + process.env.NODEFLOW_EXPORT_PROTOCOL)",
    'process.exit(0)',
  ].join(';');
  const output = run(
    binary,
    ['dev', '--', process.execPath, '--input-type=module', '-e', childScript],
    {
      cwd: consumerDirectory,
      timeout: 30_000,
      env: runtimeEnvironment(join(fixture, 'dev-state.json')),
    },
  );
  if (!/PACKED_DEV_OK=http:\/\/127\.0\.0\.1:\d+:protobuf/.test(output)) {
    throw new Error(`packed node-flow dev did not use the ready Go runtime: ${output}`);
  }
}

function smokeApplicationCrash(binary) {
  const result = runWithStatus(
    binary,
    ['dev', '--', process.execPath, '-e', 'process.exit(23)'],
    runtimeEnvironment(join(fixture, 'application-crash-state.json')),
  );
  if (result.status !== 23) {
    throw new Error(
      `node-flow dev did not preserve application failure status 23\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function smokeRuntimeCrash(binary) {
  const childScript = [
    'const runtimePid = Number(process.env.NODEFLOW_RUNTIME_PID)',
    "if (!runtimePid) throw new Error('runtime PID missing')",
    "process.kill(runtimePid, 'SIGKILL')",
    'setInterval(() => undefined, 1000)',
  ].join(';');
  const result = runWithStatus(
    binary,
    ['dev', '--', process.execPath, '-e', childScript],
    runtimeEnvironment(join(fixture, 'runtime-crash-state.json')),
  );
  if (result.status === 0 || !result.stderr.includes('runtime stopped while the application')) {
    throw new Error(
      `node-flow dev did not fail and stop its application after a runtime crash\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function runWithStatus(binary, args, environment) {
  return spawnSync(binary, args, {
    cwd: consumerDirectory,
    encoding: 'utf8',
    timeout: 30_000,
    env: environment,
  });
}

function runtimeEnvironment(statePath) {
  return {
    ...baseEnvironment,
    NODEFLOW_PORT: '0',
    NODEFLOW_SPOOL_MODE: 'memory',
    NODEFLOW_TOPOLOGY_STATE_PATH: statePath,
    NODEFLOW_STARTUP_TIMEOUT_MS: '15000',
  };
}

function waitForCollectorUrl(child, stdout, stderr) {
  return new Promise((resolveUrl, rejectUrl) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectUrl(new Error(`packed collector startup timed out\n${stdout()}\n${stderr()}`));
    }, 15_000);
    const inspect = () => {
      const match = stdout().match(/NodeFlow collector and dashboard: (http:\/\/[^\s]+)/);
      if (match) {
        cleanup();
        resolveUrl(match[1]);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectUrl(
        new Error(
          `packed collector exited before startup (${code ?? signal})\n${stdout()}\n${stderr()}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', inspect);
      child.off('exit', onExit);
    };
    child.stdout.on('data', inspect);
    child.once('exit', onExit);
    inspect();
  });
}

function waitForExit(child, timeoutMs, stdout, stderr) {
  if (child.exitCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      rejectExit(new Error(`packed collector did not stop\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
}

function installFailingGoShim() {
  if (process.platform === 'win32') {
    writeFileSync(join(fakeToolsDirectory, 'go.cmd'), '@echo off\r\nexit /b 91\r\n');
    return;
  }
  const shim = join(fakeToolsDirectory, 'go');
  writeFileSync(shim, '#!/bin/sh\nexit 91\n');
  chmodSync(shim, 0o755);
}
