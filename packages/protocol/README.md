# @mshamed1/node-flow-protocol

Telemetry and topology contracts shared by NodeFlow runtime packages. This package is published so
the NodeFlow runtime dependency graph can be installed from npm; application developers should use
[`@mshamed1/node-flow`](https://www.npmjs.com/package/@mshamed1/node-flow).

The contracts distinguish the transient live dashboard payload from the stable versioned
architecture snapshot. Architecture snapshots contain normalized nodes, edges, and aggregated
runtime paths rather than raw spans.
