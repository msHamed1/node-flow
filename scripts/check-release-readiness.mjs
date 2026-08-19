import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishedPackages, repositoryUrl } from './release-packages.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const errors = [];
const manifests = new Map();
const rootLicensePath = resolve(root, 'LICENSE');
const rootLicense = existsSync(rootLicensePath) ? readFileSync(rootLicensePath, 'utf8') : undefined;

for (const releasePackage of publishedPackages) {
  const manifestPath = resolve(root, releasePackage.directory, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifests.set(manifest.name, manifest);

  if (manifest.name !== releasePackage.name) {
    errors.push(`${releasePackage.directory}: expected package name ${releasePackage.name}`);
  }
  if (manifest.private === true) {
    errors.push(`${manifest.name}: publishable package must not be private`);
  }
  for (const field of ['version', 'description', 'homepage']) {
    if (!manifest[field]) errors.push(`${manifest.name}: missing ${field}`);
  }
  if (manifest.repository?.url !== repositoryUrl) {
    errors.push(`${manifest.name}: repository.url must be ${repositoryUrl}`);
  }
  if (manifest.bugs?.url !== 'https://github.com/msHamed1/node-flow/issues') {
    errors.push(`${manifest.name}: bugs.url must point to the NodeFlow issue tracker`);
  }
  if (manifest.publishConfig?.access !== 'public') {
    errors.push(`${manifest.name}: publishConfig.access must be public`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    errors.push(`${manifest.name}: files must explicitly define the npm payload`);
  }
  if (!manifest.license) {
    errors.push(`${manifest.name}: missing license after the project owner selects one`);
  }

  const packageLicensePath = resolve(root, releasePackage.directory, 'LICENSE');
  if (!existsSync(packageLicensePath)) {
    errors.push(`${manifest.name}: missing package LICENSE file`);
  } else if (rootLicense && readFileSync(packageLicensePath, 'utf8') !== rootLicense) {
    errors.push(`${manifest.name}: package LICENSE does not match the root LICENSE`);
  }
}

const licenses = new Set(
  [...manifests.values()].map((manifest) => manifest.license).filter(Boolean),
);
if (!rootLicense) {
  errors.push('repository: missing LICENSE file; the project owner must select a license');
}
if (licenses.size > 1) {
  errors.push('publishable packages do not use one consistent SPDX license identifier');
}

for (const [packageName, manifest] of manifests) {
  for (const dependencyType of ['dependencies', 'optionalDependencies']) {
    for (const dependencyName of Object.keys(manifest[dependencyType] ?? {})) {
      if (dependencyName.startsWith('@mshamed1/node-flow') && !manifests.has(dependencyName)) {
        errors.push(`${packageName}: runtime dependency ${dependencyName} is not publishable`);
      }
    }
  }
}

const mainPackage = manifests.get('@mshamed1/node-flow');
if (mainPackage?.bin?.['node-flow'] !== './dist/cli.js') {
  errors.push('@mshamed1/node-flow: node-flow CLI binary is missing or points to the wrong file');
}
if (!mainPackage?.exports?.['./nestjs']) {
  errors.push('@mshamed1/node-flow: ./nestjs export is missing');
}

if (errors.length > 0) {
  console.error('NodeFlow is not ready to publish:');
  for (const error of errors) console.error(`- ${error}`);
  console.error(
    '\nPublishing remains blocked until a license is selected, the root and package LICENSE files agree, and every publishable package declares the same SPDX license identifier.',
  );
  process.exit(1);
}

console.log(`Release metadata is ready for ${publishedPackages.length} public packages.`);
