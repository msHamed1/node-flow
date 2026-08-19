#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startCollector } from '@nodescope/collector';

const args = process.argv.slice(2);
if (args[0] !== 'dev') {
  console.error('Usage: nodescope dev -- <command> [args...]');
  process.exit(1);
}
const separator = args.indexOf('--');
const command = separator >= 0 ? args.slice(separator + 1) : args.slice(1);
if (!command[0]) {
  console.error('NodeScope needs an application command. Example: nodescope dev -- npm run start:dev');
  process.exit(1);
}

const ownDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(ownDirectory, '../../..');
const dashboardDirectory = process.env.NODESCOPE_DASHBOARD_DIR ?? resolve(workspaceRoot, 'apps/dashboard/dist');
const registerPath = resolve(workspaceRoot, 'packages/instrumentation-node/dist/register.js');
if (!existsSync(registerPath)) {
  console.error(`NodeScope instrumentation is not built: ${registerPath}`);
  process.exit(1);
}

const port = Number.parseInt(process.env.NODESCOPE_PORT ?? '7331', 10);
const collector = await startCollector({
  port,
  dashboardDirectory: existsSync(dashboardDirectory) ? dashboardDirectory : undefined,
});
const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(registerPath).href}`].filter(Boolean).join(' ');

console.log(`\nNodeScope started\n\nApplication command:\n${command.join(' ')}\n\nRuntime map:\n${collector.url}\n\nPress Ctrl+C to stop.\n`);

const child: ChildProcess = spawn(command[0], command.slice(1), {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    NODESCOPE_COLLECTOR_URL: collector.url,
  },
});

let stopping = false;
const stop = async (signal: NodeJS.Signals = 'SIGTERM'): Promise<void> => {
  if (stopping) return;
  stopping = true;
  if (!child.killed) child.kill(signal);
  await collector.close().catch(() => undefined);
};

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
child.once('error', async (error) => {
  console.error(`Unable to start application: ${error.message}`);
  await stop();
  process.exitCode = 1;
});
child.once('exit', async (code, signal) => {
  await stop(signal ?? 'SIGTERM');
  process.exitCode = code ?? (signal ? 1 : 0);
});
