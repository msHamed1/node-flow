# Releasing NodeFlow

This document is the canonical maintainer runbook for the seven public NodeFlow packages. The
repository uses Yarn Classic for dependency management, Changesets for versions and changelogs, and
the npm CLI for registry publication.

No package should be published while the release-readiness check fails.

## Published package set

Packages are published in dependency order:

1. `@mshamed1/node-flow-protocol`
2. `@mshamed1/node-flow-topology-engine`
3. `@mshamed1/node-flow-core`
4. `@mshamed1/node-flow-instrumentation-node`
5. `@mshamed1/node-flow-instrumentation-nestjs`
6. `@mshamed1/node-flow-collector`
7. `@mshamed1/node-flow`

The dashboard and demo workspaces remain private. The dashboard build is shipped inside the main
package under `dashboard/`.

## License

NodeFlow uses Apache License 2.0. The root and all seven public package directories carry the same
license text, and every public package manifest declares the `Apache-2.0` SPDX identifier.

When the license text or package structure changes, maintainers must confirm:

1. The root `LICENSE` and each package copy are byte-for-byte identical.
2. Every public manifest uses the same valid SPDX identifier.
3. Every npm tarball includes `LICENSE`.
4. `yarn release:check` passes.

The automated `yarn release` command begins with this validation and refuses to publish inconsistent
license metadata or files.

## One-time first publication

npm trusted publishing cannot create a package that does not already exist on npm. The first
version of each package must therefore be bootstrapped manually by an npm account allowed to create
packages in the `@mshamed1` organization.

### 1. Confirm ownership and repository identity

- Rename or create the GitHub repository as `msHamed1/node-flow`.
- Confirm every public package has the exact repository URL
  `git+https://github.com/msHamed1/node-flow.git`.
- Confirm the npm organization owns the `@mshamed1` scope and the maintainer can create public scoped
  packages.
- Enable two-factor authentication on the publishing npm account.

### 2. Finish and validate the release candidate

From a clean checkout of `main`:

```bash
yarn install --frozen-lockfile
yarn format:check
yarn build
yarn lint
yarn test
yarn package:check
yarn package:smoke
yarn release:check
```

Inspect the exact main package payload once more:

```bash
cd packages/cli
npm pack --dry-run
cd ../..
```

Verify that the CLI, declarations, public entry points, package README, and dashboard assets are
present and that source files, tests, credentials, and unrelated repository files are absent.

### 3. Bootstrap version 0.1.0 manually

Authenticate interactively; never store the token in the repository or a GitHub secret:

```bash
npm login
npm whoami
```

Publish each package exactly once in dependency order:

```bash
npm publish --workspace @mshamed1/node-flow-protocol --access public
npm publish --workspace @mshamed1/node-flow-topology-engine --access public
npm publish --workspace @mshamed1/node-flow-core --access public
npm publish --workspace @mshamed1/node-flow-instrumentation-node --access public
npm publish --workspace @mshamed1/node-flow-instrumentation-nestjs --access public
npm publish --workspace @mshamed1/node-flow-collector --access public
npm publish --workspace @mshamed1/node-flow --access public
```

After every command, verify the package and version on npm before proceeding. If a dependency fails,
stop; do not publish packages that depend on the missing version.

### 4. Configure npm trusted publishers

After all seven packages exist, configure a trusted publisher separately on each package's npm
settings page:

- Provider: GitHub Actions
- Organization or user: `msHamed1`
- Repository: `node-flow`
- Workflow filename: `release.yml`
- Environment: leave blank unless the workflow is later updated to use the same protected GitHub
  environment
- Allowed action: `npm publish`

Use only the filename, not `.github/workflows/release.yml`. npm permits one trusted publisher per
package. Keep the workflow on a GitHub-hosted runner.

The release job uses Node.js 24, the latest npm 11 release, disables release dependency caching,
and grants the required `id-token: write` permission. Trusted publishing requires npm 11.5.1 or
newer, while the `npm trust` management command currently requires npm 11.15 or newer. The workflow
does not use `NPM_TOKEN`; npm generates provenance automatically for trusted publications.

After trusted publishing succeeds, set each package's npm publishing access to require two-factor
authentication and disallow token-based publishing.

### 5. Enable automated publication

Create this GitHub repository variable only after every package has a trusted publisher:

```text
NPM_TRUSTED_PUBLISHING_ENABLED=true
```

Before the variable exists, `release.yml` can create and update a version pull request but cannot
publish. This is the bootstrap safety switch.

Repository settings must also allow GitHub Actions to create and approve pull requests. Protect
`main`, require CI, and restrict who may merge the release pull request.

## Normal release flow

1. A contributor runs `yarn changeset` and commits the generated file with the change.
2. After the pull request merges, `release.yml` uses `changesets/action@v1` to create or update the
   `Release packages` pull request.
3. Changesets consumes pending files, updates package versions and internal dependency versions,
   and maintains package changelogs in that pull request.
4. A maintainer reviews the version plan, changelogs, CI result, and npm payload report, then merges
   the release pull request.
5. The next `main` run executes `yarn release`. Changesets publishes only unpublished versions using
   npm's GitHub OIDC identity.
6. The Changesets action creates Git tags and GitHub Releases for successfully published versions.

Do not manually edit versions or delete Changeset files to force a release.

## Verification after publication

For every released package:

- Confirm the expected version and `latest` dist-tag on npm.
- Confirm the npm page displays provenance for the publication.
- Confirm the Git tag and GitHub Release exist.
- Install `@mshamed1/node-flow` in a new temporary NestJS application and run
  `npx node-flow --help` before announcing the release.

## Failed automated release

Package versions on npm are immutable. First determine which packages were published:

```bash
npm view @mshamed1/node-flow versions --json
npm view @mshamed1/node-flow-protocol versions --json
```

Then:

1. Do not rerun blindly if npm contains only part of the version set.
2. Fix the underlying problem on `main`.
3. If the unpublished packages still reference versions that now exist and their exact package
   versions remain unpublished, rerun the failed workflow once.
4. If package contents must change, create corrective Changesets and release new patch versions.
5. Never reuse or overwrite a version that reached npm.

Prefer a forward patch release over unpublishing. Unpublishing can break existing consumers and is
subject to npm policy restrictions.

## Emergency manual publication

Use manual publication only when GitHub Actions or npm trusted publishing is unavailable and a
release is operationally urgent. Require a second maintainer to review the exact commit, version
set, test results, and `npm pack --dry-run` output.

Authenticate with `npm login`, run the full validation sequence, and publish only the exact packages
whose manifest versions do not yet exist on npm, in dependency order. Record the commands and npm
URLs in a GitHub issue. Reconcile missing Git tags and GitHub Releases immediately afterward.

Never create a long-lived automation token as a shortcut around the trusted-publishing workflow.

## Deprecating a bad version

When a version is unsafe or unusable but should remain available for dependency resolution, add a
clear deprecation message and publish a fixed patch:

```bash
npm deprecate '@mshamed1/node-flow@0.1.1' 'Known issue: upgrade to 0.1.2 or newer.'
```

Deprecate affected internal package versions as well. Do not deprecate an entire package range when
only one version is affected.

## Prereleases

Prereleases require an explicit maintainer plan and should use a non-`latest` dist-tag such as
`next`:

```bash
yarn changeset pre enter next
yarn changeset
yarn version-packages
yarn build
yarn test
yarn package:check
yarn package:smoke
yarn changeset publish --tag next
yarn changeset pre exit
```

Do not run this sequence from the normal `release.yml` workflow without first adding a reviewed,
separate prerelease path. Confirm that no prerelease has changed the `latest` dist-tag.

## Reference documentation

- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm trusted publisher management](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
- [Changesets configuration](https://github.com/changesets/changesets/blob/main/docs/config-file-options.md)
- [Changesets GitHub Action](https://github.com/changesets/action/tree/v1)
