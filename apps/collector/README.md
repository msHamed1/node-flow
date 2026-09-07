# @mshamed1/node-flow-collector

The retained in-memory TypeScript telemetry collector and dashboard server. Application developers
should install
[`@mshamed1/node-flow`](https://www.npmjs.com/package/@mshamed1/node-flow).

In V2.4 the Go service in `services/collector` is the default npm and container collector and
topology authority. The main npm CLI no longer depends on or launches this package. This TypeScript
implementation remains active for the explicit `nodeflow-typescript-rollback` Compose service,
public API compatibility, and topology reference/differential tests. The Go collector forwards
validated, bounded batches here only when `NODEFLOW_TOPOLOGY_ENGINE=typescript` selects rollback.
This package has not yet been removed or deprecated, and its existing JSON endpoints remain
compatible.
