# ADR 0001: Introduce Go for NodeFlow infrastructure components

- Status: Accepted; delivery amended by ADR 0002/0003 and topology deferral superseded by ADR 0004
- Date: 2026-09-03

## Context

NodeFlow is a local-first Node.js runtime architecture explorer. Its TypeScript packages are the
right place to integrate with Node.js, NestJS, application dependency injection, and the
OpenTelemetry JavaScript SDK. The current collector, however, also owns transport and concurrency
concerns that are independent of the observed runtime and need explicit memory and overload
boundaries as ingestion volume grows.

The purpose of V2 is not to replace the TypeScript product with Go. It is to introduce a language
boundary where it improves operational ownership.

## Decision

Use Go for the V2 collector ingestion service. It owns validation, bounded queuing, batching,
fixed worker concurrency, backpressure, graceful shutdown, structured logs, and internal metrics.
Use a versioned Protocol Buffers envelope as the preferred Node.js-to-collector wire contract, with
legacy JSON adapters during migration.

Retain the TypeScript topology engine behind a sink boundary in this increment. Retain all Node.js
and NestJS instrumentation in TypeScript permanently unless a separate runtime-neutral component is
identified later.

## Why Go

Go provides a small deployable service binary and direct, well-understood primitives for bounded
channels, fixed worker pools, context cancellation, HTTP lifecycle control, and race-tested shared
state. Those properties fit the collector's infrastructure role. This decision does not assert
that Go is universally faster or that the original TypeScript implementation was a mistake.

## Why TypeScript remains

Node.js instrumentation must run inside the observed Node.js process and use the JavaScript
OpenTelemetry ecosystem. NestJS discovery depends on framework lifecycle and DI APIs. Keeping this
work in TypeScript avoids cross-language hooks, preserves the published npm API, and keeps semantic
metadata close to the runtime that understands it.

The current topology engine is also retained until its semantic behavior has an independent parity
suite. Moving it as part of the collector transport change would combine two migrations and make
architecture regressions difficult to attribute.

## Alternatives considered

### Keep the collector entirely in TypeScript

This could add bounded queues and workers, but it would not establish the intended infrastructure
service boundary or exercise a language-neutral protocol. It remains a supported compatibility
option, not the V2 direction.

### Rewrite all NodeFlow packages in Go

Rejected. It would abandon mature Node.js and NestJS integration points, break npm users, and move
runtime-specific logic into the wrong process.

### Move the collector and topology engine together

Deferred. It could produce one standalone binary, but it risks semantic drift in stable node IDs,
out-of-order trace correlation, bounded history, runtime paths, and snapshot comparison while the
transport migration is still being validated.

### Use only OTLP

Deferred as the sole protocol. OTLP is appropriate for generic telemetry, but NodeFlow also sends
runtime samples and normalized NodeFlow topology metadata. The versioned NodeFlow envelope keeps
that contract explicit; a future OTLP adapter can implement the same sink.

## Trade-offs

- Local V2 development temporarily runs two infrastructure processes: Go ingestion and TypeScript
  topology/dashboard.
- The compatibility bridge adds one localhost/network hop and another serialization boundary.
- The repository gains Go and Protobuf toolchains in CI.
- In return, overload behavior, worker concurrency, collector metrics, and shutdown are explicit and
  independently testable without changing topology semantics.

## Operational consequences

- In default durable mode, readiness reflects admission capacity rather than topology-sink reachability.
  Memory mode retains direct sink readiness. See ADR 0002.
- Durable spool exhaustion returns 507; memory-queue exhaustion returns 429; shutdown returns 503.
  All are observable in metrics.
- SIGINT/SIGTERM stop HTTP admission, drain queued work up to the configured deadline, close the
  sink, and then exit.
- The container binds to all interfaces for Docker, so deployments must publish it only to trusted
  local networks. The npm-managed TypeScript collector continues to bind to `127.0.0.1` by default.
- The Go collector has a separate image/release lifecycle and is not added to Changesets/npm.

## Migration strategy

Ship the Go service as opt-in, preserve legacy JSON, add Protobuf export behind an environment
setting, and use Docker integration to compare the resulting topology with the current collector.
Do not deprecate the TypeScript collector until feature parity, packaging, and CLI distribution are
resolved for all supported operating systems.
