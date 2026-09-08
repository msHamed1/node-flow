import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = process.argv[2];
if (!script) throw new Error('workspace script name is required');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifests = ['apps', 'packages'].flatMap((group) =>
  readdirSync(resolve(root, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, group, entry.name, 'package.json')),
);

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
