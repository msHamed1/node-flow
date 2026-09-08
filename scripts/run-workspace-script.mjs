import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = process.argv[2];
if (!script) throw new Error('workspace script name is required');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workspaceRoots = [
  'cli',
  'dashboard',
  'examples',
  'protocol',
  'reference',
  'runtime/npm',
  'sdk',
  'tests/integration',
];
const manifests = workspaceRoots.flatMap(manifestsUnder);

for (const manifestPath of manifests) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') continue;
    throw error;
  }
  if (manifest.nodeflowRuntime || !manifest.scripts?.[script]) continue;
  const command = process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
  const result = spawnSync(command, ['workspace', manifest.name, script], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function manifestsUnder(relativeDirectory) {
  const directory = resolve(root, relativeDirectory);
  const directManifest = resolve(directory, 'package.json');
  if (existsSync(directManifest)) return [directManifest];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(directory, entry.name, 'package.json'))
    .filter(existsSync);
}
