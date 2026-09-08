#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareCommandHelp,
  runCompareCommand,
  runSnapshotCommand,
  snapshotCommandHelp,
} from './architecture-commands.js';
import { createInstrumentedEnvironment } from './child-environment.js';
import { startGoRuntime, type RunningRuntime } from './runtime-launcher.js';

const usage = [
  'Usage: node-flow dev -- <command> [args...]',
  '       node-flow collector',
  '       node-flow run -- <command> [args...]',
  '       node-flow snapshot [--output <architecture.json>]',
  '       node-flow compare <before.json> <after.json>',
].join('\n');

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
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
    const runtime = await startCliRuntime();
    printStarted(command, runtime.url);
    await runChild(command, runtime.url, runtime);
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
    throw new Error(
      'NodeFlow needs an application command. Example: node-flow dev -- yarn start:dev',
    );
  }
  return command;
}

async function runCollector(): Promise<void> {
  const runtime = await startCliRuntime();
  console.log(`NodeFlow collector and dashboard: ${runtime.url}`);
  let requestedStop = false;
  const stop = (signal: NodeJS.Signals): void => {
    requestedStop = true;
    void runtime.close(signal);
  };
  const onInterrupt = (): void => stop('SIGINT');
  const onTerminate = (): void => stop('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  const result = await runtime.exit;
  process.off('SIGINT', onInterrupt);
  process.off('SIGTERM', onTerminate);
  if (!requestedStop) {
    console.error(
      `NodeFlow Go runtime stopped unexpectedly (${result.code ?? result.signal ?? 'unknown'}).`,
    );
    process.exitCode = result.code && result.code !== 0 ? result.code : 1;
  }
}

async function startCliRuntime(): Promise<RunningRuntime> {
  const ownDirectory = dirname(fileURLToPath(import.meta.url));
  const workspaceDashboard = resolve(ownDirectory, '../../../apps/dashboard/dist');
  const packagedDashboard = resolve(ownDirectory, '../dashboard');
  const configuredDashboard = process.env.NODEFLOW_DASHBOARD_DIR;
  if (configuredDashboard && !existsSync(configuredDashboard)) {
    throw new Error(`NODEFLOW_DASHBOARD_DIR does not exist: ${configuredDashboard}`);
  }
  const dashboardDirectory =
    configuredDashboard ?? (existsSync(packagedDashboard) ? packagedDashboard : workspaceDashboard);
  return startGoRuntime({
    dashboardDirectory: existsSync(dashboardDirectory) ? dashboardDirectory : undefined,
  });
}

async function runChild(
  command: string[],
  collectorUrl: string,
  runtime?: RunningRuntime,
): Promise<void> {
  const child: ChildProcess = spawn(command[0]!, command.slice(1), {
    stdio: 'inherit',
    env: createInstrumentedEnvironment(process.env, collectorUrl, {
      exportProtocol: runtime ? 'protobuf' : undefined,
      runtimePid: runtime?.pid,
    }),
  });
  let stopping = false;
  let finished = false;

  const finish = async (exitCode: number): Promise<void> => {
    if (finished) return;
    finished = true;
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    await runtime?.close().catch(() => undefined);
    process.exitCode = exitCode;
  };
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    if (!child.killed) child.kill(signal);
    void runtime?.close(signal);
  };
  const onInterrupt = (): void => stop('SIGINT');
  const onTerminate = (): void => stop('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);

  await new Promise<void>((resolveExit) => {
    child.once('error', (error) => {
      console.error(`Unable to start application: ${error.message}`);
      void finish(1).finally(resolveExit);
    });
    child.once('exit', (code, signal) => {
      const exitCode = code ?? (signal && !stopping ? 1 : 0);
      void finish(exitCode).finally(resolveExit);
    });
    void runtime?.exit.then((result) => {
      if (finished || stopping) return;
      stopping = true;
      console.error(
        `NodeFlow Go runtime stopped while the application was running (${result.code ?? result.signal ?? 'unknown'}).`,
      );
      if (!child.killed) child.kill('SIGTERM');
      void finish(result.code && result.code !== 0 ? result.code : 1).finally(resolveExit);
    });
  });
}

function printStarted(command: string[], collectorUrl: string): void {
  console.log(
    `\nNodeFlow started\n\nApplication command:\n${command.join(' ')}\n\nRuntime map:\n${collectorUrl}\n\nPress Ctrl+C to stop.\n`,
  );
}
