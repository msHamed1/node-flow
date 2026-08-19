#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCollector } from '@node-flow/collector';
import { createInstrumentedEnvironment } from './child-environment.js';

const args = process.argv.slice(2);
if (args[0] === '--help' || args[0] === '-h') {
  console.log('Usage: node-flow dev -- <command> [args...]');
  process.exit(0);
}
if (args[0] !== 'dev') {
  console.error('Usage: node-flow dev -- <command> [args...]');
  process.exit(1);
}
const separator = args.indexOf('--');
const command = separator >= 0 ? args.slice(separator + 1) : args.slice(1);
if (!command[0]) {
  console.error('NodeFlow needs an application command. Example: node-flow dev -- yarn start:dev');
  process.exit(1);
}

const ownDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceDashboard = resolve(ownDirectory, '../../../apps/dashboard/dist');
const packagedDashboard = resolve(ownDirectory, '../dashboard');
const configuredDashboard = process.env.NODEFLOW_DASHBOARD_DIR;
const dashboardDirectory =
  configuredDashboard ?? (existsSync(packagedDashboard) ? packagedDashboard : workspaceDashboard);

const port = Number.parseInt(process.env.NODEFLOW_PORT ?? '7331', 10);
const collector = await startCollector({
  port,
  dashboardDirectory: existsSync(dashboardDirectory) ? dashboardDirectory : undefined,
});

console.log(
  `\nNodeFlow started\n\nApplication command:\n${command.join(' ')}\n\nRuntime map:\n${collector.url}\n\nPress Ctrl+C to stop.\n`,
);

const child: ChildProcess = spawn(command[0], command.slice(1), {
  stdio: 'inherit',
  env: createInstrumentedEnvironment(process.env, collector.url),
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
