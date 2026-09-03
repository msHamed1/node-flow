# Go collector ingestion baseline — 2026-09-03

These are measured local results, not projections and not a maximum-capacity claim.

## Method

- Host: Darwin x86_64, Intel Xeon W-2150B at 3.00 GHz
- Go: 1.25.3
- Collector: 8 workers, queue 10,000 envelopes, batch 250 events, flush interval 500 ms
- Transport: loopback HTTP with `nodeflow.v1.TelemetryEnvelope` Protobuf
- Payload: 50 normalized spans per request
- Duration: 5 seconds at each requested rate
- Sink: benchmark-only discard sink, isolating decode, validation, redaction, bounded admission,
  batching, workers, HTTP, and metrics from TypeScript topology cost
- The three rates ran against the same collector process. Peak heap is the maximum sampled Go heap
  allocation during each interval, not RSS or a retained-state bound.

## Results

| Target events/s | Actual events/s | Accepted | Rejected | Failed | HTTP p50 | HTTP p95 | Peak Go heap | Peak queue | Process CPU |
| --------------: | --------------: | -------: | -------: | -----: | -------: | -------: | -----------: | ---------: | ----------: |
|           1,000 |          999.64 |    5,000 |        0 |      0 |  0.49 ms |  0.84 ms |  3,622,936 B |          0 |       1.48% |
|          10,000 |        9,997.61 |   50,000 |        0 |      0 |  0.37 ms |  0.66 ms |  3,408,416 B |          0 |      10.52% |
|          50,000 |       49,994.67 |  250,000 |        0 |      0 |  0.29 ms |  0.51 ms |  2,403,864 B |          0 |      42.74% |

HTTP latency measures bounded admission acknowledgement, not downstream topology commit. That
semantic prevents the instrumentation export queue from being serialized behind the collector's
batch flush interval. Queue depth was sampled every 100 ms; a zero peak means no backlog was
observed at that sampling resolution, not that the channel was never momentarily non-empty.

The in-process pipeline microbenchmark on the same host produced:

```text
BenchmarkPipeline-20  21283  56183 ns/op  381 B/op  3 allocs/op
```

The clean Docker correctness run through the real HTTP topology bridge ended with 1,759 events
received and processed, zero queue/closed/invalid rejections, zero worker errors, an empty queue,
18 topology nodes, 21 topology edges, 2,394,288 bytes of Go heap, and 0.34405 process CPU seconds.
That scenario validated 100 transactions and 50 retained detailed traces; it is a correctness
observation, not a sustained end-to-end throughput measurement.

## Reproduce

```bash
cd services/collector
go build -o /tmp/nodeflow-collector ./cmd/nodeflow-collector
go build -o /tmp/nodeflow-loadgen ./cmd/loadgen

NODEFLOW_SINK=discard \
NODEFLOW_WORKERS=8 \
NODEFLOW_QUEUE_SIZE=10000 \
NODEFLOW_BATCH_SIZE=250 \
NODEFLOW_FLUSH_INTERVAL=500ms \
/tmp/nodeflow-collector

/tmp/nodeflow-loadgen -rate 1000 -duration 5s -events-per-request 50 -concurrency 16
/tmp/nodeflow-loadgen -rate 10000 -duration 5s -events-per-request 50 -concurrency 32
/tmp/nodeflow-loadgen -rate 50000 -duration 5s -events-per-request 50 -concurrency 64
```

An end-to-end capacity number must also include the HTTP compatibility bridge and TypeScript
topology engine. The Docker integration suite validates correctness through that complete path; it
is not yet a sustained topology throughput benchmark.
