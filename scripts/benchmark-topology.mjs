import { spawnSync } from 'node:child_process';
import { cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { TopologyEngine } from '../packages/topology-engine/dist/index.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const snapshotIterations = 1_000;
const workloads = [
  makeWorkload('small-300-spans', 100, 5, 5, 5),
  makeWorkload('medium-3000-spans', 1_000, 20, 20, 20),
  makeWorkload('large-30000-spans', 10_000, 100, 50, 50),
];

warmTypeScriptEngine();
const typescript = workloads.map(runTypeScript);
const go = runGo(workloads);

console.log(`# TopologyEngine differential benchmark\n`);
console.log(
  `- Host: ${platform()} ${release()}, ${cpus()[0]?.model ?? 'unknown CPU'}, ${cpus().length} logical CPUs`,
);
console.log(`- Node.js: ${process.version}`);
console.log(`- Go: ${go.goVersion}`);
console.log(`- Snapshot samples per workload: ${snapshotIterations}`);
console.log(`- Input: the exact same in-memory batch objects are serialized to the Go runner\n`);
console.log(
  '| Workload | Engine | spans/s | updates/s | snapshot p50 | snapshot p95 | retained heap | ingest allocated | ingest allocs |',
);
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (let index = 0; index < workloads.length; index += 1) {
  printRow(typescript[index]);
  printRow({ ...go.results[index], engine: 'Go' });
}
console.log('\nTopology sizes:');
for (const candidate of go.results) {
  console.log(
    `- ${candidate.name}: ${candidate.topology.nodes} nodes, ${candidate.topology.edges} edges, ${candidate.topology.paths} paths`,
  );
}
console.log(
  '\nNotes: Node.js does not expose allocation counts; `n/a` is reported instead of estimating them. Retained heap is measured after an explicit GC. Ingest allocated bytes and allocation counts for Go include engine construction and reconstruction, but exclude JSON decoding. Snapshot allocation totals cover all snapshot samples.',
);

function runTypeScript(candidate) {
  globalThis.gc?.();
  const before = process.memoryUsage();
  const engine = new TopologyEngine({ nodeVersion: 'v22.0.0' });
  const started = performance.now();
  for (const batch of candidate.batches) {
    engine.registerApplication(batch.serviceName, batch.nodeVersion ?? 'v22.0.0');
    engine.ingest(batch.spans);
  }
  const elapsedMs = performance.now() - started;
  globalThis.gc?.();
  const after = process.memoryUsage();
  const snapshotSamples = [];
  for (let iteration = 0; iteration < snapshotIterations; iteration += 1) {
    const snapshotStarted = performance.now();
    engine.createSnapshot();
    snapshotSamples.push(performance.now() - snapshotStarted);
  }
  const topology = engine.createSnapshot();
  return {
    name: candidate.name,
    engine: 'TypeScript',
    spans: candidate.spanCount,
    updates: candidate.batches.length,
    ingestion: {
      elapsedMs,
      spansPerSecond: candidate.spanCount / (elapsedMs / 1_000),
      updatesPerSecond: candidate.batches.length / (elapsedMs / 1_000),
    },
    snapshot: {
      p50Ms: percentile(snapshotSamples, 0.5),
      p95Ms: percentile(snapshotSamples, 0.95),
    },
    memory: {
      retainedHeapBytes: after.heapUsed - before.heapUsed,
    },
    topology: {
      nodes: topology.nodes.length,
      edges: topology.edges.length,
      paths: topology.paths?.length ?? 0,
    },
  };
}

function runGo(candidates) {
  const execution = spawnSync('go', ['run', './cmd/topology-benchmark'], {
    cwd: join(repositoryRoot, 'services/collector'),
    encoding: 'utf8',
    input: JSON.stringify({ snapshotIterations, workloads: candidates }),
    env: {
      ...process.env,
      GOCACHE: process.env.GOCACHE ?? join(tmpdir(), 'nodeflow-v23-go-cache'),
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (execution.status !== 0) {
    throw new Error(`Go topology benchmark failed (${execution.status}): ${execution.stderr}`);
  }
  return JSON.parse(execution.stdout);
}

function warmTypeScriptEngine() {
  const warmup = makeWorkload('warmup', 500, 10, 10, 10);
  for (let iteration = 0; iteration < 3; iteration += 1) runTypeScript(warmup);
}

function makeWorkload(name, traces, routes, services, databases) {
  const spans = [];
  for (let trace = 0; trace < traces; trace += 1) {
    const traceId = `benchmark-${name}-${trace}`;
    const route = trace % routes;
    const service = (trace * 17 + Math.floor(trace / routes)) % services;
    const database = (trace * 31 + Math.floor(trace / (routes * services))) % databases;
    const startTimeUnixMs = 1_700_000_000_000 + trace * 10;
    spans.push(
      {
        traceId,
        spanId: `${traceId}-route`,
        name: `GET /resource/${route}`,
        kind: 'http-route',
        startTimeUnixMs,
        durationMs: 10,
        status: 'ok',
      },
      {
        traceId,
        spanId: `${traceId}-service`,
        parentSpanId: `${traceId}-route`,
        name: `Service${service}.call`,
        kind: 'service',
        startTimeUnixMs: startTimeUnixMs + 1,
        durationMs: 7,
        status: 'ok',
        attributes: {
          'nodeflow.identity': `service:Service${service}`,
          'nodeflow.class': `Service${service}`,
          'nodeflow.framework': 'nestjs',
        },
      },
      {
        traceId,
        spanId: `${traceId}-database`,
        parentSpanId: `${traceId}-service`,
        name: `Database${database}`,
        kind: 'database',
        startTimeUnixMs: startTimeUnixMs + 2,
        durationMs: 3,
        status: 'ok',
        attributes: { 'nodeflow.identity': `database:Database${database}` },
      },
    );
  }
  const batches = [];
  for (let start = 0; start < spans.length; start += 100) {
    batches.push({
      serviceName: 'benchmark-api',
      nodeVersion: 'v22.0.0',
      spans: spans.slice(start, start + 100),
    });
  }
  return { name, spanCount: spans.length, batches };
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor((ordered.length - 1) * fraction)] ?? 0;
}

function printRow(candidate) {
  console.log(
    `| ${candidate.name} | ${candidate.engine} | ${formatNumber(candidate.ingestion.spansPerSecond)} | ${formatNumber(candidate.ingestion.updatesPerSecond)} | ${candidate.snapshot.p50Ms.toFixed(3)} ms | ${candidate.snapshot.p95Ms.toFixed(3)} ms | ${formatBytes(candidate.memory.retainedHeapBytes)} | ${candidate.memory.allocatedBytes === undefined ? 'n/a' : formatBytes(candidate.memory.allocatedBytes)} | ${candidate.memory.allocations === undefined ? 'n/a' : formatNumber(candidate.memory.allocations)} |`,
  );
}

function formatNumber(value) {
  return Math.round(value).toLocaleString('en-US');
}

function formatBytes(value) {
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  if (absolute < 1_024) return `${sign}${absolute.toFixed(0)} B`;
  if (absolute < 1_048_576) return `${sign}${(absolute / 1_024).toFixed(1)} KiB`;
  return `${sign}${(absolute / 1_048_576).toFixed(1)} MiB`;
}
