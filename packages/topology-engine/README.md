# @mshamed1/node-flow-topology-engine

The in-memory runtime topology aggregation engine used by NodeFlow's local collector. This package
is a transitive runtime dependency; application developers should install
[`@mshamed1/node-flow`](https://www.npmjs.com/package/@mshamed1/node-flow).

The engine owns live topology state, deterministic semantic component IDs, bounded metric samples,
and aggregated runtime paths. `createSnapshot()` produces the versioned derived architecture used
by the CLI without exposing the engine's internal maps or retained raw traces. This package also
contains snapshot validation, serialization, and architecture comparison so those rules remain
independent of CLI presentation.
