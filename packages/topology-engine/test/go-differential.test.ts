import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { NodeFlowSnapshot } from '@mshamed1/node-flow-protocol';
import { TopologyEngine } from '../src/index.js';
import {
  canonicalizeTopology,
  normalizeCanonicalTopology,
  type CanonicalTopology,
} from './canonical-topology.js';
import { goldenFixtures, type GoldenFixture, type TelemetryBatch } from './golden-fixtures.js';

interface DifferentialFixture {
  name: string;
  expected: CanonicalTopology;
  batches: TelemetryBatch[];
}

interface GoResponse {
  fixtures: Array<{ name: string; snapshot: NodeFlowSnapshot }>;
}

describe('Go TopologyEngine differential prototype', () => {
  it('matches the TypeScript source of truth for native and deterministic randomized arrival orders', () => {
    const candidates = goldenFixtures().flatMap(differentialVariants);
    const goByName = runGoPrototype(candidates);
    const failures: string[] = [];

    for (const candidate of candidates) {
      const expected = normalizeCanonicalTopology(candidate.expected);
      const typescript = runTypeScriptEngine(candidate.batches);
      const goSnapshot = goByName.get(candidate.name);
      if (!goSnapshot) {
        failures.push(`${candidate.name}: Go result is missing`);
        continue;
      }
      const go = canonicalizeTopology(goSnapshot);
      for (const difference of semanticDifferences(expected, typescript)) {
        failures.push(`${candidate.name} [TypeScript vs golden]: ${difference}`);
      }
      for (const difference of semanticDifferences(typescript, go)) {
        failures.push(`${candidate.name} [TypeScript vs Go]: ${difference}`);
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  }, 120_000);
});

function runTypeScriptEngine(batches: TelemetryBatch[]): CanonicalTopology {
  const engine = new TopologyEngine({ nodeVersion: 'v22.0.0' });
  for (const batch of batches) {
    engine.registerApplication(batch.serviceName, batch.nodeVersion ?? 'v22.0.0');
    engine.ingest(batch.spans);
  }
  return canonicalizeTopology(engine.createSnapshot());
}

function runGoPrototype(candidates: DifferentialFixture[]): Map<string, NodeFlowSnapshot> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const execution = spawnSync('go', ['run', './cmd/topology-diff'], {
    cwd: join(repositoryRoot, 'services/collector'),
    encoding: 'utf8',
    input: JSON.stringify({
      fixtures: candidates.map(({ name, batches }) => ({ name, batches })),
    }),
    env: {
      ...process.env,
      GOCACHE: process.env.GOCACHE ?? join(tmpdir(), 'nodeflow-v23-go-cache'),
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (execution.status !== 0) {
    throw new Error(`Go differential runner failed (${execution.status}): ${execution.stderr}`);
  }
  const response = JSON.parse(execution.stdout) as GoResponse;
  return new Map(response.fixtures.map((fixture) => [fixture.name, fixture.snapshot]));
}

function differentialVariants(fixture: GoldenFixture): DifferentialFixture[] {
  return [
    { name: `${fixture.name} :: native`, batches: fixture.batches, expected: fixture.expected },
    {
      name: `${fixture.name} :: shuffled-a`,
      batches: permuteAsSingleSpanBatches(fixture, seedFrom(fixture.name, 0x9e3779b9)),
      expected: fixture.expected,
    },
    {
      name: `${fixture.name} :: shuffled-b`,
      batches: permuteAsSingleSpanBatches(fixture, seedFrom(fixture.name, 0x85ebca6b)),
      expected: fixture.expected,
    },
  ];
}

function permuteAsSingleSpanBatches(fixture: GoldenFixture, seed: number): TelemetryBatch[] {
  const entries = fixture.batches.flatMap((batch) =>
    batch.spans.map((span) => ({
      serviceName: batch.serviceName,
      nodeVersion: batch.nodeVersion,
      span,
    })),
  );
  let state = seed >>> 0;
  for (let index = entries.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [entries[index], entries[target]] = [entries[target]!, entries[index]!];
  }
  return entries.map(({ serviceName, nodeVersion, span }) => ({
    serviceName,
    ...(nodeVersion ? { nodeVersion } : {}),
    spans: [span],
  }));
}

function seedFrom(value: string, salt: number): number {
  let hash = salt >>> 0;
  for (const character of value) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619) >>> 0 || 1;
  }
  return hash;
}

function semanticDifferences(expected: CanonicalTopology, actual: CanonicalTopology): string[] {
  const differences: string[] = [];
  compareValue(differences, 'format', expected.format, actual.format);
  compareValue(differences, 'snapshotVersion', expected.snapshotVersion, actual.snapshotVersion);
  compareValue(
    differences,
    'applicationRuntime',
    expected.applicationRuntime,
    actual.applicationRuntime,
  );
  compareValue(differences, 'services', expected.services, actual.services);
  compareCollection(differences, 'node', expected.nodes, actual.nodes, (node) => node.id);
  compareCollection(differences, 'edge', expected.edges, actual.edges, (edge) => edge.id);
  compareCollection(
    differences,
    'path',
    expected.paths,
    actual.paths,
    (path) => `${path.entrypoint}:${path.nodes.join('>')}`,
  );
  return differences;
}

function compareCollection<T>(
  differences: string[],
  kind: string,
  expected: T[],
  actual: T[],
  identity: (value: T) => string,
): void {
  const expectedByID = new Map(expected.map((value) => [identity(value), value]));
  const actualByID = new Map(actual.map((value) => [identity(value), value]));
  for (const [id, expectedValue] of expectedByID) {
    const actualValue = actualByID.get(id);
    if (!actualValue) {
      differences.push(`missing ${kind} ${id}`);
    } else if (!isDeepStrictEqual(expectedValue, actualValue)) {
      differences.push(
        `${kind} ${id} mismatch: expected ${JSON.stringify(expectedValue)}, actual ${JSON.stringify(actualValue)}`,
      );
    }
  }
  for (const id of actualByID.keys()) {
    if (!expectedByID.has(id)) differences.push(`unexpected ${kind} ${id}`);
  }
}

function compareValue(
  differences: string[],
  field: string,
  expected: unknown,
  actual: unknown,
): void {
  if (!isDeepStrictEqual(expected, actual)) {
    differences.push(
      `${field} mismatch: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`,
    );
  }
}
