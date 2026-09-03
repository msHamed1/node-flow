# @mshamed1/node-flow-topology-engine

The framework-independent, in-memory engine that turns normalized telemetry spans into NodeFlow's
runtime architecture.

The local collector owns an engine instance and feeds it span batches and process metrics. The
engine owns aggregation and derived state; it does not receive HTTP requests, export telemetry, or
render the dashboard.

Application developers should normally install
[`@mshamed1/node-flow`](https://www.npmjs.com/package/@mshamed1/node-flow) instead of using this
transitive runtime package directly.

## Processing model

```text
Normalized completed spans
          ↓
Deduplicate and group by trace
          ↓
Resolve semantic nodes and parent/child dependencies
          ↓
Aggregate calls, errors, latency samples, and runtime paths
          ↓
Live topology snapshot or versioned architecture snapshot
```

The engine re-evaluates traces touched by each batch because child spans can be exported before
their parents. When internal spans sit between two architectural components, it walks upward to the
nearest parent that maps to a topology node.

## Basic usage

```ts
import { TopologyEngine } from '@mshamed1/node-flow-topology-engine';
import type { TelemetrySpan } from '@mshamed1/node-flow-protocol';

const engine = new TopologyEngine({
  applicationName: 'payments-api',
  nodeVersion: process.version,
});

const spans: TelemetrySpan[] = [
  {
    traceId: 'trace-1',
    spanId: 'span-1',
    name: 'PaymentsService.authorize',
    kind: 'service',
    startTimeUnixMs: Date.now(),
    durationMs: 12,
    status: 'ok',
    attributes: {
      'nodeflow.identity': 'service:PaymentsService',
      'nodeflow.framework': 'nestjs',
      'nodeflow.class': 'PaymentsService',
    },
  },
];

const live = engine.ingest(spans);
const architecture = engine.createSnapshot();
```

## `TopologyEngine` API

| Method                               | Responsibility                                               |
| ------------------------------------ | ------------------------------------------------------------ |
| `registerApplication(name, version)` | Track service names and the observed Node.js version         |
| `ingest(spans)`                      | Deduplicate and aggregate a batch, then return live state    |
| `updateRuntime(metrics)`             | Store the latest process metrics and advance the revision    |
| `snapshot()`                         | Return the transient dashboard-oriented `TopologySnapshot`   |
| `createSnapshot()`                   | Return the stable, versioned `NodeFlowSnapshot` architecture |

### Retention options

```ts
new TopologyEngine({
  maxRecentTraces: 50,
  maxLatencySamples: 1_000,
  maxRuntimePaths: 1_000,
});
```

| Option              | Default | What is bounded                                   |
| ------------------- | ------- | ------------------------------------------------- |
| `maxRecentTraces`   | `50`    | Request-level trace waterfalls retained in memory |
| `maxLatencySamples` | `1,000` | Samples retained per node, edge, or runtime path  |
| `maxRuntimePaths`   | `1,000` | Distinct aggregated execution paths               |

Call counts, error counts, and total latency continue to aggregate while percentile calculations
use the bounded latency sample window.

## Stable semantic identities

`createStableNodeId(type, identity, framework?)` normalizes semantic identity instead of using
random IDs. Repeated executions therefore update the same component. Edges use the deterministic
form:

```text
dependency:<source-node-id>-><target-node-id>
```

Stable node and edge IDs plus sorted snapshot arrays prevent array ordering and repeated traffic
from producing false structural diffs. Callers should never derive architecture by inspecting the
engine's private maps; `createSnapshot()` is the public derived-state boundary.

## Live topology versus architecture snapshots

`snapshot()` is optimized for the active dashboard. It includes:

- Revision and generation timestamp
- Nodes and edges with live metric summaries
- Aggregated runtime paths
- Bounded recent traces
- Latest process metrics
- IDs active in the most recent update

`createSnapshot()` is optimized for persistence and comparison. It includes stable architecture,
application/runtime metadata, metrics, and paths, but intentionally omits raw spans, recent traces,
and dashboard activity.

## Snapshot utilities

The package owns the complete persisted-snapshot boundary:

- `SNAPSHOT_VERSION`
- `validateSnapshot()` and `SnapshotValidationError`
- `serializeSnapshot()` and `deserializeSnapshot()`
- `compareSnapshots()`
- `defaultComparisonThresholds`

Serialization validates and sorts nodes, edges, and paths before producing newline-terminated JSON.
Validation rejects malformed structures, unsupported versions, duplicate IDs, dangling edges, and
runtime paths that reference missing nodes.

## Architecture comparison

```ts
import { compareSnapshots, deserializeSnapshot } from '@mshamed1/node-flow-topology-engine';

const before = deserializeSnapshot(beforeJson);
const after = deserializeSnapshot(afterJson);
const diff = compareSnapshots(before, after);

console.log(diff.summary);
```

Comparison separates structural node/edge changes from metric changes. Default metric thresholds
require both an absolute and percentage movement:

| Metric           | Absolute | Percentage |
| ---------------- | -------- | ---------- |
| Calls            | `10`     | `10%`      |
| Errors           | `1`      | `10%`      |
| Average duration | `5 ms`   | `20%`      |
| p50 duration     | `5 ms`   | `20%`      |
| p95 duration     | `10 ms`  | `25%`      |
| p99 duration     | `10 ms`  | `25%`      |

New external services and dependencies receive `warning` severity. Increased latency that crosses
the configured threshold also receives `warning`; the engine does not speculate that those changes
are critical failures.

Custom thresholds can be passed as the third argument to `compareSnapshots()`.

## Runtime and ownership boundaries

- All state is process-local and in memory; restarting the collector resets it.
- The engine trusts that incoming spans were normalized at the instrumentation boundary.
- Topology represents executed traffic only. Unexercised code and dependencies do not appear.
- Recent traces, percentile samples, and distinct runtime paths are bounded to control memory.
- Transport validation belongs to the collector; telemetry capture belongs to instrumentation.
