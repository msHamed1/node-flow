# Portable Go runtime distribution

`@mshamed1/node-flow` keeps the public CLI in TypeScript and distributes the collector as
platform-specific optional npm packages. Installation performs no executable download and runs no
postinstall fetch script.

## Supported packages

| Node platform | Node architecture | Optional package                                      | Go target       |
| ------------- | ----------------- | ----------------------------------------------------- | --------------- |
| `darwin`      | `arm64`           | `@mshamed1/node-flow-collector-darwin-arm64`          | `darwin/arm64`  |
| `darwin`      | `x64`             | `@mshamed1/node-flow-collector-darwin-x64`            | `darwin/amd64`  |
| `linux`       | `arm64`           | `@mshamed1/node-flow-collector-linux-arm64`           | `linux/arm64`   |
| `linux`       | `x64`             | `@mshamed1/node-flow-collector-linux-x64`             | `linux/amd64`   |
| `win32`       | `x64`             | `@mshamed1/node-flow-collector-win32-x64`             | `windows/amd64` |

Each package declares npm `os` and `cpu` metadata and contains one statically linked,
`CGO_ENABLED=0` collector binary. npm selects the compatible optional package. Unsupported targets
fail before startup with the detected platform/architecture and the complete supported list.

## Version contract

The main package declares every runtime package as an exact-version optional dependency. The main
package and all five native packages are also in one Changesets fixed group, so a release versions
them together. The launcher validates both the runtime package manifest and the version reported by
the running binary. It never searches `PATH`, invokes `go`, or selects an arbitrary/latest runtime.

If an optional dependency was disabled or removed, reinstall with optional dependencies enabled. A
package/version mismatch fails explicitly and must be fixed by reinstalling a coherent release.

## Startup and dynamic ports

The launcher passes `NODEFLOW_STARTUP_PROTOCOL=json-v1`. After the Go process successfully binds its
listener, it writes one control event to stdout:

```json
{
  "type": "nodeflow.runtime.ready",
  "protocolVersion": 1,
  "address": "127.0.0.1:49152",
  "url": "http://127.0.0.1:49152",
  "runtimeVersion": "<package-version>",
  "pid": 12345
}
```

This makes `NODEFLOW_PORT=0` reliable without parsing logs. The CLI validates the event, confirms
the exact runtime version, polls `/readyz`, and starts the user's application only after readiness.
`NODEFLOW_STARTUP_TIMEOUT_MS` defaults to 15 seconds.

Normal structured Go logs and stderr are forwarded. SIGINT/SIGTERM are forwarded to the child, the
Go server closes admission and drains within its configured shutdown deadline, and the launcher
forces termination only after `NODEFLOW_RUNTIME_STOP_TIMEOUT_MS` (10 seconds by default). If the
application exits, the runtime is stopped. If the runtime exits unexpectedly, the application is
terminated and the CLI returns a failure.

## Dashboard assets

The main npm tarball contains `dashboard/`. The CLI resolves that directory relative to its own
installed package and passes the absolute path as `NODEFLOW_DASHBOARD_DIR`; the Go process serves the
same REST, WebSocket, and single-page dashboard routes from any consumer working directory.

## Development and verification

Repository builds cross-compile all five native packages:

```bash
yarn runtime:build
yarn package:check
yarn package:smoke
```

`package:smoke` packs the public packages, installs only the current native runtime into a clean
temporary consumer, places a failing `go` shim first on `PATH`, and exercises both `node-flow
collector` and `node-flow dev` with a dynamic port, Go health response, and packaged dashboard.

Pull-request CI additionally builds and starts the native package/launcher pairing on Linux x64,
Linux arm64, macOS arm64, macOS x64, and Windows x64 GitHub-hosted runners.

## Container releases and rollback

The `Collector container release` workflow is triggered by a main-package release tag and publishes
`ghcr.io/mshamed1/node-flow-collector` for `linux/amd64` and `linux/arm64`. It publishes the package
version tag and a full commit-SHA tag, never `latest`, and records an artifact attestation. The
version tag is refused if it already exists.

Deployments should pin the manifest digest returned by the registry:

```text
ghcr.io/mshamed1/node-flow-collector@sha256:<manifest-digest>
```

Rollback means replacing the current digest with a previously verified digest while reusing the
same NodeFlow volume. The manually dispatched `Verify collector container rollback` workflow takes
current and previous digest-pinned references. It writes topology through the current image, stops
it gracefully, starts the previous image over the same WAL/topology volume, verifies restored state,
and confirms that the previous image accepts and persists a new write.

The first cross-version rollback run requires two published portable-runtime releases. Until those
artifacts exist, the retained `typescript-rollback` Compose profile remains the explicit emergency
fallback.
