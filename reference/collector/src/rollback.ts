#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCollector } from './index.js';

const ownDirectory = dirname(fileURLToPath(import.meta.url));
const defaultDashboard = resolve(ownDirectory, '../../../dashboard/dist');
const dashboardDirectory = process.env.NODEFLOW_DASHBOARD_DIR ?? defaultDashboard;
const port = Number.parseInt(process.env.NODEFLOW_PORT ?? '7331', 10);
const host = process.env.NODEFLOW_HOST ?? '127.0.0.1';
const collector = await startCollector({
  host,
  port,
  dashboardDirectory: existsSync(dashboardDirectory) ? dashboardDirectory : undefined,
});

console.log(`NodeFlow TypeScript rollback collector: ${collector.url}`);
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void collector.close().finally(() => process.exit());
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
