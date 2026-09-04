# ADR 0002: Use bounded at-least-once durable collector admission

- Status: Superseded by ADR 0003
- Date: 2026-09-04

## Context

The first Go collector returned `202 Accepted` after placing sanitized telemetry in a bounded
in-memory queue. That made overload explicit but allowed accepted data to disappear when the
collector terminated or its TypeScript compatibility sink stayed unavailable.

NodeFlow still needs a zero-infrastructure local workflow. Kafka, RabbitMQ, and external databases
cannot become prerequisites merely to make the collector restart-safe.

## Decision

Make a local disk spool the default admission boundary. Each validated and redacted envelope is
encoded as a versioned, length-delimited record with a CRC32 checksum. Admission writes and syncs a
temporary file, atomically renames it into the active spool, and syncs the directory before returning
`202`. Successful sink delivery removes the active file and syncs the directory.

The spool has a configurable allocated-byte limit. Active and quarantined records both count toward
that limit. Transient failures use persisted attempt counts, exponential backoff, and jitter.
Permanent failures and exhausted records are moved to an owner-only quarantine directory. Startup
removes incomplete temp files, quarantines invalid names, duplicate IDs, and corrupt records, and
replays valid records in admission order.

Workers are sharded by service name. A failing service therefore retains its own ordering without
preventing unrelated services assigned to other workers from progressing.

## Delivery contract

Delivery is **at least once**. A record stays active until the sink succeeds. If the process crashes
after sink success but before its removal checkpoint is durable, the record can be delivered again.
No exactly-once claim is made.

The TypeScript topology engine suppresses a repeated span ID while its trace remains in bounded
memory. That limits the common replay effect, but it does not cover replay after trace eviction or a
topology-process restart. Durable end-to-end idempotency remains future work.

## Consequences

- `202` now means durable local admission in the default mode, not topology commit.
- Readiness describes whether the collector can admit data; a sink outage does not make a
  non-full durable collector unready.
- A full spool returns HTTP 507 with `Retry-After: 5`. Shutdown returns 503.
- The configured cap covers active and quarantined filesystem allocation. One serialized temp write
  can transiently exceed it by at most one bounded request before admission is rejected and the temp
  file is removed.
- Quarantine makes loss explicit and inspectable, but operators must remove reviewed records to
  reclaim their disk budget.
- Per-envelope files provide simple atomic recovery and corruption isolation, but synchronous file
  and directory checkpoints have substantial throughput and latency cost. A compacting segmented
  WAL with group commit is the likely production evolution.
- `NODEFLOW_SPOOL_MODE=memory` remains available for controlled comparisons; it has the original
  process-loss semantics and is not the default.

## Rejected alternatives

- Exactly-once delivery: the HTTP sink offers no transactional idempotency contract with the spool.
- Mandatory Kafka or RabbitMQ: incompatible with NodeFlow's local-first installation model.
- Acknowledging before sync: retains the original accepted-data loss window.
- Infinite retry: one poison record could retain capacity forever without an explicit failure state.
