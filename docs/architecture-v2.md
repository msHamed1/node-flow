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

## First V2 increment

```text
Node.js application
    ↓
TypeScript NodeFlow instrumentation
    ↓ nodeflow.v1 Protobuf (legacy JSON remains accepted)
Go collector
    ├─ decode and validation
    ├─ defense-in-depth redaction
    ├─ bounded admission and backpressure
    ├─ batching and fixed workers
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

| Concern                                                   | Owner                                      |
| --------------------------------------------------------- | ------------------------------------------ |
| Node.js and OpenTelemetry integration                     | TypeScript instrumentation                 |
| NestJS controllers and singleton providers                | TypeScript NestJS package                  |
| Span normalization and first redaction boundary           | TypeScript instrumentation                 |
| Versioned wire format                                     | `proto/nodeflow/v1` plus protocol bindings |
| Network admission, limits, queues, batching, workers      | Go collector                               |
| Second validation/redaction boundary                      | Go collector                               |
| Stable node IDs, dependency reconstruction, runtime paths | TypeScript topology engine                 |
| `TopologyEngine.createSnapshot()` and comparison          | TypeScript topology engine                 |
| WebSocket and dashboard                                   | TypeScript collector/dashboard             |

## Protocol compatibility

`TelemetryEnvelope.protocol_version` is `1.0`. A request contains one span batch or runtime sample.
Protobuf readers ignore unknown additive fields; the collector rejects missing or unsupported major
contracts before enqueueing work. Existing `/api/spans` and `/api/runtime` JSON payloads remain
available on both collector implementations during migration.

The stable architecture snapshot remains version `1.0` independently of the ingestion protocol.
Changing transport does not change stored snapshot semantics.

## Capacity and delivery semantics

Admission counts envelopes and is bounded by `NODEFLOW_QUEUE_SIZE`; body, span, attribute, and string
limits bound the size of each entry. The default rejection policy uses 429 rather than moving the
backlog into open sockets. A 202 acknowledges admission to bounded memory rather than downstream
topology commit, keeping the Node OpenTelemetry batch processor independent of the sink's flush
latency. Processing failures are observable in metrics and logs, but the current service has no
durable spool or automatic sink retry. A hard termination or downstream failure can therefore lose
work that was already admitted.

## Security boundary

Instrumentation removes credentials, authorization/cookie values, request/response bodies,
database statements, connection strings, and URL secrets before serialization. The Go collector
repeats the sanitization for legacy or third-party clients. Payload sizes and scalar attribute
types are validated before admission.

This remains a trusted local-development system. Bind to loopback or an isolated container network.
Authentication, TLS, multi-tenant isolation, durable storage, and remote collection are outside the
current V2 increment.

## Deliberately deferred

- A standalone Go topology implementation.
- gRPC/OTLP receiver adapters.
- Cross-platform distribution of the Go binary through the npm CLI.
- Durable buffering or disk spill.
- Remote/multi-tenant collection and authentication.

The next migration decision should be based on a cross-language semantic parity corpus, not on the
desire to remove the temporary compatibility bridge.
