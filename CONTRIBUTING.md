# Contributing to NodeFlow

Thank you for improving NodeFlow. This repository is a Yarn Classic monorepo for the NodeFlow CLI,
runtime instrumentation, collector, topology engine, dashboard, and NestJS demo.

## Prerequisites

- Node.js 20 or newer
- Yarn Classic 1.22.22

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
| `packages/protocol`               | Shared telemetry contracts                                | Yes, runtime dependency |
| `packages/topology-engine`        | In-memory topology aggregation                            | Yes, runtime dependency |
| `apps/collector`                  | Local collector and dashboard server                      | Yes, runtime dependency |
| `apps/dashboard`                  | Dashboard source bundled into `@mshamed1/node-flow`       | No                      |
| `apps/demo-nestjs`                | Local demonstration application                           | No                      |
| `apps/integration-api`            | Real NestJS API integration fixture                       | No                      |
| `apps/integration-worker`         | Real RabbitMQ consumer integration fixture                | No                      |
| `apps/mock-risk-service`          | Local outgoing-HTTP integration fixture                   | No                      |
| `packages/integration-contracts`  | Private API/worker event contracts                        | No                      |

The internal packages are published because the main package imports them at runtime; TypeScript
does not bundle those dependencies into `@mshamed1/node-flow`.

## Development checks

Before opening a pull request, run:

```bash
yarn format:check
yarn build
yarn lint
yarn test
yarn package:check
yarn package:smoke
```

`package:check` inspects every `npm pack --dry-run` payload. `package:smoke` creates real tarballs,
installs them into a clean temporary consumer, verifies public imports, and runs
`node-flow --help`.

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

The main package and its runtime dependencies are versioned independently. Include each package
whose own public behavior changes; Changesets will update internal dependency ranges when required.

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
