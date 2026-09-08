import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimePackageFor, runtimePackages } from './runtime-packages.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
if (process.env.NODEFLOW_SKIP_RUNTIME_BUILD === '1') {
  console.log('Skipped Go runtime packages for this TypeScript-only image build.');
  process.exit(0);
}
const cliManifest = readManifest('cli/package.json');
const clean = process.argv.includes('--clean');
const validateOnly = process.argv.includes('--validate-only');
const current = process.argv.includes('--current');
const requestedTarget = argumentAfter('--target');
let targets = runtimePackages;

if (current) {
  const selected = runtimePackageFor(process.platform, process.arch);
  if (!selected) fail(`unsupported build host ${process.platform}-${process.arch}`);
  targets = [selected];
} else if (requestedTarget) {
  const selected = runtimePackages.find((candidate) => candidate.target === requestedTarget);
  if (!selected) fail(`unknown runtime target ${requestedTarget}`);
  targets = [selected];
}

for (const target of targets) {
  const outputDirectory = resolve(root, target.directory, 'bin');
  if (clean) {
    rmSync(outputDirectory, { recursive: true, force: true });
    continue;
  }

  const manifest = readManifest(`${target.directory}/package.json`);
  validateManifest(target, manifest);
  if (validateOnly) {
    console.log(`Validated ${target.packageName}@${manifest.version} for ${target.target}`);
    continue;
  }
  mkdirSync(outputDirectory, { recursive: true });
  const output = resolve(outputDirectory, target.binaryName);
  const result = spawnSync(
    'go',
    [
      'build',
      '-trimpath',
      '-ldflags',
      `-s -w -X main.version=${cliManifest.version}`,
      '-o',
      output,
      './cmd/nodeflow-collector',
    ],
    {
      cwd: resolve(root, 'runtime/go'),
      encoding: 'utf8',
      env: {
        ...process.env,
        CGO_ENABLED: '0',
        GOOS: target.goos,
        GOARCH: target.goarch,
      },
    },
  );
  if (result.status !== 0) {
    fail(result.stderr || result.stdout || `go build failed for ${target.target}`);
  }
  if (target.platform !== 'win32') chmodSync(output, 0o755);
  console.log(`Built ${target.packageName}@${manifest.version} for ${target.target}`);
}

function readManifest(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
}

function validateManifest(target, manifest) {
  if (manifest.name !== target.packageName) fail(`${target.directory}: package name drift`);
  if (manifest.version !== cliManifest.version) {
    fail(`${manifest.name}: version ${manifest.version} must match CLI ${cliManifest.version}`);
  }
  if (manifest.os?.length !== 1 || manifest.os[0] !== target.platform) {
    fail(`${manifest.name}: os metadata must be ${target.platform}`);
  }
  if (manifest.cpu?.length !== 1 || manifest.cpu[0] !== target.architecture) {
    fail(`${manifest.name}: cpu metadata must be ${target.architecture}`);
  }
  if (manifest.nodeflowRuntime?.binary !== `bin/${target.binaryName}`) {
    fail(`${manifest.name}: binary metadata does not match ${target.binaryName}`);
  }
}

function argumentAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
