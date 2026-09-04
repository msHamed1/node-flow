# Golden topology compatibility corpus

The TypeScript `TopologyEngine` is NodeFlow's semantic source of truth during the V2 collector
migration. The golden corpus under `packages/topology-engine/test` converts deterministic telemetry
batches into `nodeflow.topology-golden.v1`, a compact JSON-serializable representation intended for
future TypeScript-versus-Go differential tests. The fixture source uses TypeScript only for schema
checking; inputs and expected values contain no functions, dates, maps, or TypeScript-only values.

## Compatibility contract

Two topology implementations are compatible when the canonical representations contain the same:

- source snapshot version, application runtime, and application service-name set;
- stable node IDs, architecture node types, display names, and framework identity;
- dependency source, target, type, call count, error count, average latency, and p95 latency;
- node call/error counts and average, p50, p95, and p99 latency summaries;
- runtime path entrypoint, ordered node chain, call/error counts, average latency, and p95 latency.

Node and edge identities are meaningful because persisted architecture comparisons depend on them.
Path IDs are deliberately excluded: the path entrypoint and ordered node chain are the semantic
identity, while the current hash is an implementation detail.

The corpus ignores snapshot generation time, revision, activity highlights, raw recent traces,
process runtime samples, and the reporting process's Node.js version. Those fields are volatile or
belong to live presentation rather than architecture equivalence.

## Normalization

Canonicalization sorts services and nodes lexically, edges by stable edge ID, and paths by entrypoint
plus their ordered node chain. Metrics are already rounded by the source-of-truth engine.
This removes JavaScript map insertion order and telemetry arrival order from comparisons without
discarding dependency direction or runtime-path order.

The expected values are checked-in typed data, not generated during the test. Fixtures remain small
and reviewable by using one or two focused traces instead of serializing the complete live snapshot.
Changing a meaningful field requires a new reviewed format version or an intentional corpus update;
volatile fields must not be added merely to mirror the full snapshot object.

## Coverage

The corpus covers HTTP/controller/service chains, nested services, MongoDB/Mongoose normalization,
PostgreSQL, Redis, RabbitMQ, external HTTP, transparent local-event detail, background workers,
errors, parallel and repeated operations, duplicate replay, missing parents, late/out-of-order
parents, mixed dependency types, and multi-service traces.

Run it with:

```bash
yarn vitest run packages/topology-engine/test/golden-corpus.test.ts
```
