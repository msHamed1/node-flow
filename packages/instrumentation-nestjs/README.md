# @mshamed1/node-flow-instrumentation-nestjs

Safe NestJS instrumentation that adds controller and singleton-provider semantics to NodeFlow
traces.

Application developers should install
[`@mshamed1/node-flow`](https://www.npmjs.com/package/@mshamed1/node-flow) and import
`NodeFlowModule` from `@mshamed1/node-flow/nestjs`. The main package also supplies the Node.js
preload, collector, topology engine, CLI, and dashboard required for the complete runtime.

## Why this package exists

Generic HTTP and database spans show infrastructure activity, but they do not explain which NestJS
controller or application service owned the work. This integration uses public NestJS extension
points to add those semantic boundaries:

```text
HTTP route -> Controller -> Service -> Database / Queue / External API
```

It intentionally avoids patching undocumented NestJS container internals.

## Application setup

Import the module once in the root application module:

```ts
import { Module } from '@nestjs/common';
import { NodeFlowModule } from '@mshamed1/node-flow/nestjs';

@Module({
  imports: [NodeFlowModule],
})
export class AppModule {}
```

Run the application through the NodeFlow CLI:

```bash
npx node-flow dev -- npm run start:dev
```

## Configuration

Use `forRoot()` when the defaults need adjustment:

```ts
NodeFlowModule.forRoot({
  tracing: {
    controllers: true,
    services: true,
    excludeProviders: ['HealthService', 'MetricsService'],
    minDurationMs: 2,
  },
});
```

| Option             | Default | Meaning                                                         |
| ------------------ | ------- | --------------------------------------------------------------- |
| `controllers`      | `true`  | Create a semantic span for executed HTTP controller handlers    |
| `services`         | `true`  | Instrument eligible singleton application-provider methods      |
| `excludeProviders` | `[]`    | Provider class names that must not be instrumented              |
| `minDurationMs`    | `0`     | Hide faster controller/provider spans from NodeFlow trace views |

`minDurationMs` affects NodeFlow's normalization of the completed span. It does not skip execution
or alter the application method.

## How controller instrumentation works

`NodeFlowModule` registers one global `APP_INTERCEPTOR`. For HTTP requests, the interceptor creates
an active span named `<Controller>.<method>` and records stable controller identity, framework, and
method attributes. The span follows the returned RxJS observable through completion or error.

Non-HTTP execution contexts pass through unchanged.

## How provider instrumentation works

At application bootstrap, `DiscoveryService` inspects registered providers once. NodeFlow wraps
eligible prototype methods on their singleton instances so nested provider calls preserve the
active OpenTelemetry parent/child context.

The selection rules deliberately exclude:

- Request-scoped and transient providers
- Aliases, factory values, and non-static dependency trees
- NestJS infrastructure providers
- Guards, interceptors, middleware, pipes, and exception filters
- Lifecycle hooks such as `onModuleInit` and `onApplicationShutdown`
- Getters, setters, and instance arrow-function fields
- Providers named in `excludeProviders`

Wrapping preserves synchronous return behavior: a synchronous method does not become a promise.
Promise-like results remain asynchronous, errors are recorded and rethrown, and the same instance
is never wrapped twice.

## Public API

The main application-facing export is `NodeFlowModule`. This package also exports lower-level
utilities used for testing and advanced integrations:

- `NodeFlowNestInterceptor`
- `NodeFlowProviderExplorer`
- `resolveTracingOptions()`
- `shouldInstrumentProvider()`
- `instrumentProviderInstance()`
- The corresponding option and result types

Prefer the module over calling the lower-level utilities directly; their job is to support the
integration boundary, not application business logic.

## Boundaries and limitations

- Only executed HTTP controller handlers and eligible singleton providers produce semantic spans.
- Providers created after application bootstrap are not rediscovered automatically.
- Request-scoped and transient providers are excluded to avoid unsafe instance wrapping.
- Instance arrow-function fields are not on the prototype and are therefore not wrapped.
- Infrastructure visibility still comes from
  [`@mshamed1/node-flow-instrumentation-node`](https://github.com/msHamed1/node-flow/tree/main/packages/instrumentation-node#readme).

These constraints favor predictable application behavior and public NestJS APIs over maximum
automatic coverage.
