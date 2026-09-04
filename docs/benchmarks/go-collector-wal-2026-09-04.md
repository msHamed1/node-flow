# Go collector segmented WAL benchmark — 2026-09-04

This benchmark compares the explicit admission modes after the V2.2 segmented WAL change.

## Method

- Host: local macOS development machine, Go 1.25.3, APFS
- Transport: real HTTP with `nodeflow.v1` Protobuf
- Sink: benchmark-only discard sink
- Collector: 20 workers, 10,000 dispatch window, 250-event sink batches
- Generator: 50 spans/request, 32 clients at 1k/10k and 64 clients at 50k
- Each fixed-rate run requested three seconds of traffic and waited up to 30 seconds for processing;
  legacy runs naturally took longer because request backpressure limited their admission rate
- CPU includes admission and post-admission checkpoint drain
- Disk figures are peak logical bytes reported by the collector; WAL values include segment and
  checkpoint files but exclude reserved future checkpoint capacity

The modes are:

- `memory`: bounded RAM admission, no crash durability
- `legacy`: V2.1 per-envelope temp write + file sync + rename + directory sync
- `group-commit`: V2.2 segmented WAL, 64 records or 2 ms, then one data sync

## Results

| Mode   | Target events/s | Actual admitted/s |    HTTP p50 |    HTTP p95 |    CPU | Peak heap | Peak durable bytes | Fsyncs/s | Avg records/data commit | Rejected |
| ------ | --------------: | ----------------: | ----------: | ----------: | -----: | --------: | -----------------: | -------: | ----------------------: | -------: |
| memory |           1,000 |            999.76 |     0.53 ms |     0.73 ms |  1.72% |   3.43 MB |                  0 |        0 |                       0 |        0 |
| memory |          10,000 |          9,979.37 |     0.41 ms |     0.78 ms | 11.54% |   2.41 MB |                  0 |        0 |                       0 |        0 |
| memory |          50,000 |         49,926.01 |     0.30 ms |     0.65 ms | 44.79% |   3.18 MB |                  0 |        0 |                       0 |        0 |
| legacy |           1,000 |            987.54 |    38.53 ms |    47.97 ms |  5.40% |   3.35 MB |              49 KB |      n/a |                       1 |        0 |
| legacy |          10,000 |          1,163.42 | 1,145.84 ms | 2,445.20 ms |  7.09% |   4.39 MB |            7.11 MB |      n/a |                       1 |        0 |
| legacy |          50,000 |          1,226.40 | 2,526.44 ms | 4,274.70 ms |  6.91% |   8.17 MB |           36.30 MB |      n/a |                       1 |        0 |
| WAL    |           1,000 |            992.49 |    21.88 ms |    23.44 ms |  5.21% |   3.41 MB |            0.66 MB |    24.15 |                    1.00 |        0 |
| WAL    |          10,000 |          9,904.70 |    38.67 ms |    60.58 ms | 47.60% |  23.16 MB |            6.59 MB |    77.92 |                    5.17 |        0 |
| WAL    |          50,000 |         47,645.44 |    52.01 ms |    88.86 ms | 96.97% | 156.05 MB |           39.49 MB |   223.62 |                   28.85 |        0 |

`Fsyncs/s` includes acknowledgement checkpoint syncs as well as data group syncs. The adjacent
average comes only from data commit groups. At 50k, 104 data group commits admitted 3,000 envelopes,
while durable acknowledgements added most of the 704 total syncs.

The 50k WAL run admitted all 150,000 events in 3.15 seconds and drained them in another 13.40
seconds. It therefore demonstrates burst admission capacity, not indefinitely sustainable
end-to-end throughput with a finite disk limit.

## Saturation and policy selection

With the 64-record/2 ms policy, a 75k target admitted all 225,000 events at 61,016.88 events/second,
98.19% collector CPU, 70.04 ms p50, and 125.21 ms p95. The generator could no longer maintain its
target, placing burst admission saturation near 60k events/second on this host. Total admission plus
checkpoint drain took 23.67 seconds, about 9.5k events/second end to end under this single-service
workload. APFS `fsync` latency and serialized per-service acknowledgement progress are the limiting
resources after admission is amortized.

A 128-record/5 ms policy reached 9,832.95 events/second at the 10k target with 67.82 ms p95, and
47,590.03 events/second at the 50k target with 98.82 ms p95. The selected 64/2 ms policy delivered
similar high-rate throughput with lower p95 in these runs. These are local measurements, not a
universal storage tuning claim; deployments can configure both thresholds.

Compared with the legacy ceiling, WAL admission is approximately 8.5x faster at the 10k workload
and 38.8x faster at the 50k workload. The durability boundary was unchanged: no WAL response was
counted accepted before the corresponding commit group completed `fsync`.

## Replay and retry behavior

The fixed-rate discard-sink runs produced zero rejected records and zero retries. Separate tests and
the Compose durability scenario cover sink outage, checkpointed exponential retry, SIGKILL, startup
replay, and final acknowledgement. Recovery tests also cover partial tails, committed corruption,
rotation artifacts, and logical disk exhaustion.

## Reproduction

```bash
cd services/collector
go build -o /tmp/nodeflow-collector ./cmd/nodeflow-collector
go build -o /tmp/nodeflow-loadgen ./cmd/loadgen

NODEFLOW_SINK=discard NODEFLOW_SPOOL_MODE=group-commit \
  NODEFLOW_SPOOL_DIR=/path/to/fresh/spool \
  /tmp/nodeflow-collector

/tmp/nodeflow-loadgen -rate 1000 -duration 3s -events-per-request 50 -concurrency 32
/tmp/nodeflow-loadgen -rate 10000 -duration 3s -events-per-request 50 -concurrency 32
/tmp/nodeflow-loadgen -rate 50000 -duration 3s -events-per-request 50 -concurrency 64
```

Use a fresh spool directory for every mode. Set `NODEFLOW_SPOOL_MODE=memory` or `legacy` for the
other rows. The load generator now reports WAL sync frequency, average records per data commit,
peak WAL bytes/segments, retry totals, and disk-pressure rejections.
