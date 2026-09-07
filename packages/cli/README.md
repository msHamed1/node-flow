# @mshamed1/node-flow

The main NodeFlow package. It provides the `node-flow` CLI, the bundled local dashboard, automatic
Node.js instrumentation, NestJS integration, and optional custom boundary APIs.

NodeFlow turns application traffic into a live runtime architecture map. A component appears only
after it executes, so the resulting graph describes observed behavior rather than static imports.

## Install

Node.js 20 or newer is required.

```bash
npm install --save-dev @mshamed1/node-flow
```

## Start NodeFlow

Run the application through NodeFlow using the development command you already use:

```bash
npx node-flow dev -- npm run start:dev
```

This command:

1. Resolves the exact-version Go runtime package for the current operating system and CPU.
2. Starts the Go collector and bundled dashboard on `127.0.0.1:7331`.
3. Waits for its machine-readable startup event and `/readyz` response.
4. Adds the NodeFlow preload to the child process through `NODE_OPTIONS` and selects Protobuf.
5. Launches the command after `--` with the actual `NODEFLOW_COLLECTOR_URL` configured.
6. Forwards termination signals and closes the runtime when the application exits.

Open [http://127.0.0.1:7331](http://127.0.0.1:7331) and exercise the application to populate the
map.

## NestJS applications

Import `NodeFlowModule` once in the root module. It adds semantic controller and singleton-provider
boundaries to the infrastructure spans captured by the Node.js preload.

```ts
import { Module } from '@nestjs/common';
import { NodeFlowModule } from '@mshamed1/node-flow/nestjs';

@Module({
  imports: [NodeFlowModule],
})
export class AppModule {}
```

Tracing behavior can be refined without changing business methods:

```ts
NodeFlowModule.forRoot({
  tracing: {
    controllers: true,
    services: true,
    excludeProviders: ['HealthService'],
    minDurationMs: 2,
  },
});
```

See
[`@mshamed1/node-flow-instrumentation-nestjs`](https://github.com/msHamed1/node-flow/tree/main/packages/instrumentation-nestjs#readme)
for the provider-selection rules and configuration details.

## CLI commands

| Command                                             | Purpose                                                  |
| --------------------------------------------------- | -------------------------------------------------------- |
| `node-flow dev -- <command>`                        | Start a local collector and run one instrumented process |
| `node-flow collector`                               | Start only the collector and dashboard                   |
| `node-flow run -- <command>`                        | Instrument a process using an existing collector         |
| `node-flow snapshot [--output <architecture.json>]` | Save the collector's current derived architecture        |
| `node-flow compare <before.json> <after.json>`      | Compare structure and meaningful runtime metric changes  |

`node-flow run` requires `NODEFLOW_COLLECTOR_URL`. It is useful when several processes should
report to the same collector:

```bash
node-flow collector

NODEFLOW_COLLECTOR_URL=http://127.0.0.1:7331 \
  NODEFLOW_SERVICE_NAME=payments-api \
  node-flow run -- npm run start:payments
```

## Architecture snapshots

Capture the architecture before and after a change:

```bash
npx node-flow snapshot --output before.json
# Exercise representative application traffic after making the change.
npx node-flow snapshot --output after.json
npx node-flow compare before.json after.json
```

Snapshots contain versioned application metadata, stable semantic components, executed
dependencies, aggregate metrics, and runtime paths. They intentionally omit raw spans and recent
trace payloads. Comparison reports structural additions/removals separately from meaningful metric
movement and flags newly observed external dependencies as warnings.

## Optional custom boundaries

Most applications do not need manual tracing. When automatic instrumentation cannot see a domain
or architectural boundary, import the helpers from the main package:

```ts
import { traceBoundary } from '@mshamed1/node-flow';

const result = await traceBoundary(
  {
    type: 'worker',
    name: 'SettlementWorker',
    operation: 'settle-round',
  },
  () => settlementWorker.run(),
);
```

Use `span(name, work)` or `nodeflow.span(name, work)` when you want trace detail without creating a
new architecture node. See
[`@mshamed1/node-flow-core`](https://github.com/msHamed1/node-flow/tree/main/packages/core#readme) for
the distinction.

## Configuration

| Variable                           | Default                  | Purpose                                    |
| ---------------------------------- | ------------------------ | ------------------------------------------ |
| `NODEFLOW_HOST`                    | `127.0.0.1`              | Collector bind host                        |
| `NODEFLOW_PORT`                    | `7331`                   | Collector and dashboard port               |
| `NODEFLOW_COLLECTOR_URL`           | `http://127.0.0.1:7331`  | Collector used by an instrumented process  |
| `NODEFLOW_SERVICE_NAME`            | Current npm package name | Service name attached to telemetry         |
| `NODEFLOW_DASHBOARD_DIR`           | Bundled dashboard        | Override for dashboard assets              |
| `NODEFLOW_DEBUG`                   | Disabled                 | Set to `1` to log failed telemetry exports |
| `NODEFLOW_STARTUP_TIMEOUT_MS`      | `15000`                  | Maximum wait for runtime readiness         |
| `NODEFLOW_RUNTIME_STOP_TIMEOUT_MS` | `10000`                  | Grace period before forced runtime stop    |

Set `NODEFLOW_PORT=0` to request a free port. The Go process binds first and emits a versioned JSON
control event containing the actual URL; the CLI does not infer the port from human log text.

The portable CLI always selects Go topology authority. For an emergency TypeScript rollback, use
the repository's explicit `typescript-rollback` Docker Compose profile.

## Package responsibilities

This package is the public entry point over smaller runtime packages:

- `node-flow-instrumentation-node` initializes OpenTelemetry and exports local telemetry.
- `node-flow-instrumentation-nestjs` adds controller and provider semantics.
- `node-flow-collector-<platform>-<arch>` supplies the version-matched Go runtime binary.
- The Go runtime accepts telemetry and derives nodes, dependencies, metrics, traces, and runtime
  paths.
- `node-flow-topology-engine` supplies snapshot utilities and the retained rollback/reference
  implementation.
- `node-flow-protocol` defines the contracts exchanged between those components.
- `node-flow-core` provides optional manual boundary helpers.

## Privacy and scope

NodeFlow is intended for local development. The default collector binds only to `127.0.0.1`, stores
its bounded WAL and topology checkpoint under the local `.nodeflow` directory, and does not provide
authentication or transport encryption. Do not expose it to a public or untrusted network.

See the
[portable runtime distribution contract](https://github.com/msHamed1/node-flow/blob/main/docs/distribution/npm-go-runtime.md)
for the supported platform matrix, version contract, failure messages, and container alternative.

For the complete guide, supported integrations, troubleshooting, and current limitations, see the
[repository README](https://github.com/msHamed1/node-flow#readme).
