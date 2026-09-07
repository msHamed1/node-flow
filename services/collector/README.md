# NodeFlow Go collector

The V2 collector is NodeFlow's runtime-neutral ingestion boundary. It accepts versioned Protobuf or
legacy JSON telemetry, validates and sanitizes it, applies bounded backpressure, batches admitted
work through a fixed worker pool, and forwards it to a topology sink.

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
bounded admission queue ── full → HTTP 429
    ↓
size/time batcher
    ↓
fixed worker pool
    ↓
TelemetrySink
    ↓
TypeScript topology engine and dashboard
```

Successful `202 Accepted` responses mean the envelope has entered the bounded in-memory queue;
they do not mean the downstream topology sink has committed it. This keeps a slow sink from
starving the upstream OpenTelemetry export queue. Processing failures after admission are exposed
through structured logs and `nodeflow_collector_processing_errors_total`. The current increment has
no durable spool or automatic downstream retry, so admitted data can be lost on a sink failure or
hard process termination.

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

| Method and path      | Purpose                                                      |
| -------------------- | ------------------------------------------------------------ |
| `POST /v1/telemetry` | Preferred `nodeflow.v1.TelemetryEnvelope` Protobuf ingestion |
| `POST /api/spans`    | Existing JSON `SpanBatch` compatibility adapter              |
| `POST /api/runtime`  | Existing JSON `RuntimeMetrics` compatibility adapter         |
| `GET /healthz`       | Go process liveness                                          |
| `GET /api/health`    | Legacy health-path alias                                     |
| `GET /readyz`        | Admission and topology-sink readiness                        |
| `GET /metrics`       | Prometheus text-format collector metrics                     |

The Protobuf endpoint accepts `application/x-protobuf` and `application/octet-stream`. Request
bodies default to a 2 MiB maximum. An envelope is also bounded to 2,048 spans, 128 attributes per
span, and bounded identifier/name/value lengths.

## Configuration

| Environment variable        | Default                 | Meaning                                               |
| --------------------------- | ----------------------- | ----------------------------------------------------- |
| `NODEFLOW_GO_LISTEN_ADDR`   | `:4318`                 | HTTP bind address                                     |
| `NODEFLOW_TOPOLOGY_URL`     | `http://127.0.0.1:7331` | TypeScript topology/dashboard process                 |
| `NODEFLOW_WORKERS`          | `min(GOMAXPROCS, 32)`   | Fixed sink worker count                               |
| `NODEFLOW_QUEUE_SIZE`       | `10000`                 | Maximum admitted envelopes awaiting batching          |
| `NODEFLOW_BATCH_SIZE`       | `250`                   | Target telemetry events per worker batch              |
| `NODEFLOW_FLUSH_INTERVAL`   | `500ms`                 | Maximum wait before flushing a partial batch          |
| `NODEFLOW_MAX_BODY_BYTES`   | `2097152`               | Maximum request body                                  |
| `NODEFLOW_SINK_TIMEOUT`     | `5s`                    | Timeout for each downstream HTTP operation            |
| `NODEFLOW_SHUTDOWN_TIMEOUT` | `15s`                   | Drain deadline after SIGINT/SIGTERM                   |
| `NODEFLOW_LOG_LEVEL`        | `info`                  | `debug`, `info`, `warn`, or `error`                   |
| `NODEFLOW_SINK`             | `http`                  | `http`; `discard` is reserved for isolated load tests |

Queue exhaustion rejects immediately with HTTP 429 and `Retry-After: 1`. The collector does not
block an unbounded number of sockets or report dropped work as successful.

## Graceful shutdown

SIGINT or SIGTERM closes admission before the HTTP listener drains, flushes the partial batch,
lets workers finish queued sink calls within the shutdown deadline, closes idle sink connections,
and exits. New requests during shutdown receive HTTP 503.

## Metrics

The Prometheus-compatible surface includes received, processed, and rejected event totals; queue
depth; active workers; worker errors; batch size; processing latency; downstream topology node and
edge counts; heap allocation; goroutines; and process CPU seconds.

## Container

Build and run the multi-stage image:

```bash
docker build -f Dockerfile.collector -t nodeflow-collector:local .
docker run --rm \
  -p 127.0.0.1:4318:4318 \
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

See [the measured V2 ingestion baseline](../../docs/benchmarks/go-collector-2026-09-03.md).
