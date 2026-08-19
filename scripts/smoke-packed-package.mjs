import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishedPackages } from './release-packages.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixture = mkdtempSync(join(tmpdir(), 'node-flow-package-smoke-'));
const packsDirectory = join(fixture, 'packs');
const consumerDirectory = join(fixture, 'consumer');
mkdirSync(packsDirectory);
mkdirSync(consumerDirectory);

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: join(fixture, '.npm-cache') },
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(' ')} failed with status ${result.status}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return result.stdout.trim();
};

try {
  const tarballs = [];
  for (const releasePackage of publishedPackages) {
    const output = run('npm', ['pack', '--json', '--pack-destination', packsDirectory], {
      cwd: resolve(root, releasePackage.directory),
    });
    const packed = JSON.parse(output)[0];
    tarballs.push(join(packsDirectory, packed.filename));
    console.log(`Packed ${releasePackage.name} as ${packed.filename}`);
  }

  writeFileSync(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ name: 'node-flow-packed-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '@nestjs/common@^11.1.0',
      '@nestjs/core@^11.1.0',
      'reflect-metadata@^0.2.2',
      'rxjs@^7.8.2',
      ...tarballs,
    ],
    { cwd: consumerDirectory },
  );

  writeFileSync(
    join(consumerDirectory, 'consumer.mjs'),
    [
      "import { nodeflow, traceBoundary } from '@node-flow/node';",
      "import { NodeFlowModule } from '@node-flow/node/nestjs';",
      '',
      "if (typeof nodeflow.span !== 'function') throw new Error('nodeflow.span export is missing');",
      "if (typeof traceBoundary !== 'function') throw new Error('traceBoundary export is missing');",
      "if (typeof NodeFlowModule !== 'function') throw new Error('NodeFlowModule export is missing');",
      "console.log('NodeFlow imports are usable');",
      '',
    ].join('\n'),
  );

  const importOutput = run('node', ['consumer.mjs'], { cwd: consumerDirectory });
  if (!importOutput.includes('NodeFlow imports are usable')) {
    throw new Error(`unexpected consumer output: ${importOutput}`);
  }

  const binary = join(consumerDirectory, 'node_modules', '.bin', 'node-flow');
  const helpOutput = run(binary, ['--help'], { cwd: consumerDirectory });
  if (!helpOutput.includes('Usage: node-flow dev -- <command> [args...]')) {
    throw new Error(`unexpected CLI help output: ${helpOutput}`);
  }

  const installed = JSON.parse(
    readFileSync(
      join(consumerDirectory, 'node_modules', '@node-flow', 'node', 'package.json'),
      'utf8',
    ),
  );
  console.log(
    `Installed ${installed.name}@${installed.version} from ${basename(tarballs.at(-1))}.`,
  );
  console.log('Packed consumer imports and node-flow --help passed.');
} finally {
  if (process.env.NODEFLOW_KEEP_SMOKE_FIXTURE === '1') {
    console.log(`Kept smoke fixture at ${fixture}`);
  } else {
    rmSync(fixture, { recursive: true, force: true });
  }
}
