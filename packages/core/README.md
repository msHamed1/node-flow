# @mshamed1/node-flow-core

Optional tracing helpers for architectural or domain operations that automatic instrumentation
cannot see.

Most application developers should install
[`@mshamed1/node-flow`](https://www.npmjs.com/package/@mshamed1/node-flow) and import these APIs from
the main package. This lower-level package exists so the boundary API remains independent of the
CLI and framework integrations.

## What belongs here

NodeFlow automatically discovers HTTP, NestJS, database, cache, queue, and external HTTP activity.
Use this package only for important boundaries that do not pass through a supported framework or
client library, such as a custom worker dispatcher or a domain pipeline.

The package offers two different levels of detail:

- `traceBoundary()` creates a semantic boundary that can become a node in the architecture graph.
- `span()` and `nodeflow.span()` add trace detail but do not create topology nodes.

## Usage through the main package

```ts
import { nodeflow, traceBoundary } from '@mshamed1/node-flow';

const decision = await traceBoundary(
  {
    type: 'service',
    name: 'RiskDecisionEngine',
    operation: 'evaluate-payment',
    identity: 'service:risk-decision-engine',
  },
  () => riskEngine.evaluate(payment),
);

await nodeflow.span('calculate-exposure', () => calculateExposure(decision));
```

Both helpers accept synchronous or asynchronous work and always return a promise. They preserve the
return value, record thrown errors on the OpenTelemetry span, and rethrow the original failure.

## Public API

### `traceBoundary(options, work)`

Creates an active span with NodeFlow semantic attributes.

```ts
interface BoundaryOptions {
  type: TopologyNodeType;
  name: string;
  operation?: string;
  identity?: string;
  attributes?: Attributes;
}
```

- `type` controls the architecture category, such as `service`, `worker`, `queue`, or
  `external-http`.
- `name` is the human-readable component name.
- `operation` describes the executed action while keeping the component identity stable.
- `identity` is the stable aggregation key. It defaults to `${type}:${name}`.
- `attributes` adds OpenTelemetry attributes to the span.

Choose identities from logical architecture, not request IDs, player IDs, order IDs, or other
high-cardinality values. Dynamic identities would create a new graph node for every request.

### `span(name, work)`

Creates a `custom` trace-detail span. Use it to explain work inside an existing component without
changing the architecture graph.

```ts
import { span } from '@mshamed1/node-flow';

const result = await span('validate-settlement-rules', () => validator.validate(input));
```

### `nodeflow.span(name, work)`

An object-style alias for `span()`:

```ts
import { nodeflow } from '@mshamed1/node-flow';

await nodeflow.span('reconcile-wallet', () => wallet.reconcile());
```

### `traceServiceOperation(serviceName, work)`

Deprecated compatibility helper. NestJS services are instrumented automatically, and new code
should use `traceBoundary()` only when an explicit boundary is genuinely needed.

## Runtime behavior

These helpers use the global OpenTelemetry tracer. When NodeFlow or another tracer provider is not
active, the wrapped work still executes normally and the created span is non-recording. This
package does not start a collector, install instrumentation, or export telemetry by itself.

## Design boundary

Keep manual spans sparse and architectural. NodeFlow's graph is intended to describe stable system
components and executed dependencies, not every function call. Framework and infrastructure
instrumentation should remain the default source of telemetry.
