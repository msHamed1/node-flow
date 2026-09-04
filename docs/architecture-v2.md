# NodeFlow V2 architecture

## Why NodeFlow uses TypeScript and Go

NodeFlow follows an ownership boundary rather than treating either language as universally better.

TypeScript runs where Node.js runtime knowledge exists: OpenTelemetry instrumentation, NestJS
discovery, framework semantics, application-side APIs, and the React dashboard. Go runs where the
problem is runtime-neutral infrastructure: bounded network ingestion, queueing, batching, worker
concurrency, backpressure, shutdown, and collector self-observability.

## Before V2

```text
Node.js application
    ↓ normalized JSON spans and runtime samples
TypeScript collector
    ├─ Express transport
    ├─ TypeScript TopologyEngine
    ├─ snapshot and architecture APIs
    ├─ WebSocket publication
    └─ dashboard hosting
```

The collector calls the topology engine synchronously in the HTTP handler. The topology engine is
already a separate package, but transport and projection share one process and there is no explicit
ingress capacity boundary.

## Current V2 increment

```text
Node.js application
    ↓
TypeScript NodeFlow instrumentation
    ↓ nodeflow.v1 Protobuf (legacy JSON remains accepted)
Go collector
    ├─ decode and validation
    ├─ defense-in-depth redaction
    ├─ durable bounded admission and backpressure
    ├─ restart replay, retry, and quarantine
    ├─ batching and service-sharded workers
    ├─ lifecycle and metrics
    └─ TelemetrySink interface
           ↓ compatibility HTTP bridge
TypeScript topology process
    ├─ TopologyEngine
    ├─ live and architecture projections
    ├─ WebSocket publication
    └─ React dashboard
```

The topology process is the existing TypeScript collector in a narrower deployment role. Its
published npm API and CLI behavior remain supported, so current users can choose the original
single-process path or opt into the V2 infrastructure path.

## Ownership

| Concern                                                    | Owner                                      |
| ---------------------------------------------------------- | ------------------------------------------ |
| Node.js and OpenTelemetry integration                      | TypeScript instrumentation                 |
| NestJS controllers and singleton providers                 | TypeScript NestJS package                  |
| Span normalization and first redaction boundary            | TypeScript instrumentation                 |
| Versioned wire format                                      | `proto/nodeflow/v1` plus protocol bindings |
| Network admission, durable spool, retry, batching, workers | Go collector                               |
| Second validation/redaction boundary                       | Go collector                               |
| Stable node IDs, dependency reconstruction, runtime paths  | TypeScript topology engine                 |
| `TopologyEngine.createSnapshot()` and comparison           | TypeScript topology engine                 |
| WebSocket and dashboard                                    | TypeScript collector/dashboard             |

## Protocol compatibility

`TelemetryEnvelope.protocol_version` is `1.0`. A request contains one span batch or runtime sample.
Protobuf readers ignore unknown additive fields; the collector rejects missing or unsupported major
contracts before enqueueing work. Existing `/api/spans` and `/api/runtime` JSON payloads remain
available on both collector implementations during migration.

The stable architecture snapshot remains version `1.0` independently of the ingestion protocol.
Changing transport does not change stored snapshot semantics.

## Capacity and delivery semantics

In the default durable mode, `202 Accepted` acknowledges a sanitized record only after its contents
and directory entry are synced to the bounded local spool. It does not acknowledge a topology
commit. The dispatch queue remains bounded by `NODEFLOW_QUEUE_SIZE`, while durable capacity is
bounded independently by `NODEFLOW_SPOOL_MAX_BYTES`. Exhaustion returns HTTP 507 rather than moving
the backlog into sockets or claiming acceptance.

Workers are selected by service name, so envelopes for one application service retain admission
order while unrelated services can progress independently. Transient failures use checkpointed
exponential backoff with jitter. HTTP 4xx failures other than 408, 425, and 429 are permanent;
permanent or retry-exhausted records are quarantined. Startup verifies record framing and CRC32,
quarantines corruption, and replays valid unacknowledged records.

Delivery is at least once. A crash after the sink commits but before the collector syncs removal can
replay the record. The TypeScript engine ignores a repeated span ID while that trace remains in its
bounded history, but this protection is not durable across topology-process restarts or trace
eviction. Exactly-once delivery is not claimed.

## Security boundary

Instrumentation removes credentials, authorization/cookie values, request/response bodies,
database statements, connection strings, and URL secrets before serialization. The Go collector
repeats the sanitization for legacy or third-party clients. Payload sizes and scalar attribute
types are validated before admission.

This remains a trusted local-development system. Bind to loopback or an isolated container network.
Authentication, TLS, multi-tenant isolation, spool encryption, and remote collection are outside
the current V2 increment. Spool directories are created with owner-only permissions, and records
contain only telemetry after the collector's validation and redaction boundary.

## Deliberately deferred

- A standalone Go topology implementation.
- gRPC/OTLP receiver adapters.
- Cross-platform distribution of the Go binary through the npm CLI.
- Remote/multi-tenant collection and authentication.
- A compacting segmented WAL; the current per-envelope record format favors simple recovery over
  high synchronous-write throughput.

The checked-in `nodeflow.topology-golden.v1` corpus now defines the TypeScript behavior that a future
Go projection must match. It is a prerequisite, not approval to migrate: the corpus should first be
run against an independent Go implementation and the durable admission throughput limitation should
be resolved or explicitly accepted.
