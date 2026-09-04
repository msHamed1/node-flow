# Go TopologyEngine differential prototype

## Status and boundary

The Go topology implementation is an experimental V2.3 package at
`services/collector/internal/topology`. It is not imported by the collector pipeline, HTTP server,
compatibility sink, TypeScript collector, dashboard, or snapshot APIs. The production TypeScript
`TopologyEngine` remains the semantic source of truth and the only engine serving topology.

The command under `services/collector/cmd/topology-diff` is a test adapter. It accepts the same
JSON-serializable telemetry batches as the TypeScript golden tests and returns a Go-derived
`NodeFlowSnapshot`. It is not a production service.

## Reconstructed semantics

The prototype mirrors these TypeScript behaviors:

- Node identity comes from `nodeflow.identity` or the span name, with the same type and optional
  framework prefixes. Controller and service display names prefer `nodeflow.class`; other nodes
  prefer `nodeflow.topology_name`.
- A dependency edge joins a topology child to its nearest topology parent. `custom` and `internal`
  spans do not become nodes; both can be crossed while finding an edge parent.
- Runtime paths start only at root HTTP, worker, controller, or service nodes. They retain ordered
  semantic node IDs, collapse consecutive identical node IDs, and emit one contribution per unique
  path per trace.
- A trace's path latency spans its earliest start to latest end. Any error in the trace, including
  one on a transparent span, marks all of that trace's runtime-path contributions as failed. Node
  and edge error metrics remain local to their contributing span.
- When a parent arrives late, the whole touched trace is reconciled. Provisional paths are removed
  before final path contributions are recorded, so arrival order does not inflate path counts.
- Duplicate span IDs are ignored while their trace is retained. This is at-least-once replay
  protection, not permanent global idempotency: when a trace ages out of `maxRecentTraces`, its span
  IDs become eligible again, matching the TypeScript engine.
- Node and edge metrics aggregate all admitted spans. Latency percentiles use the retained sample
  window and nearest-rank calculation; averages use the complete count and duration total.
- Architecture snapshots use schema version `1.0`, application runtime `nodejs`, stable node and
  edge IDs, deterministic ordering, and defensive copies.

The canonical compatibility format remains `nodeflow.topology-golden.v1`. Snapshot timestamps,
live revisions, activity highlights, recent raw traces, process metrics, reporting-process version,
derived error rate, and runtime-path hash IDs are intentionally ignored. See
`docs/testing/golden-topology-corpus.md` for the complete compatibility contract.

## Differential coverage

V2.3 has 14 focused golden fixtures. The two additions over V2.1 cover semantics that were not
previously explicit:

1. an `internal` span is transparent for topology, while its error still fails the trace path;
2. recursive spans with the same service identity aggregate node calls but do not create self-edges
   or repeat the same node consecutively in a path.

Every fixture is executed three ways: its authored batching plus two deterministic seeded
span-level arrival permutations. The test therefore performs 42 TypeScript-versus-Go comparisons.
It first confirms the TypeScript result still equals the reviewed golden value, then compares that
live TypeScript result to Go. A failure identifies missing or unexpected nodes/edges or the exact
node, edge, or path identity whose semantic fields differ.

Current result: all 42 comparisons pass with no ignored semantic mismatch.

## Concurrency ownership model

One Go `Engine` owns all mutable maps, deduplication sets, trace state, metric accumulators, and the
logical reconciliation clock. A single `sync.RWMutex` defines the boundary:

- `RegisterApplication` and `Ingest` take the write lock;
- one `Ingest` call admits spans, reconciles edges, replaces path contributions, and trims traces as
  one atomic state transition;
- `CreateSnapshot` takes the read lock and copies all exported slices before releasing it.

This intentionally favors a simple, race-free semantic prototype over maximum write concurrency.
Callers may invoke ingestion and snapshots concurrently, but ingestion is serialized per engine.
The race suite includes concurrent writers and snapshot readers and checks that a snapshot never
observes a partially applied two-span batch.

## Benchmark methodology

`yarn benchmark:topology` builds the TypeScript package, warms V8, creates deterministic small,
medium, and large workloads, and runs both engines from the exact same batch objects. Go process
startup, Go compilation, JSON serialization, and JSON decoding are outside the measured ingestion
interval. Both engines use default retention limits and take 1,000 snapshot latency samples per
workload. Retained heap is sampled after an explicit GC.

Measured on macOS 15.6 (`darwin 24.6.0`), Node.js v22.18.0, Go 1.25.3, and an Intel Xeon W-2150B
with 20 logical CPUs:

| Workload     | Engine     | spans/s | updates/s | snapshot p50 | snapshot p95 | retained heap | ingest allocated | ingest allocations |
| ------------ | ---------- | ------: | --------: | -----------: | -----------: | ------------: | ---------------: | -----------------: |
| 300 spans    | TypeScript |  47,974 |       480 |     0.089 ms |     0.184 ms |     169.3 KiB |      unavailable |        unavailable |
| 300 spans    | Go         | 118,837 |     1,188 |     0.045 ms |     0.059 ms |     210.1 KiB |        768.5 KiB |             20,856 |
| 3,000 spans  | TypeScript |  27,933 |       279 |     1.636 ms |     2.812 ms |       1.6 MiB |      unavailable |        unavailable |
| 3,000 spans  | Go         | 136,765 |     1,368 |     0.622 ms |     0.746 ms |     683.6 KiB |          6.9 MiB |            209,388 |
| 30,000 spans | TypeScript |   6,772 |        68 |    12.274 ms |    21.017 ms |       6.5 MiB |      unavailable |        unavailable |
| 30,000 spans | Go         |  83,762 |       838 |     6.224 ms |    12.941 ms |       2.7 MiB |         68.3 MiB |          2,088,573 |

Final topology sizes were 15 nodes / 50 edges / 100 paths, 60 / 800 / 1,000, and
200 / 7,500 / 1,000. The 1,000-path maximum is therefore exercised by the medium and large cases.
Node.js does not expose trustworthy allocation counts, so the benchmark reports them as unavailable
instead of estimating them. These are single-host engineering measurements, not CI performance
thresholds; rerun the command when comparing revisions.

The native Go benchmarks report reconstruction including engine creation and one final snapshot:

| Workload     | spans/s | updates/s |   bytes/op | allocs/op |
| ------------ | ------: | --------: | ---------: | --------: |
| 300 spans    |  58,517 |       585 |    760,837 |    21,077 |
| 3,000 spans  |  49,285 |       493 |  7,410,623 |   212,263 |
| 30,000 spans |  50,348 |       504 | 72,035,866 | 2,098,591 |

Snapshot-only native Go results were 0.078 ms / 31,096 B / 309 allocations at 15 nodes and 100
paths; 1.141 ms / 326,264 B / 2,994 allocations at 60 nodes and 1,000 paths; and 6.615 ms /
1,858,551 B / 10,114 allocations at 200 nodes, 7,500 edges, and 1,000 paths.

## Known limitations and V2.4 gate

- The package consumes a small language-neutral span struct and has no production protobuf or
  collector-pipeline adapter yet.
- The single ownership lock is correct and race-free but serializes all ingestion. Sharding or an
  actor model should be considered only after profiling a shadow deployment.
- Topology state is in memory. V2.2 guarantees delivery of telemetry to the TypeScript sink, not
  persistence of this experimental derived state.
- Deduplication is bounded and keyed by span ID alone because that is the current TypeScript
  behavior. Reusing a span ID in another trace while the original is retained will suppress it.
- The latency sample window and runtime-path cap deliberately trade exact unbounded history for
  bounded memory. High-cardinality workloads can evict paths.
- The differential corpus is deterministic and broad but not a substitute for shadowing real
  production-shaped telemetry over a longer retention window.
- Go currently allocates heavily during reconstruction and snapshot sorting. The prototype is fast
  enough in this local comparison, but allocation reduction should precede high-volume cutover.

The passing corpus and race model are sufficient to begin a controlled V2.4 shadow-mode cutover
experiment behind an explicit feature flag, with both engines running and their canonical snapshots
compared. They are not sufficient for an immediate production authority switch. Production cutover
should require a zero-diff shadow soak, restart/replay validation with the V2.2 WAL, bounded-memory
evidence on real cardinality, and a rollback path. No cutover is performed in V2.3.
