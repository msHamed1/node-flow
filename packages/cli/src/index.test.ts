import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { nodeflow, span, traceBoundary } from '@node-flow/node';
import { NodeFlowModule } from '@node-flow/node/nestjs';
import { createInstrumentedEnvironment, getNodeFlowPreloadUrl } from './child-environment.js';

const executeFile = promisify(execFile);

describe('NodeFlow public package', () => {
  it('exports optional custom instrumentation from the root package', () => {
    expect(nodeflow.span).toBe(span);
    expect(traceBoundary).toBeTypeOf('function');
  });

  it('exports the NestJS integration from @node-flow/node/nestjs', () => {
    expect(NodeFlowModule).toBeTypeOf('function');
    expect(NodeFlowModule.forRoot).toBeTypeOf('function');
  });

  it('publishes the scoped package with the node-flow binary', async () => {
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { name: string; bin: Record<string, string> };

    expect(manifest.name).toBe('@node-flow/node');
    expect(manifest.bin).toEqual({ 'node-flow': './dist/cli.js' });
  });

  it('resolves both public exports from an external-style consumer', async () => {
    const fixtureDirectory = await mkdtemp(join(tmpdir(), 'node-flow-consumer-'));
    const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
    const packageLink = join(fixtureDirectory, 'node_modules', '@node-flow', 'node');

    try {
      await mkdir(dirname(packageLink), { recursive: true });
      await symlink(packageDirectory, packageLink, 'dir');
      await writeFile(
        join(fixtureDirectory, 'consumer.mjs'),
        [
          "import { nodeflow, traceBoundary } from '@node-flow/node';",
          "import { NodeFlowModule } from '@node-flow/node/nestjs';",
          "console.log(nodeflow.span === undefined ? 'missing' : 'root-ok');",
          'console.log(typeof traceBoundary, typeof NodeFlowModule);',
        ].join('\n'),
      );

      const { stdout } = await executeFile(process.execPath, ['consumer.mjs'], {
        cwd: fixtureDirectory,
        timeout: 10_000,
      });
      expect(stdout).toContain('root-ok');
      expect(stdout).toContain('function function');
    } finally {
      await rm(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it('creates the child environment without replacing existing Node options', () => {
    const environment = createInstrumentedEnvironment(
      { NODE_OPTIONS: '--no-warnings', EXAMPLE_VALUE: 'kept' },
      'http://127.0.0.1:7441',
    );

    expect(environment.NODE_OPTIONS).toContain('--no-warnings');
    expect(environment.NODE_OPTIONS).toContain(`--import=${getNodeFlowPreloadUrl()}`);
    expect(environment.NODEFLOW_COLLECTOR_URL).toBe('http://127.0.0.1:7441');
    expect(environment.EXAMPLE_VALUE).toBe('kept');
  });

  it('injects the preload into a command launched through node-flow dev', async () => {
    const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const childScript = [
      "console.log('CHILD_NODE_OPTIONS=' + process.env.NODE_OPTIONS)",
      "console.log('CHILD_COLLECTOR=' + process.env.NODEFLOW_COLLECTOR_URL)",
    ].join(';');
    const { stdout } = await executeFile(
      process.execPath,
      [cliPath, 'dev', '--', process.execPath, '-e', childScript],
      {
        env: {
          ...process.env,
          NODE_OPTIONS: '--no-warnings',
          NODEFLOW_PORT: '0',
          NODEFLOW_DASHBOARD_DIR: '/node-flow-test-dashboard-does-not-exist',
        },
        timeout: 10_000,
      },
    );

    expect(stdout).toContain('NodeFlow started');
    expect(stdout).toContain('CHILD_NODE_OPTIONS=--no-warnings --import=file:');
    expect(stdout).toMatch(/CHILD_COLLECTOR=http:\/\/127\.0\.0\.1:\d+/);
  }, 15_000);

  it('keeps mandatory instrumentation calls out of demo business code', async () => {
    const demoSource = await readFile(
      fileURLToPath(new URL('../../../apps/demo-nestjs/src/main.ts', import.meta.url)),
      'utf8',
    );

    expect(demoSource).not.toMatch(/traceServiceOperation|traceBoundary|nodeflow\.span/);
    expect(demoSource).toContain("from '@node-flow/node/nestjs'");
  });
});
