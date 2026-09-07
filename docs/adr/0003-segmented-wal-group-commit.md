# ADR 0003: Use a segmented WAL with group commit

- Status: Accepted
- Date: 2026-09-04

## Context

ADR 0002 made collector admission restart-safe with one synced, atomically renamed file per
envelope. That contract was correct but saturated near 1.2–1.3k events/second on the reference
machine because every request paid for a file sync, rename, and directory sync.

## Decision

The default durable store is a local segmented write-ahead log. A single writer assigns monotonic
sequence IDs and appends versioned data frames followed by a commit frame covering the complete
group. Each frame has header and payload CRC32 checksums; the commit frame also checks the bytes,
record count, and first/last sequence IDs of its group.

The writer flushes when 64 records accumulate or 2 ms elapses after the first queued record. These
defaults were selected after comparing 64/2 ms with 128/5 ms on the same host: the shorter window
reduced 10k-target p95 from about 68 ms to 61 ms without materially reducing high-rate throughput.
Both limits remain configurable.

Acknowledgements, retry attempts, and terminal quarantine states are appended to per-segment,
versioned checkpoint logs and synced before in-memory state changes. Closed segments are deleted
only when every contained record is acknowledged and no quarantine record remains. Directory
metadata is synced after creation, rotation, repair, and deletion.

## Admission and delivery contract

In `group-commit` mode, `202 Accepted` is sent only after the data frames and their commit marker
complete `fsync`. `sync` uses the identical format with one record per commit. `legacy` keeps the
V2.1 implementation for comparison, and `memory` explicitly retains process-local admission.

Delivery remains **at least once**. A sink can commit immediately before the collector crashes and
before the acknowledgement checkpoint is durable, causing replay. No exactly-once claim is made.
The TypeScript topology engine suppresses repeated span IDs only while the trace is retained in its
bounded process memory; durable end-to-end idempotency is still absent.

## Recovery and corruption policy

Startup scans segments in ID order and exposes active records in WAL sequence order. A partial
uncommitted final group and a partial final checkpoint entry are truncated and synced. Any invalid
header, CRC, commit marker, duplicate committed sequence, corrupt non-final tail, or corrupt
committed record fails startup with an explicit corruption error. NodeFlow does not silently drop
committed telemetry to regain availability.

Temporary rotation files are removed. A data segment whose checkpoint sidecar was not durably
created is conservatively replayed, which can duplicate acknowledged telemetry but cannot lose it.
The WAL refuses to start when V2.1 per-envelope records remain in the directory, requiring them to
be drained in `legacy` mode or explicitly archived.

## Disk pressure

`NODEFLOW_SPOOL_MAX_BYTES` bounds logical segment/checkpoint bytes plus checkpoint space reserved
for each admitted record's remaining retry and terminal state transitions. Admission that would
cross the bound returns HTTP 507 with `Retry-After: 5`. A full bounded append queue returns HTTP 429.
Quarantined records remain explicit and keep their segment from compaction.

## Consequences

- Multiple HTTP admissions share one data `fsync`, materially raising durable admission capacity.
- Segment-level compaction avoids per-record data-file deletion and directory syncing.
- Low traffic usually commits one record per sync, so its latency remains bounded by storage sync
  latency plus the configured 2 ms window.
- A single-service saturated drain still pays for durable acknowledgement checkpoints. On the
  reference machine this is the steady-state limiter even though burst admission is much faster.
- The WAL is local to one collector process and one filesystem; it is not replicated storage.

## Rejected alternatives

- Acknowledging before `fsync`: weakens the durable admission contract.
- In-place segment rewriting: makes crash recovery and atomicity more complex than deleting fully
  acknowledged segments.
- Silently skipping corrupt committed frames: converts detected corruption into unreported loss.
- Mandatory Kafka or RabbitMQ: conflicts with NodeFlow's local-first deployment model.
