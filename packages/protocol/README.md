# @mshamed1/node-flow-protocol

Shared TypeScript contracts for telemetry, live topology, architecture snapshots, runtime metrics,
and collector messages across NodeFlow packages.

This package contains types and endpoint constants, not runtime processing. It is published so the
NodeFlow package graph can be installed from npm without copying contracts between the
instrumentation, collector, topology engine, CLI, and dashboard.

Application developers should normally depend on
[`@mshamed1/node-flow`](https://www.npmjs.com/package/@mshamed1/node-flow) instead.

## Contract flow

```text
instrumentation-node
  ├─ SpanBatch ────────────────> collector
  └─ RuntimeMetrics ───────────> collector

collector + topology-engine
  ├─ TopologySnapshot ─────────> live dashboard / WebSocket
  └─ NodeFlowSnapshot ─────────> CLI snapshot files and comparison
```

## Contract groups

### Ingestion contracts

- `TelemetrySpan` is NodeFlow's normalized representation of one completed OpenTelemetry span.
- `SpanBatch` groups spans by service and reports the producing Node.js version.
- `RuntimeMetrics` carries current memory, CPU, event-loop, and uptime measurements.

### Live exploration contracts

- `TopologyNode` and `TopologyEdge` describe observed components and dependencies with aggregate
  request, error, and latency metrics.
- `RuntimePath` describes an aggregated executed route through architecture nodes.
- `RecentTrace` and `TraceSpan` retain a bounded request-level waterfall.
- `TopologySnapshot` combines live graph state, recent traces, runtime metrics, revision, and
  activity markers for the dashboard.
- `CollectorMessage` defines WebSocket messages sent to dashboard clients.

### Stable architecture contracts

- `ArchitectureNode` and `ArchitectureEdge` are the normalized, portable architecture model.
- `NodeFlowSnapshot` is the versioned file/API contract used by `node-flow snapshot` and
  `node-flow compare`.

Unlike `TopologySnapshot`, the architecture snapshot intentionally excludes raw/recent traces and
ephemeral dashboard activity. It contains stable nodes, executed dependencies, aggregate metrics,
runtime paths, application metadata, and a schema version.

## Collector paths

`collectorPaths` is the shared source of truth for the local collector surface:

| Key            | Path                | Purpose                            |
| -------------- | ------------------- | ---------------------------------- |
| `spans`        | `/api/spans`        | Receive normalized span batches    |
| `runtime`      | `/api/runtime`      | Receive process metrics            |
| `snapshot`     | `/api/snapshot`     | Return the live dashboard snapshot |
| `architecture` | `/api/architecture` | Return the derived architecture    |
| `health`       | `/api/health`       | Collector health check             |
| `websocket`    | `/ws`               | Push live collector messages       |

## Type usage

Direct consumers can use the package to keep integrations aligned with NodeFlow's contracts:

```ts
import {
  collectorPaths,
  type NodeFlowSnapshot,
  type SpanBatch,
} from '@mshamed1/node-flow-protocol';

async function sendBatch(origin: string, batch: SpanBatch): Promise<void> {
  await fetch(`${origin}${collectorPaths.spans}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batch),
  });
}

function countComponents(snapshot: NodeFlowSnapshot): number {
  return snapshot.nodes.length;
}
```

## Version and validation boundary

The protocol defines the shape of `NodeFlowSnapshot`, while
[`@mshamed1/node-flow-topology-engine`](https://github.com/msHamed1/node-flow/tree/main/packages/topology-engine#readme)
owns runtime validation, normalization, serialization, comparison, and the currently supported
snapshot version.

TypeScript types disappear at runtime. Any snapshot or collector payload arriving from disk or the
network must still be validated at the receiving boundary.

## Compatibility guidance

- Treat published fields and literal unions as wire contracts, not internal implementation details.
- Add optional fields when possible so older readers can continue processing payloads.
- Increment the snapshot schema version for incompatible persisted-format changes.
- Keep endpoint paths centralized in `collectorPaths` to prevent producer/consumer drift.
