#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCollector, type RunningCollector } from '@mshamed1/node-flow-collector';
import {
  compareCommandHelp,
  runCompareCommand,
  runSnapshotCommand,
  snapshotCommandHelp,
} from './architecture-commands.js';
import { createInstrumentedEnvironment } from './child-environment.js';

const usage = [
  'Usage: node-flow dev -- <command> [args...]',
  '       node-flow collector',
  '       node-flow run -- <command> [args...]',
  '       node-flow snapshot [--output <architecture.json>]',
  '       node-flow compare <before.json> <after.json>',
].join('\n');

const args = process.argv.slice(2);
const mode = args[0];

if (mode === '--help' || mode === '-h') {
  console.log(usage);
} else if (mode === 'collector') {
  await runCollector();
} else if (mode === 'snapshot') {
  if (isHelp(args[1])) console.log(snapshotCommandHelp);
  else await runArchitectureCommand(() => runSnapshotCommand(args.slice(1)));
} else if (mode === 'compare') {
  if (isHelp(args[1])) console.log(compareCommandHelp);
  else await runArchitectureCommand(() => runCompareCommand(args.slice(1)));
} else if (mode === 'dev') {
  const command = resolveCommand(args);
  const collector = await startCliCollector();
  printStarted(command, collector.url);
  await runChild(command, collector.url, collector);
} else if (mode === 'run') {
  const command = resolveCommand(args);
  const collectorUrl = process.env.NODEFLOW_COLLECTOR_URL;
  if (!collectorUrl) {
    console.error('NODEFLOW_COLLECTOR_URL is required for node-flow run.');
    process.exitCode = 1;
  } else {
    console.log(`NodeFlow instrumenting: ${command.join(' ')}`);
    await runChild(command, collectorUrl);
  }
} else {
  console.error(usage);
  process.exitCode = 1;
}

function isHelp(argument: string | undefined): boolean {
  return argument === '--help' || argument === '-h';
}

async function runArchitectureCommand(command: () => Promise<unknown>): Promise<void> {
  try {
    await command();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function resolveCommand(commandArgs: string[]): string[] {
  const separator = commandArgs.indexOf('--');
  const command = separator >= 0 ? commandArgs.slice(separator + 1) : commandArgs.slice(1);
  if (!command[0]) {
    console.error(
      'NodeFlow needs an application command. Example: node-flow dev -- yarn start:dev',
    );
    process.exit(1);
  }
  return command;
}

async function runCollector(): Promise<void> {
  const collector = await startCliCollector();
  console.log(`NodeFlow collector and dashboard: ${collector.url}`);
  await new Promise<void>((resolveStop) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void collector.close().finally(resolveStop);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function startCliCollector(): Promise<RunningCollector> {
  const ownDirectory = dirname(fileURLToPath(import.meta.url));
  const workspaceDashboard = resolve(ownDirectory, '../../../apps/dashboard/dist');
  const packagedDashboard = resolve(ownDirectory, '../dashboard');
  const configuredDashboard = process.env.NODEFLOW_DASHBOARD_DIR;
  const dashboardDirectory =
    configuredDashboard ?? (existsSync(packagedDashboard) ? packagedDashboard : workspaceDashboard);
  const port = Number.parseInt(process.env.NODEFLOW_PORT ?? '7331', 10);
  const host = process.env.NODEFLOW_HOST ?? '127.0.0.1';
  return startCollector({
    host,
    port,
    dashboardDirectory: existsSync(dashboardDirectory) ? dashboardDirectory : undefined,
  });
}

async function runChild(
  command: string[],
  collectorUrl: string,
  collector?: RunningCollector,
): Promise<void> {
  const child: ChildProcess = spawn(command[0]!, command.slice(1), {
    stdio: 'inherit',
    env: createInstrumentedEnvironment(process.env, collectorUrl),
  });
  let stopping = false;
  const stop = async (signal: NodeJS.Signals = 'SIGTERM'): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (!child.killed) child.kill(signal);
    await collector?.close().catch(() => undefined);
  };

  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('SIGTERM', () => void stop('SIGTERM'));
  await new Promise<void>((resolveExit) => {
    child.once('error', async (error) => {
      console.error(`Unable to start application: ${error.message}`);
      await stop();
      process.exitCode = 1;
      resolveExit();
    });
    child.once('exit', async (code, signal) => {
      await stop(signal ?? 'SIGTERM');
      process.exitCode = code ?? (signal ? 1 : 0);
      resolveExit();
    });
  });
}

function printStarted(command: string[], collectorUrl: string): void {
  console.log(
    `\nNodeFlow started\n\nApplication command:\n${command.join(' ')}\n\nRuntime map:\n${collectorUrl}\n\nPress Ctrl+C to stop.\n`,
  );
}
