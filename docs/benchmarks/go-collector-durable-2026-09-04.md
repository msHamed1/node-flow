# Go collector durable-admission comparison — 2026-09-04

These are measured local results, not projections or maximum-capacity claims. They intentionally
show the cost of the first durable spool implementation.

## Method

- Host: Darwin x86_64
- Go: 1.25.3
- Collector: 20 workers, queue 10,000 envelopes, batch 250 events, flush interval 500 ms
- Transport: loopback HTTP with `nodeflow.v1.TelemetryEnvelope` Protobuf
- Payload: 50 normalized spans per request, 32 load-generator workers
- Requested duration: 5 seconds at each rate
- Sink: benchmark-only discard sink, isolating collector admission from TypeScript topology cost
- Modes: `NODEFLOW_SPOOL_MODE=memory` and `durable`; durable used a fresh local temporary directory
  and a 1 GiB cap
- Sampling: heap, queue depth, and allocated spool bytes every 100 ms. CPU covers admission plus the
  post-admission catch-up interval.

The load generator records its real admission duration. When durable storage cannot sustain the
requested schedule, the duration stretches instead of discarding scheduled requests. It also waits
up to 30 seconds after admission for every accepted event to reach the sink and reports that catch-up
time separately.

## Results

| Mode    | Target events/s | Actual admitted/s |    HTTP p50 |    HTTP p95 |    CPU |   Peak heap |   Peak spool | Rejected |     Catch-up |
| ------- | --------------: | ----------------: | ----------: | ----------: | -----: | ----------: | -----------: | -------: | -----------: |
| memory  |           1,000 |            999.71 |     0.51 ms |     0.66 ms |  1.62% | 3,669,376 B |          0 B |        0 |    400.45 ms |
| durable |           1,000 |            992.64 |    38.74 ms |    49.09 ms |  5.30% | 3,488,408 B |     49,152 B |        0 |    425.51 ms |
| memory  |          10,000 |          9,997.36 |     0.35 ms |     0.55 ms | 10.34% | 2,252,704 B |          0 B |        0 |      0.20 ms |
| durable |          10,000 |          1,288.30 | 1,232.87 ms | 1,311.09 ms |  7.00% | 4,620,664 B | 11,931,648 B |        0 |  4,200.84 ms |
| memory  |          50,000 |         49,994.84 |     0.29 ms |     0.51 ms | 43.91% | 3,478,024 B |          0 B |        0 |      0.27 ms |
| durable |          50,000 |          1,263.12 | 1,253.47 ms | 1,372.74 ms |  6.84% | 5,636,568 B | 59,596,800 B |        0 | 21,025.49 ms |

Every row processed all accepted events: 5,000, 50,000, and 250,000 respectively. No request was
rejected or failed, and the discard sink caused no retries. The durable 10k and 50k runs took 38.81
and 197.92 seconds to admit their scheduled workloads, so their low CPU percentages represent time
waiting on synchronous storage, not spare throughput capacity.

## Interpretation

Memory admission sustained all requested rates with sub-millisecond p95. The per-envelope durable
format sustained roughly 1.26–1.29k events/s once saturated, while preserving all data.
At 1k events/s it stayed on rate, but p95 increased from 0.66 ms to 49.09 ms. At higher targets,
synchronous file and directory checkpoints became the bottleneck and the spool grew until workers
caught up.

This is the honest cost of the simple recovery model. It is suitable for correctness validation and
lower-volume local use, but it is not an acceptable replacement for the 50k events/s memory path.
Before production-scale adoption, the spool should evolve to segmented append-only storage with
group commit and bounded compaction, then repeat this comparison.

## Retry and recovery evidence

The Compose durability test stopped the TypeScript sink, admitted a probe with `202`, observed an
active spool record and at least one retry, force-killed the Go collector with `SIGKILL`, restarted
both processes, and observed four recovered records and an empty active spool in the final clean
run. Runtime telemetry accounted for the records beyond the explicit probe. The resulting
TypeScript topology contained exactly one `DurableReplayProbe` call.

Unit tests additionally cover persisted retry attempts, exponential retry exhaustion, permanent
failure quarantine, allocated-byte exhaustion, incomplete temp cleanup, duplicate record IDs, and
CRC corruption quarantine.

## Reproduce

Run the collector once per mode, using the same load commands:

```bash
NODEFLOW_SINK=discard NODEFLOW_SPOOL_MODE=memory go run ./cmd/nodeflow-collector

NODEFLOW_SINK=discard \
NODEFLOW_SPOOL_MODE=durable \
NODEFLOW_SPOOL_DIR=/path/to/fresh/spool \
NODEFLOW_SPOOL_MAX_BYTES=1073741824 \
go run ./cmd/nodeflow-collector

go run ./cmd/loadgen -rate 1000 -duration 5s -events-per-request 50 -concurrency 32
go run ./cmd/loadgen -rate 10000 -duration 5s -events-per-request 50 -concurrency 32
go run ./cmd/loadgen -rate 50000 -duration 5s -events-per-request 50 -concurrency 32
```

The historical memory-only baseline remains in
[`go-collector-2026-09-03.md`](./go-collector-2026-09-03.md). It used 8 workers and different
concurrency at two rates, so the table above is the controlled before/after comparison.
