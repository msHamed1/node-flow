# @mshamed1/node-flow-instrumentation-node

The Node.js OpenTelemetry preload, local span exporter, and runtime-metrics reporter used by
NodeFlow.

Application developers should normally install
[`@mshamed1/node-flow`](https://www.npmjs.com/package/@mshamed1/node-flow). The CLI loads this
package before the target application's imports so supported libraries can be instrumented at
startup.

## Role in NodeFlow

```text
Application libraries
        ↓ OpenTelemetry instrumentation
Normalized spans + runtime metrics
        ↓ local HTTP
NodeFlow collector
        ↓
Topology engine and dashboard
```

This package owns telemetry capture and transport. It does not aggregate the architecture, serve
the dashboard, or add NestJS controller/provider semantics.

## Automatic preload

The CLI resolves `@mshamed1/node-flow-instrumentation-node/register` and adds it to the child
process through Node's `--import` option:

```bash
npx node-flow dev -- npm run start:dev
```

The register entry point calls `startNodeFlowInstrumentation()` before application libraries are
loaded. Starting it more than once in the same process returns the already running SDK.

## Supported integrations

The preload registers an explicit, intentionally small instrumentation set:

| Runtime boundary        | OpenTelemetry integration |
| ----------------------- | ------------------------- |
| Node HTTP client/server | `http`                    |
| Express route metadata  | `express`                 |
| Node `fetch`            | `undici`                  |
| MongoDB driver          | `mongodb`                 |
| Mongoose                | `mongoose`                |
| PostgreSQL              | `pg`                      |
| Redis                   | `redis`                   |
| RabbitMQ/AMQP           | `amqplib`                 |

Express instrumentation is retained so server spans carry concrete matched routes instead of only
generic HTTP operation names. MongoDB and Mongoose operations are normalized to one MongoDB
architecture identity while their operation names remain available in trace detail.

NestJS controller and provider semantics come from
[`@mshamed1/node-flow-instrumentation-nestjs`](https://github.com/msHamed1/node-flow/tree/main/packages/instrumentation-nestjs#readme),
not generic OpenTelemetry NestJS instrumentation.

## Direct API

Advanced hosts can start the SDK directly, but the import must still happen before the libraries
that need instrumentation:

```ts
import { startNodeFlowInstrumentation } from '@mshamed1/node-flow-instrumentation-node';

const sdk = startNodeFlowInstrumentation();
```

For normal applications, prefer the CLI so preload ordering and collector configuration are
handled together.

## Span normalization

Before export, OpenTelemetry spans are converted to NodeFlow's protocol:

- HTTP servers become `http-route` components.
- HTTP clients become `external-http` dependencies.
- Database, Redis, and messaging attributes become infrastructure components.
- NodeFlow semantic attributes preserve controller, service, worker, and custom boundaries.
- Stable `nodeflow.identity` values let the topology engine aggregate repeated executions.
- Operation names remain available separately from the stable architecture identity.

Only completed spans are exported. NodeFlow's own requests to the collector are suppressed so they
do not recursively appear as application dependencies.

## Runtime metrics

The package reports process metrics to the collector every two seconds:

- Resident set size (RSS)
- Used and total JavaScript heap
- CPU percentage
- Event-loop utilization
- Process uptime

The timer is unreferenced, so metrics collection does not keep the application process alive.

## Configuration

| Variable                   | Default                                | Purpose                                     |
| -------------------------- | -------------------------------------- | ------------------------------------------- |
| `NODEFLOW_COLLECTOR_URL`   | `http://127.0.0.1:7331`                | Local destination for spans and metrics     |
| `NODEFLOW_EXPORT_PROTOCOL` | `json`                                 | `protobuf` for the V2 Go collector          |
| `NODEFLOW_SERVICE_NAME`    | npm package name or `node-application` | Logical service name                        |
| `NODEFLOW_DEBUG`           | Disabled                               | Set to `1` to log telemetry export failures |

Span exports use short timeouts and failures do not fail the application request. With debug mode
disabled, a stopped or unreachable local collector remains silent.

## Privacy and operational boundary

The exporter sends telemetry to the configured collector over HTTP. The default is local-only, but
this package does not authenticate or encrypt a custom remote collector URL. Keep the collector on
a trusted development machine and avoid recording sensitive values in custom span attributes.
