# NodeFlow V2 collector migration design

Status: historical V2.1/V2.2 collector migration record; Go topology cutover completed by ADR 0004

## Current collector responsibilities

The TypeScript collector in `apps/collector` currently owns four concerns in one process:

1. It receives normalized span batches at `POST /api/spans` and runtime samples at
   `POST /api/runtime` as JSON. The Node.js instrumentation normalizes completed OpenTelemetry
   spans and sends batches of at most 64 spans every 250 ms.
2. It constructs and owns one `TopologyEngine`, registering application metadata and passing spans
   and runtime samples into that engine synchronously.
3. It exposes live and persisted projections at `GET /api/snapshot` and
   `GET /api/architecture`, then broadcasts live snapshots over `/ws`.
4. It serves the built React dashboard. The CLI starts this process in memory and injects the
   instrumentation preload into the application it launches.

The collector does not currently have a bounded ingress queue, worker pool, explicit backpressure,
collector metrics, or a draining shutdown phase. Express limits a request body to 2 MiB, while the
topology engine independently bounds recent traces, latency samples, and runtime paths.

## Boundary chosen for the first Go increment

The first Go service owns the runtime-agnostic collector infrastructure:

- versioned Protobuf and legacy JSON ingestion;
- transport validation and a second redaction boundary;
- a bounded, restart-safe segmented WAL with group commit and rejection when its disk budget is full;
- timed batching and a fixed-size worker pool;
- per-service ordering, checkpointed retry, startup replay, corruption quarantine, and graceful
  draining;
- structured lifecycle logs and Prometheus-compatible internal metrics;
- health, readiness, and load-generator surfaces.

The service forwards accepted telemetry through a small `TelemetrySink` interface. The first sink
is an HTTP compatibility bridge to the existing TypeScript collector/topology process. It groups
span batches by application before forwarding them, and retains only the newest runtime sample per
application within a worker batch.

This is intentional separation, not a line-for-line port. Go becomes the public ingestion and
backpressure boundary. TypeScript remains the semantic architecture projection until a later
decision is supported by parity evidence.

## What remains TypeScript

- Node.js/OpenTelemetry preload, span normalization, and runtime measurement.
- HTTP, Express, Undici, MongoDB, Mongoose, PostgreSQL, Redis, and AMQP instrumentation.
- NestJS discovery and controller/provider semantic instrumentation.
- Optional application-side `nodeflow.span()` and `traceBoundary()` APIs.
- `TopologyEngine` semantic identity, trace correlation, dependency reconstruction, percentile
  aggregation, runtime paths, live snapshots, and versioned architecture snapshots.
- WebSocket publication, dashboard hosting, the React dashboard, and the current npm CLI-managed
  local experience.

The TypeScript collector is not deprecated or removed in this increment. Existing npm users keep
the same default CLI behavior.

## Communication boundaries

### Node.js instrumentation to Go

The preferred V2 boundary is:

```text
POST /v1/telemetry
Content-Type: application/x-protobuf
Body: nodeflow.v1.TelemetryEnvelope
```

The envelope carries an explicit `protocol_version` and exactly one span batch or runtime sample.
Its fields are derived from the existing `SpanBatch`, `TelemetrySpan`, and `RuntimeMetrics`
contracts. Topology concepts continue to travel as the existing span kind and `nodeflow.*`
metadata; the protocol does not add speculative framework models.

During migration the Go service also accepts the existing JSON paths, `POST /api/spans` and
`POST /api/runtime`. Instrumentation selects Protobuf with `NODEFLOW_EXPORT_PROTOCOL=protobuf`;
JSON remains the default while the Go service is optional.

### Go collector to TypeScript topology process

The initial `TelemetrySink` forwards compatible JSON to the existing endpoints. In default
`group-commit` mode, a successful client response acknowledges a synced WAL data group, not
downstream topology commit. The bridge retries transient failures with exponential backoff and
jitter, then checkpoints a record only after a successful sink response. Startup replays valid
unacknowledged records. Permanent HTTP failures and records that exhaust the configured attempt
budget are checkpointed as quarantined for inspection.

This is at-least-once delivery. The crash window between sink success and the removal checkpoint can
replay an already delivered record. The TypeScript topology engine currently deduplicates span IDs
only while the containing trace remains in its bounded in-memory history. It is not a durable
idempotency ledger.

The Go service intentionally does not inspect `TopologyEngine` maps or reproduce its algorithms.
`TopologyEngine.createSnapshot()` remains the stable derived-architecture boundary.

## Backpressure policy

The WAL caps logical segment and checkpoint bytes and reserves enough capacity for admitted records'
remaining checkpoint transitions. When the cap is exhausted the collector returns HTTP 507 with
`Retry-After: 5`; during shutdown it returns HTTP 503. Blocking request handlers would move an
unbounded backlog into sockets and instrumentation exporters, while explicit rejection reports work
that never entered NodeFlow.

The in-memory queue controls only the dispatch working set and refills from disk. Request bodies and
per-envelope span/attribute counts remain bounded. The optional `memory` spool mode retains the
original queue-full HTTP 429 behavior for controlled comparisons; it is not the safe default.

## Compatibility risks and controls

| Risk                                             | Control                                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Protobuf readers and writers drift               | Versioned package and envelope, checked-in generated clients, generation check in CI                                              |
| Existing clients only speak JSON                 | Preserve both legacy ingestion paths; keep revision-aware clients on the TypeScript endpoint because Go returns admission only    |
| Topology changes during infrastructure migration | Keep the existing TypeScript engine and assert Go-to-TypeScript parity in integration tests                                       |
| Out-of-order worker completion                   | Service-name sharding preserves per-service admission order; the engine still reconciles children arriving before parents         |
| Sensitive attributes cross the new boundary      | Redact before TypeScript export and again after Go decoding; test headers, cookies, tokens, URLs, bodies, and database statements |
| Disk saturation hides data loss                  | Reject with 507 and expose spool bytes, active/quarantined records, rejections, retries, replay, and permanent failures           |
| Replay duplicates topology metrics               | At-least-once is explicit; golden tests cover retained-trace span deduplication, while durable idempotency remains a known gap    |
| CLI/npm portability regresses                    | Do not embed a platform-specific Go executable in the npm package in this increment                                               |

## Migration sequence

1. Add `nodeflow.v1` telemetry and topology schemas plus generated Go and TypeScript support.
2. Add the Go ingestion service behind the `TelemetrySink` interface, with bounded admission,
   batching, workers, metrics, and draining shutdown.
3. Add opt-in Protobuf export to Node instrumentation while retaining JSON defaults.
4. Run the Go service in Docker Compose in front of the unchanged TypeScript topology/dashboard
   service and assert the complete existing integration topology.
5. Define a compact canonical topology corpus and add a bounded durable spool with restart replay.
6. Replace per-envelope files with a segmented WAL and collect memory, legacy, and WAL load evidence.
7. Only after an independent Go engine passes the corpus, decide whether to implement a Go topology sink or keep
   topology reconstruction in TypeScript as a separately versioned service.
