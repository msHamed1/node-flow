# ADR 0004: Make the Go topology engine authoritative

- Status: Accepted
- Date: 2026-09-04

## Context

The V2.3 Go reconstruction engine matched the TypeScript semantic source across all 15 golden
fixtures and 45 arrival-order executions. The V2.2 collector already owns durable admission, replay,
service ordering, and overload control, but the production flow still paid an HTTP serialization hop
into the TypeScript collector. Keeping that bridge as the default also split failure and lifecycle
ownership across two backend processes.

## Decision

The Go collector now calls a transport-independent Go topology engine through an internal normalized
event adapter. It serves the version `1.0` architecture projection, live dashboard snapshot, runtime
updates, REST routes, and WebSocket messages directly. The compatibility HTTP sink is not constructed
in the default `NODEFLOW_TOPOLOGY_ENGINE=go` mode.

Before a successfully reconstructed batch can be removed from the telemetry WAL, the complete
current topology state is JSON encoded, fsynced to an owner-only temporary file, atomically renamed,
and its directory fsynced. A format version and CRC32 protect the committed state; startup restores
it or fails explicitly if the file is corrupt or unsupported. This adds an intentional checkpoint
cost but prevents a collector/topology restart from erasing topology that has already left the WAL.

Delivery remains at least once. A crash between the topology-state rename and WAL acknowledgement can
replay a batch. The restored bounded span-ID set makes that crash window idempotent while its trace is
retained. It does not provide exactly-once processing after trace eviction or manual state removal.

## Rollback

`NODEFLOW_TOPOLOGY_ENGINE=typescript` selects the retained HTTP sink and proxies topology REST and
WebSocket reads to the TypeScript collector. For Compose:

```bash
NODEFLOW_TOPOLOGY_ENGINE=typescript \
  docker compose --profile typescript-rollback up -d --build --wait
```

No topology schema or WAL migration is required. The mode is single-write: Go does not shadow or
dual-write while TypeScript is authoritative. Consequently, topology accumulated during rollback is
not imported into the earlier Go checkpoint when switching back.

## Consequences

- The default container path is one backend process and has no Go-to-TypeScript HTTP hot-path hop.
- Go now owns topology state, snapshot/runtime-path semantics, REST, WebSocket, and dashboard hosting.
- TypeScript continues to own application instrumentation, framework discovery, the React UI, the
  reference engine, differential tests, rollback, and the embedded npm CLI collector.
- Each topology update adds an atomic state checkpoint. Metrics expose update count, checkpoint
  latency and size, alongside WAL and process allocation measurements.
- The TypeScript engine can be marked deprecated only after a production soak and a portable Go CLI
  distribution exist. It must remain available during this milestone.
