# NodeFlow V2 collector migration design

Status: accepted for the first V2 migration increment

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
- a bounded admission queue with rejection when full;
- timed batching and a fixed-size worker pool;
- admission acknowledgement, cancellation, and graceful draining;
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

The initial `TelemetrySink` forwards compatible JSON to the existing endpoints. A successful
client response acknowledges bounded in-memory admission, not downstream topology commit. Waiting
for the sink here serializes the Node OpenTelemetry batch processor behind the bridge's flush
interval and can overflow its own queue during bursts. Downstream failures after admission are
therefore reported through collector metrics and structured logs. There is no durable spool or
automatic downstream retry in this increment.

The Go service intentionally does not inspect `TopologyEngine` maps or reproduce its algorithms.
`TopologyEngine.createSnapshot()` remains the stable derived-architecture boundary.

## Backpressure policy

The default policy is immediate rejection. When the queue is full the collector returns HTTP 429
with `Retry-After: 1`; during shutdown it returns HTTP 503. Blocking request handlers would move an
unbounded backlog into sockets and instrumentation exporters, while rejecting reports work that
never entered NodeFlow. Explicit rejection is bounded, observable, and lets the existing
OpenTelemetry exporter report failure.

Queue capacity counts admitted envelopes. Request bodies and per-envelope span/attribute counts are
also bounded, so a queue limit represents a real memory boundary rather than only a request count.

## Compatibility risks and controls

| Risk                                             | Control                                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Protobuf readers and writers drift               | Versioned package and envelope, checked-in generated clients, generation check in CI                                              |
| Existing clients only speak JSON                 | Preserve both legacy ingestion paths; keep revision-aware clients on the TypeScript endpoint because Go returns admission only    |
| Topology changes during infrastructure migration | Keep the existing TypeScript engine and assert Go-to-TypeScript parity in integration tests                                       |
| Out-of-order worker completion                   | The existing engine already correlates children arriving before parents; runtime forwarding keeps the newest sample in each batch |
| Sensitive attributes cross the new boundary      | Redact before TypeScript export and again after Go decoding; test headers, cookies, tokens, URLs, bodies, and database statements |
| Queue saturation hides data loss                 | Reject with 429 and expose received, processed, rejected, queue, error, and latency metrics                                       |
| CLI/npm portability regresses                    | Do not embed a platform-specific Go executable in the npm package in this increment                                               |

## Migration sequence

1. Add `nodeflow.v1` telemetry and topology schemas plus generated Go and TypeScript support.
2. Add the Go ingestion service behind the `TelemetrySink` interface, with bounded admission,
   batching, workers, metrics, and draining shutdown.
3. Add opt-in Protobuf export to Node instrumentation while retaining JSON defaults.
4. Run the Go service in Docker Compose in front of the unchanged TypeScript topology/dashboard
   service and assert the complete existing integration topology.
5. Collect parity and load evidence. Keep both collector choices supported throughout V2 adoption.
6. Only after semantic parity is explicit, decide whether to implement a Go topology sink or keep
   topology reconstruction in TypeScript as a separately versioned service.
