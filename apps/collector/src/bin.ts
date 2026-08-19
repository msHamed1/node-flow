#!/usr/bin/env node
import { startCollector } from './index.js';

const port = Number.parseInt(process.env.NODEFLOW_PORT ?? '7331', 10);
const host = process.env.NODEFLOW_HOST ?? '127.0.0.1';
const collector = await startCollector({ host, port });
console.log(`NodeFlow collector: ${collector.url}`);

const stop = async (): Promise<void> => {
  await collector.close();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
