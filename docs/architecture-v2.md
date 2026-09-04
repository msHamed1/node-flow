# NodeFlow V2 architecture

## Why NodeFlow uses TypeScript and Go

NodeFlow follows an ownership boundary rather than treating either language as universally better.

TypeScript runs where Node.js runtime knowledge exists: OpenTelemetry instrumentation, NestJS
discovery, framework semantics, application-side APIs, and the React dashboard. Go runs where the
problem is runtime-neutral infrastructure or reconstruction: bounded network ingestion, queueing,
batching, worker concurrency, backpressure, shutdown, collector self-observability, and the
authoritative topology projection.

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

## Current V2.4 production path

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
    ├─ service-sharded topology adapter
    ├─ Go TopologyEngine
    ├─ atomic topology-state checkpoint before WAL acknowledgement
    ├─ live and architecture projections
    ├─ WebSocket publication
    └─ React dashboard hosting
```

There is no compatibility HTTP hop in this default path. The topology package remains independent
of HTTP and Protobuf; an internal sink adapter translates normalized collector envelopes into its
language-neutral event model. The Go service owns the public snapshot, architecture, WebSocket,
health, metrics, and built-dashboard routes.

`NODEFLOW_TOPOLOGY_ENGINE=typescript` is an emergency rollback. In that mode the Go collector sends
normalized telemetry to the retained TypeScript collector and reverse-proxies its topology REST and
WebSocket routes. Compose starts that service only with the `typescript-rollback` profile. This is
single-write fallback, not default shadowing or dual-write.

## Ownership

| Concern                                                    | Owner                                      |
| ---------------------------------------------------------- | ------------------------------------------ |
| Node.js and OpenTelemetry integration                      | TypeScript instrumentation                 |
| NestJS controllers and singleton providers                 | TypeScript NestJS package                  |
| Span normalization and first redaction boundary            | TypeScript instrumentation                 |
| Versioned wire format                                      | `proto/nodeflow/v1` plus protocol bindings |
| Network admission, durable spool, retry, batching, workers | Go collector                               |
| Second validation/redaction boundary                       | Go collector                               |
| Stable node IDs, dependency reconstruction, runtime paths  | Go topology engine                         |
| Version `1.0` architecture snapshot                        | Go topology engine                         |
| Snapshot REST and WebSocket publication                    | Go collector                               |
| Dashboard UI                                               | TypeScript/React static assets             |
| Rollback/reference topology implementation                 | TypeScript topology engine                 |

## Protocol compatibility

`TelemetryEnvelope.protocol_version` is `1.0`. A request contains one span batch or runtime sample.
Protobuf readers ignore unknown additive fields; the collector rejects missing or unsupported major
contracts before enqueueing work. Existing `/api/spans` and `/api/runtime` JSON payloads remain
available on both collector implementations during migration. The compatibility span endpoint waits
for the configured topology authority and retains its `accepted` plus `revision` response; the
preferred Protobuf endpoint retains durable-admission semantics.

The stable architecture snapshot remains version `1.0` independently of the ingestion protocol.
Changing transport does not change stored snapshot semantics.

## Capacity and delivery semantics

In the default `group-commit` mode, `202 Accepted` acknowledges a sanitized record only after its
versioned data frame and CRC-protected group marker have completed `fsync` in an append-only WAL
segment. It does not acknowledge a topology commit. The dispatch queue remains bounded by
`NODEFLOW_QUEUE_SIZE`, while durable capacity is bounded independently by
`NODEFLOW_SPOOL_MAX_BYTES`. Exhaustion returns HTTP 507 rather than moving the backlog into sockets
or claiming acceptance.

Workers are selected by service name, so envelopes for one application service retain admission
order while unrelated services can progress independently. Transient failures use checkpointed
exponential backoff with jitter. HTTP 4xx failures other than 408, 425, and 429 are permanent;
permanent or retry-exhausted records are checkpointed as quarantined. Startup verifies segment,
record, commit, and checkpoint framing and CRC32. An incomplete uncommitted final group is truncated;
committed corruption is fatal and visible rather than silently discarded. Fully acknowledged
closed segments are deleted and the directory metadata is synced.

Delivery is at least once. In Go mode, each topology update is written to a temporary owner-only
file, fsynced, atomically renamed, and followed by a directory fsync before the sink reports success
to the WAL. A crash after this topology checkpoint but before WAL removal can replay the record.
The checkpoint includes the bounded retained traces and span-ID deduplication set, so that crash
window does not increment current topology metrics twice. Deduplication still ends when a trace is
evicted, and reused span IDs remain subject to the existing TypeScript-compatible rules. Exactly-once
processing is not claimed.

Committed WAL corruption and topology-state corruption both fail startup explicitly. The topology
checkpoint has its own format version and CRC32 over the canonical state. It is stored outside the
segmented WAL directory in the container but on the same durable volume. Its bytes and checkpoint
latency are exported separately. A topology checkpoint failure is a transient sink failure: the WAL
record remains active, retries with the configured backoff, and eventually follows the existing
quarantine policy.

## Security boundary

Instrumentation removes credentials, authorization/cookie values, request/response bodies,
database statements, connection strings, and URL secrets before serialization. The Go collector
repeats the sanitization for legacy or third-party clients. Payload sizes and scalar attribute
types are validated before admission.

This remains a trusted local-development system. Bind to loopback or an isolated container network.
Authentication, TLS, multi-tenant isolation, spool encryption, and remote collection are outside
the current V2 increment. Spool directories are created with owner-only permissions, and records
contain only telemetry after the collector's validation and redaction boundary.

## TypeScript rollback and remaining scope

- Node.js, NestJS, and OpenTelemetry instrumentation remain TypeScript permanently.
- The React dashboard remains TypeScript but consumes Go snapshots without a compatibility backend.
- The TypeScript `TopologyEngine` and collector remain in the repository for differential tests,
  the emergency Compose profile, and the existing embedded npm CLI workflow.
- The npm CLI does not yet distribute or launch platform-specific Go binaries. `node-flow dev` and
  `node-flow collector` therefore retain their existing TypeScript local behavior; the container
  production path is Go-authoritative.

## Deliberately deferred

- gRPC/OTLP receiver adapters.
- Cross-platform distribution of the Go binary through the npm CLI.
- Remote/multi-tenant collection and authentication.
- Idempotency after bounded trace-history eviction or intentionally resetting the Go state file.
- Reconciliation of topology accumulated while TypeScript rollback mode is active. Because rollback
  deliberately avoids dual-write, returning to Go resumes its last checkpoint rather than importing
  transient TypeScript state.

The checked-in `nodeflow.topology-golden.v1` corpus remains the compatibility contract. Every change
to either implementation must preserve the 15 fixtures and all native/reverse/deterministic-random
differential executions; expectations must not be relaxed to make an implementation pass.
