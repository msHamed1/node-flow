import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishedPackages } from './release-packages.mjs';
import { runtimePackages, runtimeProtocolVersion } from './runtime-packages.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmCache = resolve(tmpdir(), 'node-flow-npm-cache');
const licenseSelected = existsSync(resolve(root, 'LICENSE'));
const forbiddenPatterns = [
  /(^|\/)src\//,
  /(^|\/)(coverage|screenshots?|fixtures?)\//i,
  /(^|\/)\.github\//,
  /(^|\/)\.env(?:\.|$)/,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /\.(?:pem|key|p12|pfx)$/i,
];
const failures = [];

const runPack = (directory) => {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: resolve(root, directory),
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: npmCache },
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `npm pack failed with status ${result.status}`,
    );
  }
  return JSON.parse(result.stdout)[0];
};

for (const releasePackage of publishedPackages) {
  try {
    const packed = runPack(releasePackage.directory);
    const filenames = packed.files.map((file) => file.path);
    const manifest = JSON.parse(
      readFileSync(resolve(root, releasePackage.directory, 'package.json'), 'utf8'),
    );

    const requiredFiles = releasePackage.runtimeTarget
      ? ['package.json', 'README.md', 'LICENSE', manifest.nodeflowRuntime?.binary].filter(Boolean)
      : ['package.json', 'dist/index.js', 'dist/index.d.ts'];
    for (const required of requiredFiles) {
      if (!filenames.includes(required)) {
        failures.push(`${releasePackage.name}: packed artifact is missing ${required}`);
      }
    }

    if (releasePackage.runtimeTarget) {
      const expected = runtimePackages.find(
        (candidate) => candidate.target === releasePackage.runtimeTarget,
      );
      if (
        !expected ||
        manifest.name !== expected.packageName ||
        manifest.os?.[0] !== expected.platform ||
        manifest.cpu?.[0] !== expected.architecture ||
        manifest.nodeflowRuntime?.protocolVersion !== runtimeProtocolVersion ||
        manifest.nodeflowRuntime?.binary !== `bin/${expected.binaryName}`
      ) {
        failures.push(`${releasePackage.name}: runtime target metadata is invalid`);
      }
    }
    if (licenseSelected && !filenames.includes('LICENSE')) {
      failures.push(`${releasePackage.name}: packed artifact is missing LICENSE`);
    }
    for (const filename of filenames) {
      if (forbiddenPatterns.some((pattern) => pattern.test(filename))) {
        failures.push(
          `${releasePackage.name}: packed artifact contains forbidden file ${filename}`,
        );
      }
    }

    if (releasePackage.name === '@mshamed1/node-flow') {
      for (const required of [
        'README.md',
        'dist/cli.js',
        'dist/nestjs.js',
        'dist/nestjs.d.ts',
        'dashboard/index.html',
      ]) {
        if (!filenames.includes(required)) {
          failures.push(`${releasePackage.name}: packed artifact is missing ${required}`);
        }
      }

      const cliPath = resolve(root, releasePackage.directory, 'dist/cli.js');
      const cliSource = readFileSync(cliPath, 'utf8');
      if (!cliSource.startsWith('#!/usr/bin/env node')) {
        failures.push(`${releasePackage.name}: dist/cli.js is missing its Node.js shebang`);
      }
      for (const runtime of runtimePackages) {
        if (manifest.optionalDependencies?.[runtime.packageName] !== manifest.version) {
          failures.push(
            `${releasePackage.name}: ${runtime.packageName} must be an exact optional dependency at ${manifest.version}`,
          );
        }
      }
      if (manifest.dependencies?.['@mshamed1/node-flow-collector']) {
        failures.push(
          `${releasePackage.name}: the TypeScript collector must not be a normal CLI dependency`,
        );
      }
    }

    console.log(
      `${releasePackage.name}@${packed.version}: ${packed.entryCount} files, ${packed.size} byte tarball`,
    );
  } catch (error) {
    failures.push(
      `${releasePackage.name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (failures.length > 0) {
  console.error('\nPackage validation failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`\nValidated ${publishedPackages.length} npm package payloads.`);
