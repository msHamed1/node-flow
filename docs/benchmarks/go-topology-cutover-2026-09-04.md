# Go topology production-path cutover benchmark — 2026-09-04

## Method

This comparison exercised the real container path rather than calling either engine directly:

```text
Protobuf HTTP → validation/redaction → segmented WAL → service worker → topology authority
→ topology commit/checkpoint → WAL acknowledgement → snapshot HTTP
```

Both modes used the same collector image and settings: 8 workers, 250-event batches, 10,000 queue
entries, 16 MiB WAL segments, 64-record/2 ms WAL group commit, 50 spans per HTTP envelope, and no
background application traffic. The host was macOS 15.6 on an Intel Xeon W-2150B with 20 logical
CPUs, Docker Desktop, Node.js 22.18.0, and Go 1.25.3.

`typescript` is the pre-cutover path selected through the emergency flag: Go collector/WAL → HTTP →
TypeScript engine. `go` is the new direct adapter plus atomic, fsynced topology-state checkpoint.
Each run used unique telemetry identity and sampled 200 snapshot HTTP requests after drain. These are
local engineering measurements, not a CI threshold.

## Results

| Target / duration | Authority  | admitted spans/s | topology updates/s |  HTTP p50 / p95 | processing catch-up | collector→topology p95 | snapshot p95 |  Go CPU | peak Go heap | Go allocated / allocs | topology checkpoint p95 / size |  peak WAL | rejected / retries |
| ----------------- | ---------- | ---------------: | -----------------: | --------------: | ------------------: | ---------------------: | -----------: | ------: | -----------: | --------------------: | -----------------------------: | --------: | -----------------: |
| 5k/s / 10s        | TypeScript |         4,994.87 |              19.87 |  6.24 / 9.22 ms |            52.83 ms |                ≤250 ms |     23.97 ms |  94.91% |     4.64 MiB |      1.24 GiB / 6.39M |                            n/a | 16.80 MiB |              0 / 0 |
| 5k/s / 10s        | Go         |         4,995.74 |              19.88 |  6.24 / 9.25 ms |            53.56 ms |                ≤100 ms |     23.69 ms | 145.62% |    12.65 MiB |     2.94 GiB / 31.01M |             ≤25 ms / 614.8 KiB | 27.33 MiB |              0 / 0 |
| 20k/s / 5s        | TypeScript |        19,882.58 |              25.83 | 9.15 / 14.56 ms |             10.45 s |           ≥10 s bucket |     21.53 ms | 163.14% |    68.68 MiB |     4.20 GiB / 27.31M |                            n/a | 42.31 MiB |              0 / 0 |
| 20k/s / 5s        | Go         |        19,968.80 |              34.23 | 9.01 / 14.05 ms |              6.68 s |           ≥10 s bucket |     23.17 ms | 252.78% |    73.36 MiB |     5.88 GiB / 58.30M |             ≤25 ms / 615.1 KiB | 37.28 MiB |              0 / 0 |

Histogram values are reported as bucket bounds, hence `≤100 ms`/`≤250 ms`; both saturated 20k
runs reached the current 10-second top finite processing bucket, so the metric cannot distinguish
their p95 precisely. Catch-up time provides the more useful saturated comparison: Go drained 3.78
seconds sooner, while spending substantially more CPU and allocations on full-state durable
checkpoints.

At 5k/s, one Docker point sample during the active TypeScript run was 87.77% CPU/17.3 MiB for the Go
collector plus 46.75% CPU/69.56 MiB for the TypeScript container. The equivalent Go-only sample was
121.48% CPU/37.39 MiB. Docker memory is container usage, not language heap, and instantaneous CPU is
not substituted for the collector's interval-average metric. Node/V8 allocation totals are not
available, so the TypeScript rows report only allocations made by the Go collector side; this makes
them an intentional lower bound for the old two-process path.

## WAL and checkpoint impact

At 5k/s, both modes performed about 119 WAL fsyncs/s and one record per group commit; HTTP admission
latency was effectively unchanged. Go additionally performed 200 topology checkpoints. At 20k/s,
both modes performed about 269 WAL fsyncs/s and 2.1 records per data commit. The Go checkpoint p95
remained in the 25 ms bucket but increased process CPU and allocation pressure. No events were
rejected, retried, or failed in any measured run.

The current checkpoint deliberately serializes the complete current topology state for crash-safe
derived state. That is the main cutover cost and the next optimization target. A future incremental
or segmented state store must preserve the ordering rule: topology durability before WAL removal.

## Engine regression check

The existing identical-object engine benchmark was also rerun after adding the live dashboard
snapshot return path. Go remained faster in all three cases, but the new full live-snapshot
materialization raises allocations substantially at high topology cardinality:

| Workload     | Engine     | spans/s | updates/s | snapshot p95 | retained heap | ingest allocated / allocs |
| ------------ | ---------- | ------: | --------: | -----------: | ------------: | ------------------------: |
| 300 spans    | TypeScript |  62,082 |       621 |     0.102 ms |     170.6 KiB |               unavailable |
| 300 spans    | Go         |  82,650 |       827 |     0.061 ms |     209.5 KiB |          1.2 MiB / 30,205 |
| 3,000 spans  | TypeScript |  36,787 |       368 |     1.768 ms |       1.6 MiB |               unavailable |
| 3,000 spans  | Go         |  64,277 |       643 |     0.773 ms |     690.0 KiB |        17.4 MiB / 397,443 |
| 30,000 spans | TypeScript |   7,492 |        75 |    15.482 ms |       6.8 MiB |               unavailable |
| 30,000 spans | Go         |  17,268 |       173 |     7.534 ms |       2.7 MiB |     506.9 MiB / 8,855,784 |

This does not justify hiding the allocation regression: suppressing intermediate live snapshot
copies when there are no WebSocket consumers, and replacing whole-state checkpoint serialization,
are explicit follow-up optimization candidates.

## Reproduction

Use `NODEFLOW_TOPOLOGY_ENGINE=typescript` with the `typescript-rollback` Compose profile for the old
path, or the default `go` mode for the new path, then run:

```bash
cd services/collector
go run ./cmd/loadgen \
  -target http://127.0.0.1:4318 \
  -rate 5000 -duration 10s -events-per-request 50 -concurrency 16
```

The load generator reports actual admitted/processed events, HTTP latency, collector CPU and heap,
cumulative Go allocations, topology updates, snapshot samples, WAL/fsync counters, checkpoint
latency/size, catch-up, rejections, and retries.
