# NodeFlow Go collector

The V2 collector is NodeFlow's runtime-neutral ingestion boundary. It accepts versioned Protobuf or
legacy JSON telemetry, validates and sanitizes it, durably admits it to a bounded disk spool,
batches work through service-sharded workers, and forwards it to a topology sink.

The first V2 release uses the existing TypeScript collector/topology process as that sink. This is
deliberate: topology identity, trace correlation, runtime paths, WebSocket publication, and
dashboard hosting stay unchanged while the ingestion architecture gains a production service
boundary.

## Processing lifecycle

```text
HTTP receive
    ↓
decode → validate → sanitize
    ↓
append record → fsync file → atomic rename → fsync directory
    │                                      └─ disk budget full → HTTP 507
    ↓
bounded in-memory dispatch window
    ↓
service-sharded batch workers
    ↓
TelemetrySink
    │ failure → checkpoint attempt → exponential backoff with jitter
    ↓
TypeScript topology engine and dashboard
    ↓ success
remove record → fsync directory
```

With the default `durable` spool mode, `202 Accepted` means the sanitized envelope and its directory
entry have been synced to disk. It does not mean the downstream topology sink has committed it.
Transient sink failures are retried; unacknowledged records are replayed after restart. Successful
sink delivery followed by a crash before the removal checkpoint can replay a record, so delivery is
at least once, not exactly once.

`NODEFLOW_SPOOL_MODE=memory` retains the original bounded-memory admission behavior for controlled
benchmarks and compatibility testing. In that mode, `202` means only in-memory admission and a hard
termination can lose accepted data.

## Run locally

Build the TypeScript topology process from the repository root and start it:

```bash
yarn build
node packages/cli/dist/cli.js collector
```

In another terminal:

```bash
cd services/collector
go run ./cmd/nodeflow-collector
```

Point an instrumented application at the Go boundary:

```bash
NODEFLOW_COLLECTOR_URL=http://127.0.0.1:4318 \
NODEFLOW_EXPORT_PROTOCOL=protobuf \
npx node-flow run -- npm run start:dev
```

The dashboard remains at `http://127.0.0.1:7331`; collector health and metrics are at
`http://127.0.0.1:4318/healthz` and `http://127.0.0.1:4318/metrics`.

For the complete repository lab, `docker compose up --build --wait` starts the Go collector,
TypeScript topology/dashboard process, Node.js API and worker, and all test infrastructure.

## Endpoints

| Method and path      | Purpose                                                         |
| -------------------- | --------------------------------------------------------------- |
| `POST /v1/telemetry` | Preferred `nodeflow.v1.TelemetryEnvelope` Protobuf ingestion    |
| `POST /api/spans`    | Existing JSON `SpanBatch` compatibility adapter                 |
| `POST /api/runtime`  | Existing JSON `RuntimeMetrics` compatibility adapter            |
| `GET /healthz`       | Go process liveness                                             |
| `GET /api/health`    | Legacy health-path alias                                        |
| `GET /readyz`        | Admission readiness; durable mode is independent of sink health |
| `GET /metrics`       | Prometheus text-format collector metrics                        |

The Protobuf endpoint accepts `application/x-protobuf` and `application/octet-stream`. Request
bodies default to a 2 MiB maximum. An envelope is also bounded to 2,048 spans, 128 attributes per
span, and bounded identifier/name/value lengths.

## Configuration

| Environment variable             | Default                 | Meaning                                                  |
| -------------------------------- | ----------------------- | -------------------------------------------------------- |
| `NODEFLOW_GO_LISTEN_ADDR`        | `:4318`                 | HTTP bind address                                        |
| `NODEFLOW_TOPOLOGY_URL`          | `http://127.0.0.1:7331` | TypeScript topology/dashboard process                    |
| `NODEFLOW_WORKERS`               | `min(GOMAXPROCS, 32)`   | Service-sharded sink worker count                        |
| `NODEFLOW_QUEUE_SIZE`            | `10000`                 | In-memory dispatch window; not the durable capacity      |
| `NODEFLOW_BATCH_SIZE`            | `250`                   | Target telemetry events per worker batch                 |
| `NODEFLOW_FLUSH_INTERVAL`        | `500ms`                 | Maximum wait before flushing a partial batch             |
| `NODEFLOW_MAX_BODY_BYTES`        | `2097152`               | Maximum request body                                     |
| `NODEFLOW_SINK_TIMEOUT`          | `5s`                    | Timeout for each downstream HTTP operation               |
| `NODEFLOW_SHUTDOWN_TIMEOUT`      | `15s`                   | Drain deadline after SIGINT/SIGTERM                      |
| `NODEFLOW_LOG_LEVEL`             | `info`                  | `debug`, `info`, `warn`, or `error`                      |
| `NODEFLOW_SINK`                  | `http`                  | `http`; `discard` is reserved for isolated load tests    |
| `NODEFLOW_SPOOL_MODE`            | `durable`               | `durable` or benchmark-only `memory` admission           |
| `NODEFLOW_SPOOL_DIR`             | `.nodeflow/spool`       | Active and quarantined durable records                   |
| `NODEFLOW_SPOOL_MAX_BYTES`       | `536870912`             | Allocated-byte cap across active and quarantined records |
| `NODEFLOW_RETRY_INITIAL_BACKOFF` | `100ms`                 | First transient-failure delay                            |
| `NODEFLOW_RETRY_MAX_BACKOFF`     | `30s`                   | Exponential-backoff ceiling                              |
| `NODEFLOW_RETRY_MAX_ATTEMPTS`    | `10`                    | Total sink attempts before quarantine                    |
| `NODEFLOW_RETRY_JITTER`          | `0.2`                   | Symmetric jitter fraction from `0` to `1`                |

Durable spool exhaustion rejects with HTTP 507 and `Retry-After: 5`; it never reports an
uncommitted record as accepted. Memory-mode queue exhaustion returns HTTP 429 and `Retry-After: 1`.
Corrupt and permanently failing records move to `spool/quarantine` and continue consuming the disk
budget until an operator inspects and removes them. The cap covers committed and quarantined file
allocation. Because allocation is known only after a temp record is written, one serialized
in-progress admission can transiently consume up to one request body beyond the configured cap; the
temp file is removed if the commit would exceed the budget.

## Graceful shutdown

SIGINT or SIGTERM closes admission before the HTTP listener drains and gives workers the configured
deadline to deliver the active spool. If the deadline expires, active records remain on disk for
startup replay. New requests during shutdown receive HTTP 503.

## Metrics

The Prometheus-compatible surface includes received, processed, and rejected event totals; queue
depth; active workers; worker errors; batch size; processing latency; spool allocated bytes, active
and quarantined records, retries, startup replay, corruptions, permanent failures, and dropped
records; downstream topology size; heap allocation; goroutines; and process CPU seconds.

## Container

Build and run the multi-stage image:

```bash
docker build -f Dockerfile.collector -t nodeflow-collector:local .
docker run --rm \
  -p 127.0.0.1:4318:4318 \
  -v nodeflow-spool:/var/lib/nodeflow \
  -e NODEFLOW_SPOOL_DIR=/var/lib/nodeflow/spool \
  -e NODEFLOW_TOPOLOGY_URL=http://host.docker.internal:7331 \
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
NODEFLOW_SINK=discard go run ./cmd/nodeflow-collector
go run ./cmd/loadgen -rate 10000 -duration 10s -events-per-request 50
```

See [the measured durable-admission comparison](../../docs/benchmarks/go-collector-durable-2026-09-04.md).
