import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeFlowSnapshot } from '@mshamed1/node-flow-protocol';
import { serializeSnapshot } from '@mshamed1/node-flow-topology-engine';
import { runCompareCommand, runSnapshotCommand } from './architecture-commands.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('architecture CLI commands', () => {
  it('fetches and writes an architecture snapshot with a useful summary', async () => {
    const directory = await temporaryDirectory();
    const logs: string[] = [];
    const target = await runSnapshotCommand(['--output', 'before.json'], {
      cwd: directory,
      fetch: async () => Response.json(fixture()),
      log: (message) => logs.push(message),
    });

    expect(target).toBe(join(directory, 'before.json'));
    expect(JSON.parse(await readFile(target, 'utf8'))).toMatchObject({ version: '1.0' });
    expect(logs[0]).toContain('Nodes: 2');
    expect(logs[0]).toContain('Dependencies: 1');
  });

  it('reports collector and output-path failures cleanly', async () => {
    await expect(
      runSnapshotCommand([], {
        fetch: async () => {
          throw new Error('connection refused');
        },
        log: () => undefined,
      }),
    ).rejects.toThrow(/Unable to reach the NodeFlow collector/);

    const directory = await temporaryDirectory();
    await expect(
      runSnapshotCommand(['--output', 'missing/snapshot.json'], {
        cwd: directory,
        fetch: async () => Response.json(fixture()),
        log: () => undefined,
      }),
    ).rejects.toThrow(/Unable to write architecture snapshot/);
  });

  it('compares two snapshot files and prints structural and meaningful metric changes', async () => {
    const directory = await temporaryDirectory();
    const before = fixture();
    const after = fixture();
    after.nodes.push({ id: 'cache:redis', type: 'cache', name: 'Redis' });
    after.edges[0]!.metrics = { callCount: 1_500, avgDurationMs: 31, p95DurationMs: 96 };
    await writeFile(join(directory, 'before.json'), serializeSnapshot(before));
    await writeFile(join(directory, 'after.json'), serializeSnapshot(after));
    const logs: string[] = [];

    const diff = await runCompareCommand(['before.json', 'after.json'], {
      cwd: directory,
      log: (message) => logs.push(message),
    });

    expect(diff.nodes.added[0]?.name).toBe('Redis');
    expect(logs[0]).toContain('+ Redis');
    expect(logs[0]).toContain('PaymentsService -> PostgreSQL [warning]');
    expect(logs[0]).toContain('p95  41ms -> 96ms');
  });

  it('rejects missing, invalid JSON, malformed, and unsupported comparison files', async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, 'bad.json'), '{}');
    await writeFile(join(directory, 'good.json'), serializeSnapshot(fixture()));
    await writeFile(join(directory, 'invalid.json'), '{not-json');
    await writeFile(
      join(directory, 'unsupported.json'),
      JSON.stringify({ ...fixture(), version: '0.9' }),
    );
    await expect(
      runCompareCommand(['missing.json', 'good.json'], { cwd: directory, log: () => undefined }),
    ).rejects.toThrow(/Unable to read architecture snapshot/);
    await expect(
      runCompareCommand(['invalid.json', 'good.json'], { cwd: directory, log: () => undefined }),
    ).rejects.toThrow(/not valid JSON/);
    await expect(
      runCompareCommand(['bad.json', 'good.json'], { cwd: directory, log: () => undefined }),
    ).rejects.toThrow(/version/);
    await expect(
      runCompareCommand(['unsupported.json', 'good.json'], {
        cwd: directory,
        log: () => undefined,
      }),
    ).rejects.toThrow(/Unsupported NodeFlow snapshot version/);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'node-flow-cli-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fixture(): NodeFlowSnapshot {
  return {
    version: '1.0',
    generatedAt: '2026-08-26T10:00:00.000Z',
    application: { name: 'payments-api', runtime: 'nodejs', nodeVersion: 'v22.1.0' },
    nodes: [
      {
        id: 'nestjs:service:paymentsservice',
        type: 'service',
        name: 'PaymentsService',
      },
      { id: 'database:postgresql', type: 'database', name: 'PostgreSQL' },
    ],
    edges: [
      {
        id: 'dependency:nestjs:service:paymentsservice->database:postgresql',
        source: 'nestjs:service:paymentsservice',
        target: 'database:postgresql',
        type: 'runtime-dependency',
        metrics: { callCount: 1_000, avgDurationMs: 18, p95DurationMs: 41 },
      },
    ],
  };
}
