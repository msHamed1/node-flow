# Contributing to NodeFlow

Thank you for improving NodeFlow. This repository is a Yarn Classic monorepo for the NodeFlow CLI,
runtime instrumentation, collector, topology engine, dashboard, and NestJS demo.

## Prerequisites

- Node.js 20 or newer
- Yarn Classic 1.22.22
- Go version declared by `services/collector/go.mod`
- Protobuf compiler 31.1 and `protoc-gen-go` 1.36.10 when regenerating the ingestion binding

Enable the repository's declared Yarn version with Corepack when it is available:

```bash
corepack enable
corepack prepare yarn@1.22.22 --activate
```

Do not add npm or pnpm lockfiles. `yarn.lock` is the canonical dependency lockfile.

## Local setup

```bash
git clone https://github.com/msHamed1/node-flow.git
cd node-flow
yarn install --frozen-lockfile
yarn build
yarn test
```

Run the included application and dashboard with:

```bash
yarn demo
```

## Repository layout

| Path                              | Purpose                                                   | Published               |
| --------------------------------- | --------------------------------------------------------- | ----------------------- |
| `packages/cli`                    | Main `@mshamed1/node-flow` package and `node-flow` binary | Yes                     |
| `packages/core`                   | Optional custom span and boundary APIs                    | Yes, runtime dependency |
| `packages/instrumentation-node`   | Node.js preload and OpenTelemetry integration             | Yes, runtime dependency |
| `packages/instrumentation-nestjs` | NestJS controller and provider integration                | Yes, runtime dependency |
| `packages/protocol`               | Shared contracts and TypeScript telemetry codec           | Yes, runtime dependency |
| `packages/topology-engine`        | TypeScript CLI/rollback/reference topology engine         | Yes, runtime dependency |
| `apps/collector`                  | Retained TypeScript rollback/reference collector          | Yes, compatibility      |
| `packages/collector-*`            | Five platform-specific Go runtime binary packages         | Yes, optional runtime   |
| `apps/dashboard`                  | Dashboard source bundled into `@mshamed1/node-flow`       | No                      |
| `apps/demo-nestjs`                | Local demonstration application                           | No                      |
| `apps/integration-api`            | Real NestJS API integration fixture                       | No                      |
| `apps/integration-worker`         | Real RabbitMQ consumer integration fixture                | No                      |
| `apps/mock-risk-service`          | Local outgoing-HTTP integration fixture                   | No                      |
| `packages/integration-contracts`  | Private API/worker event contracts                        | No                      |
| `proto/nodeflow/v1`               | Active language-neutral telemetry ingestion schema        | No                      |
| `services/collector`              | Go collector/topology source for npm binaries and images  | No                      |

The main package imports its TypeScript runtime dependencies and selects one exact-version optional
Go runtime package. TypeScript does not bundle those dependencies into `@mshamed1/node-flow`. The
retained TypeScript collector is no longer a normal dependency of the main CLI.

## Development checks

Before opening a pull request, run:

```bash
yarn format:check
yarn build
yarn lint
yarn test
yarn test:golden
yarn test:topology-diff
yarn package:check
yarn package:smoke
yarn runtime:check:current
yarn proto:check
yarn go:build
yarn go:vet
yarn go:test
yarn go:race
```

`package:check` inspects every `npm pack --dry-run` payload. `package:smoke` creates real tarballs,
installs them into a clean temporary consumer, verifies public imports, and runs
`node-flow collector` and `node-flow dev` with the packed native runtime and dashboard. A failing
`go` shim on `PATH` proves the clean consumer does not use a toolchain or repository build.

Changes to runtime instrumentation, topology semantics, the CLI preload path, or integration
fixtures should also run the real-infrastructure suite:

```bash
yarn integration:up
yarn integration:test
yarn integration:down
```

The suite requires Docker Compose and uses only demo-local credentials from `.env.example`. The
release workflow always runs it before Changesets can publish. Pull-request CI keeps the faster
build, lint, unit, and package checks mandatory; Prettier remains informational in both workflows.

The default Compose startup is Go-authoritative. Verify the retained TypeScript rollback explicitly
when changing collector routing, topology APIs, or Compose wiring:

```bash
NODEFLOW_TOPOLOGY_ENGINE=typescript \
  docker compose --profile typescript-rollback up -d --build --wait
docker compose ps nodeflow-collector nodeflow-typescript-rollback
```

Apply formatting with:

```bash
yarn format
```

## Changesets and SemVer

Every pull request that changes the behavior or published contents of a public package must include
a Changeset:

```bash
yarn changeset
```

Select all affected packages and use:

- `patch` for backward-compatible fixes and small improvements.
- `minor` for backward-compatible features or meaningful new public capabilities.
- `major` for breaking API, CLI, configuration, or runtime-behavior changes.

Most packages are versioned independently. The main package and five platform Go runtime packages
form a Changesets fixed group and must keep the same version; the main manifest must reference each
runtime with that exact version. Include each other package whose public behavior changes;
Changesets updates internal dependency ranges when required.

A Changeset is normally unnecessary for documentation-only edits, tests that do not alter package
behavior, formatting, or CI maintenance. If a pull request intentionally has no Changeset, explain
why in its description.

Write the Changeset summary for package consumers. Describe the outcome rather than internal task
or ticket names.

## Pull requests

- Keep changes focused and preserve NodeFlow's local-first privacy boundary.
- Add or update tests for behavior changes.
- Update the README when installation, configuration, supported behavior, or limitations change.
- Never commit npm tokens, automation tokens, `.env` files, certificates, or packed tarballs.
- Do not edit package versions manually; the release workflow owns versioning through Changesets.

The CI workflow checks formatting, compilation, type-level linting, tests, npm payloads, and the
clean-consumer install path on every pull request.

## Security reports

Do not place reusable credentials or sensitive customer telemetry in an issue. Until a dedicated
security policy and private reporting channel are configured, contact the repository owner before
sharing exploit details.
