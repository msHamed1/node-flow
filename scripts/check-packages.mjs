import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishedPackages } from './release-packages.mjs';

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

    for (const required of ['package.json', 'dist/index.js', 'dist/index.d.ts']) {
      if (!filenames.includes(required)) {
        failures.push(`${releasePackage.name}: packed artifact is missing ${required}`);
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
