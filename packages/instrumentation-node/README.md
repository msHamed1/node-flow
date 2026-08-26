# @mshamed1/node-flow-instrumentation-node

Node.js OpenTelemetry preload, local exporter, and runtime metrics used by
[`@mshamed1/node-flow`](https://www.npmjs.com/package/@mshamed1/node-flow). The NodeFlow CLI configures this
package automatically; application developers should install the main package.

The preload intentionally registers only the instrumentations NodeFlow currently supports:

- Node HTTP servers and clients
- Express route enrichment
- Node `fetch`/Undici clients
- MongoDB and Mongoose
- PostgreSQL
- Redis
- RabbitMQ/AMQP through `amqplib`

NestJS controller and singleton-provider semantics come from NodeFlow's NestJS package rather than
the generic OpenTelemetry NestJS instrumentation.
