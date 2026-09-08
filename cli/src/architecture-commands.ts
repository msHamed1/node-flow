import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  collectorPaths,
  type ArchitectureEdge,
  type NodeFlowSnapshot,
} from '@mshamed1/node-flow-protocol';
import {
  compareSnapshots,
  deserializeSnapshot,
  serializeSnapshot,
  validateSnapshot,
  type ArchitectureDiff,
  type MetricChange,
} from '@mshamed1/node-flow-topology-engine';

export interface ArchitectureCommandOptions {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  log?: (message: string) => void;
}

export const snapshotCommandHelp = [
  'Usage: node-flow snapshot [--output <architecture.json>]',
  '',
  'Save the architecture currently held by the active local collector.',
  'Default output: node-flow.snapshot.json',
].join('\n');

export const compareCommandHelp = [
  'Usage: node-flow compare <before.json> <after.json>',
  '',
  'Compare structural architecture changes and meaningful runtime metric changes.',
].join('\n');

export async function runSnapshotCommand(
  args: string[],
  options: ArchitectureCommandOptions = {},
): Promise<string> {
  const output = parseSnapshotOutput(args);
  const environment = options.environment ?? process.env;
  const collectorUrl =
    environment.NODEFLOW_COLLECTOR_URL ??
    `http://${environment.NODEFLOW_HOST ?? '127.0.0.1'}:${environment.NODEFLOW_PORT ?? '7331'}`;
  const request = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await request(`${collectorUrl}${collectorPaths.architecture}`, {
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new Error(
      `Unable to reach the NodeFlow collector at ${collectorUrl}. Start node-flow dev or node-flow collector first. ${errorMessage(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `NodeFlow collector returned HTTP ${response.status} while creating a snapshot.`,
    );
  }

  const snapshot = (await response.json()) as unknown;
  validateSnapshot(snapshot);
  const target = resolve(options.cwd ?? process.cwd(), output);
  try {
    await writeFile(target, serializeSnapshot(snapshot), { encoding: 'utf8', flag: 'w' });
  } catch (error) {
    throw new Error(`Unable to write architecture snapshot to ${target}. ${errorMessage(error)}`);
  }

  const message = [
    'NodeFlow architecture snapshot created',
    '',
    `Nodes: ${snapshot.nodes.length}`,
    `Dependencies: ${snapshot.edges.length}`,
    `Runtime paths: ${snapshot.paths?.length ?? 0}`,
    '',
    'Saved to:',
    target,
  ].join('\n');
  (options.log ?? console.log)(message);
  return target;
}

export async function runCompareCommand(
  args: string[],
  options: ArchitectureCommandOptions = {},
): Promise<ArchitectureDiff> {
  if (args.length !== 2 || args.some((argument) => argument.startsWith('-'))) {
    throw new Error('Usage: node-flow compare <before.json> <after.json>');
  }
  const cwd = options.cwd ?? process.cwd();
  const [beforePath, afterPath] = args.map((path) => resolve(cwd, path));
  let contents: string[];
  try {
    contents = await Promise.all([readFile(beforePath!, 'utf8'), readFile(afterPath!, 'utf8')]);
  } catch (error) {
    throw new Error(`Unable to read architecture snapshot. ${errorMessage(error)}`);
  }
  const before = deserializeSnapshot(contents[0]!);
  const after = deserializeSnapshot(contents[1]!);
  const diff = compareSnapshots(before, after);
  (options.log ?? console.log)(formatArchitectureDiff(diff, before, after));
  return diff;
}

export function formatArchitectureDiff(
  diff: ArchitectureDiff,
  before: NodeFlowSnapshot,
  after: NodeFlowSnapshot,
): string {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const structure: string[] = [];

  for (const node of diff.nodes.added)
    structure.push(`+ ${node.name}${severitySuffix(node.severity)}`);
  for (const node of diff.nodes.removed) structure.push(`- ${node.name}`);
  for (const node of diff.nodes.changed) {
    structure.push(`~ ${node.before.name} -> ${node.after.name}`);
  }
  for (const edge of diff.edges.added) {
    structure.push(`+ ${edgeLabel(edge, afterNodes)}${severitySuffix(edge.severity)}`);
  }
  for (const edge of diff.edges.removed) structure.push(`- ${edgeLabel(edge, beforeNodes)}`);
  for (const edge of diff.edges.changed) {
    structure.push(`~ ${edgeLabel(edge.after, afterNodes)}`);
  }

  const performanceChanges =
    diff.metrics.edges.length > 0 ? diff.metrics.edges : diff.metrics.nodes;
  const performance = performanceChanges.map((change) => formatMetricChange(change, afterNodes));

  return [
    'NodeFlow Architecture Diff',
    '',
    `Before  ${diff.before.nodes} nodes / ${diff.before.edges} dependencies`,
    `After   ${diff.after.nodes} nodes / ${diff.after.edges} dependencies`,
    '',
    'STRUCTURE',
    '',
    ...(structure.length ? structure : ['No structural architecture changes.']),
    '',
    'PERFORMANCE',
    '',
    ...(performance.length ? performance : ['No meaningful runtime metric changes.']),
  ].join('\n');
}

function parseSnapshotOutput(args: string[]): string {
  if (args.length === 0) return 'node-flow.snapshot.json';
  if (args.length === 2 && (args[0] === '--output' || args[0] === '-o') && args[1]) return args[1];
  throw new Error(snapshotCommandHelp.split('\n')[0]);
}

function edgeLabel(edge: ArchitectureEdge, nodes: Map<string, { name: string }>): string {
  return `${nodes.get(edge.source)?.name ?? edge.source} -> ${nodes.get(edge.target)?.name ?? edge.target}`;
}

function formatMetricChange(
  change: MetricChange<ArchitectureEdge | NodeFlowSnapshot['nodes'][number]>,
  nodes: Map<string, { name: string }>,
): string {
  const subject = 'source' in change.after ? edgeLabel(change.after, nodes) : change.after.name;
  const lines = change.changes.map((delta) => {
    const unit = delta.metric.includes('Duration') ? 'ms' : '';
    const percent =
      delta.percentChange === undefined
        ? 'new'
        : `${delta.percentChange >= 0 ? '+' : ''}${delta.percentChange.toFixed(1)}%`;
    return `  ${metricLabel(delta.metric)}  ${formatNumber(delta.before)}${unit} -> ${formatNumber(delta.after)}${unit} (${percent})`;
  });
  return [`${subject}${severitySuffix(change.severity)}`, ...lines].join('\n');
}

function metricLabel(metric: string): string {
  return (
    {
      callCount: 'calls',
      errorCount: 'errors',
      avgDurationMs: 'avg',
      p50DurationMs: 'p50',
      p95DurationMs: 'p95',
      p99DurationMs: 'p99',
    }[metric] ?? metric
  );
}

function severitySuffix(severity: string): string {
  return severity === 'info' ? '' : ` [${severity}]`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? new Intl.NumberFormat('en-US').format(value) : value.toFixed(1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
