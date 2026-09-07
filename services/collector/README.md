# NodeFlow Go collector

The V2 collector is NodeFlow's runtime-neutral ingestion boundary. It accepts versioned Protobuf or
legacy JSON telemetry, validates and sanitizes it, durably admits it to a bounded disk spool,
batches work through service-sharded workers, reconstructs the authoritative topology in Go, and
serves the snapshot API, WebSocket stream, and built React dashboard.

The TypeScript topology engine remains a reference and emergency rollback implementation. It is not
started or called by the default container path.

## Processing lifecycle

```text
HTTP receive
    ↓
decode → validate → sanitize
    ↓
append versioned record(s) → CRC group marker → fsync WAL segment
    │                                      └─ disk budget/reservation full → HTTP 507
    ↓
bounded in-memory dispatch window
    ↓
service-sharded batch workers
    ↓
TelemetrySink
    │ failure → checkpoint attempt → exponential backoff with jitter
    ↓ normalized topology events
Go TopologyEngine
    ↓
atomic state-file fsync + rename + directory fsync
    ↓
snapshot REST / WebSocket / dashboard
    ↓ success
append acknowledgement → fsync checkpoint → delete fully acknowledged segment
```

With the default `group-commit` mode, `202 Accepted` means the sanitized envelope, its CRC-protected
record frame, and the enclosing commit marker have completed `fsync` on the active WAL segment.
Several requests may cross that boundary in one sync. It does not mean the downstream topology sink
has committed the record.
Transient sink failures are retried; unacknowledged records are replayed after restart. Successful
topology checkpointing followed by a crash before WAL removal can replay a record, so delivery is at
least once, not exactly once. The checkpoint restores the current bounded span-ID deduplication set,
preventing that crash window from inflating current metrics while the trace remains retained.

`sync` uses the same WAL format with one record per commit. `legacy` retains V2.1's per-envelope
temp-write/fsync/rename/directory-sync implementation for comparisons. `memory` retains bounded
memory admission. In memory mode, `202` means only in-memory admission and hard termination can lose
accepted data. `durable` remains an alias for `group-commit`.

## Run locally

Build the dashboard from the repository root:

```bash
yarn workspace @mshamed1/node-flow-dashboard build
```

In another terminal:

```bash
cd services/collector
NODEFLOW_DASHBOARD_DIR=../../apps/dashboard/dist go run ./cmd/nodeflow-collector
```

Point an instrumented application at the Go boundary:

```bash
NODEFLOW_COLLECTOR_URL=http://127.0.0.1:7331 \
NODEFLOW_EXPORT_PROTOCOL=protobuf \
npx node-flow run -- npm run start:dev
```

The dashboard, collector, topology APIs, health, and metrics are served from
`http://127.0.0.1:7331` by default.

For the complete repository lab, `docker compose up --build --wait` starts the Go collector and
topology authority, Node.js API and worker, and all test infrastructure. It does not start the
TypeScript backend.

## Endpoints

| Method and path         | Purpose                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `POST /v1/telemetry`    | Preferred `nodeflow.v1.TelemetryEnvelope` Protobuf ingestion    |
| `POST /api/spans`       | Existing JSON `SpanBatch` compatibility adapter                 |
| `POST /api/runtime`     | Existing JSON `RuntimeMetrics` compatibility adapter            |
| `GET /healthz`          | Go process liveness                                             |
| `GET /api/health`       | Legacy health-path alias                                        |
| `GET /readyz`           | Admission readiness; durable mode is independent of sink health |
| `GET /metrics`          | Prometheus text-format collector metrics                        |
| `GET /api/snapshot`     | Authoritative live topology for the dashboard                   |
| `GET /api/architecture` | Stable version `1.0` architecture snapshot                      |
| `GET /ws`               | `connected` plus live `snapshot` WebSocket messages             |
| `GET /`                 | Built dashboard with single-page-app fallback                   |

The Protobuf endpoint accepts `application/x-protobuf` and `application/octet-stream`. Request
bodies default to a 2 MiB maximum. An envelope is also bounded to 2,048 spans, 128 attributes per
span, and bounded identifier/name/value lengths.

## Configuration

| Environment variable             | Default                       | Meaning                                                 |
| -------------------------------- | ----------------------------- | ------------------------------------------------------- |
| `NODEFLOW_GO_LISTEN_ADDR`        | `:7331`                       | HTTP bind address                                       |
| `NODEFLOW_TOPOLOGY_ENGINE`       | `go`                          | Go authority or emergency `typescript` rollback         |
| `NODEFLOW_TOPOLOGY_URL`          | `http://127.0.0.1:7331`       | TypeScript rollback target                              |
| `NODEFLOW_TOPOLOGY_STATE_PATH`   | `<spool>/topology-state.json` | Atomic Go topology checkpoint                           |
| `NODEFLOW_DASHBOARD_DIR`         | empty                         | Directory containing built dashboard assets             |
| `NODEFLOW_WORKERS`               | `min(GOMAXPROCS, 32)`         | Service-sharded sink worker count                       |
| `NODEFLOW_QUEUE_SIZE`            | `10000`                       | In-memory dispatch window; not the durable capacity     |
| `NODEFLOW_BATCH_SIZE`            | `250`                         | Target telemetry events per worker batch                |
| `NODEFLOW_FLUSH_INTERVAL`        | `500ms`                       | Maximum wait before flushing a partial batch            |
| `NODEFLOW_MAX_BODY_BYTES`        | `2097152`                     | Maximum request body                                    |
| `NODEFLOW_SINK_TIMEOUT`          | `5s`                          | Timeout for each downstream HTTP operation              |
| `NODEFLOW_SHUTDOWN_TIMEOUT`      | `15s`                         | Drain deadline after SIGINT/SIGTERM                     |
| `NODEFLOW_LOG_LEVEL`             | `info`                        | `debug`, `info`, `warn`, or `error`                     |
| `NODEFLOW_SINK`                  | `topology`                    | Direct topology; `http` rollback; benchmark `discard`   |
| `NODEFLOW_SPOOL_MODE`            | `group-commit`                | `group-commit`, `sync`, `legacy`, or `memory`           |
| `NODEFLOW_SPOOL_DIR`             | `.nodeflow/spool`             | WAL segments and durable checkpoints                    |
| `NODEFLOW_SPOOL_MAX_BYTES`       | `536870912`                   | Logical WAL/checkpoint cap, including reserved metadata |
| `NODEFLOW_WAL_SEGMENT_BYTES`     | `16777216`                    | Rotation threshold for each append-only WAL segment     |
| `NODEFLOW_WAL_GROUP_MAX_RECORDS` | `64`                          | Maximum records sharing one admission fsync             |
| `NODEFLOW_WAL_GROUP_MAX_DELAY`   | `2ms`                         | Maximum delay from first queued record to group fsync   |
| `NODEFLOW_WAL_APPEND_QUEUE_SIZE` | `2048`                        | Bounded admission requests waiting for the WAL writer   |
| `NODEFLOW_RETRY_INITIAL_BACKOFF` | `100ms`                       | First transient-failure delay                           |
| `NODEFLOW_RETRY_MAX_BACKOFF`     | `30s`                         | Exponential-backoff ceiling                             |
| `NODEFLOW_RETRY_MAX_ATTEMPTS`    | `10`                          | Total sink attempts before quarantine                   |
| `NODEFLOW_RETRY_JITTER`          | `0.2`                         | Symmetric jitter fraction from `0` to `1`               |

WAL exhaustion rejects with HTTP 507 and `Retry-After: 5`; a full bounded append queue returns HTTP
429 and `Retry-After: 1`. The cap covers segment and checkpoint bytes plus space reserved for every
admitted record's remaining retry/terminal checkpoints, so ordinary retry or acknowledgement writes
cannot push the WAL beyond its configured logical bound. Permanently failing records are checkpointed
as quarantined and keep their containing segment live for inspection. Fully acknowledged segments
are deleted and the directory is synced. Committed checksum or framing corruption stops startup or
readiness; it is never silently discarded. Only an incomplete uncommitted final group or partial
checkpoint entry is truncated during recovery.

The WAL refuses to start over undrained V2.1 per-envelope files. Run `legacy` mode to drain them, or
archive them and select a clean directory, before enabling the WAL. This prevents an upgrade from
silently stranding previously accepted telemetry.

The Go topology checkpoint is an atomic replacement file rather than a second log. A committed
checkpoint with a CRC mismatch, invalid JSON, or unsupported format version stops startup explicitly.
Checkpoint write failure keeps the telemetry record active and enters the normal retry/quarantine
path. Its size is observable but is not counted inside `NODEFLOW_SPOOL_MAX_BYTES`; deployments must
leave room for the current file and its temporary replacement on the same bounded filesystem.

## Graceful shutdown

SIGINT or SIGTERM closes admission before the HTTP listener drains and gives workers the configured
deadline to deliver the active spool. If the deadline expires, active records remain on disk for
startup replay. New requests during shutdown receive HTTP 503.

## Emergency TypeScript rollback

Start Compose with the rollback profile and select the TypeScript authority:

```bash
NODEFLOW_TOPOLOGY_ENGINE=typescript \
  docker compose --profile typescript-rollback up -d --build --wait
```

The Go collector continues to own admission, WAL, and retry; it forwards normalized telemetry
through the retained HTTP sink and proxies snapshot, architecture, and WebSocket reads. No schema or
WAL migration is needed. This deliberately does not dual-write: switching back to Go resumes the
last Go checkpoint and does not import topology accumulated during rollback.

## Metrics

The Prometheus-compatible surface includes received, processed, and rejected event totals; queue
depth; active workers; worker errors; batch size; processing latency; durable retries and permanent
failures; WAL bytes, segment and pending counts, append/fsync latency, records per group commit,
startup replay, compaction count/latency, corruption, and disk-pressure rejections; downstream
topology size and update count; topology checkpoint size and latency; heap, cumulative allocated
bytes and allocations; goroutines; and process CPU seconds.

## Container

Build and run the multi-stage image:

```bash
docker build -f Dockerfile.collector -t nodeflow-collector:local .
docker run --rm \
  -p 127.0.0.1:7331:7331 \
  -v nodeflow-spool:/var/lib/nodeflow \
  -e NODEFLOW_SPOOL_DIR=/var/lib/nodeflow/spool \
  -e NODEFLOW_TOPOLOGY_STATE_PATH=/var/lib/nodeflow/topology-state.json \
  nodeflow-collector:local
```

The image uses a statically linked Go binary, an unprivileged runtime user, and a minimal Alpine
runtime with CA certificates. Do not publish the collector to an untrusted network; V2 does not yet
include authentication or transport encryption for its local development boundary.

## Verification

```bash
go build ./...
go vet ./...
go test ./...
go test -race ./...
go test -run '^$' -bench BenchmarkPipeline -benchmem ./internal/pipeline
```

`cmd/loadgen` sends real Protobuf HTTP traffic at a target event rate. Use the discard sink only to
isolate ingestion capacity:

```bash
NODEFLOW_GO_LISTEN_ADDR=:4318 NODEFLOW_SINK=discard go run ./cmd/nodeflow-collector
go run ./cmd/loadgen -target http://127.0.0.1:4318 -rate 10000 -duration 10s -events-per-request 50
```

See [the segmented-WAL comparison](../../docs/benchmarks/go-collector-wal-2026-09-04.md).
