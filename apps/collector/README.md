# @mshamed1/node-flow-collector

The local in-memory telemetry collector and dashboard server launched by the NodeFlow CLI. This is
a transitive runtime dependency; application developers should install
[`@mshamed1/node-flow`](https://www.npmjs.com/package/@mshamed1/node-flow).

This TypeScript implementation remains the stable npm/CLI collector and owns the topology engine,
WebSocket publication, and dashboard. NodeFlow V2 adds an optional Go ingestion service in
`services/collector`; it forwards validated, bounded batches here during the migration. This
package is not deprecated and its existing JSON endpoints remain compatible.
