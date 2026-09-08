export const repositoryUrl = 'git+https://github.com/msHamed1/node-flow.git';

export const publishedPackages = [
  { directory: 'packages/protocol', name: '@mshamed1/node-flow-protocol' },
  { directory: 'packages/topology-engine', name: '@mshamed1/node-flow-topology-engine' },
  { directory: 'packages/core', name: '@mshamed1/node-flow-core' },
  { directory: 'packages/instrumentation-node', name: '@mshamed1/node-flow-instrumentation-node' },
  {
    directory: 'packages/instrumentation-nestjs',
    name: '@mshamed1/node-flow-instrumentation-nestjs',
  },
  { directory: 'apps/collector', name: '@mshamed1/node-flow-collector' },
  {
    directory: 'packages/collector-darwin-arm64',
    name: '@mshamed1/node-flow-collector-darwin-arm64',
    runtimeTarget: 'darwin-arm64',
  },
  {
    directory: 'packages/collector-darwin-x64',
    name: '@mshamed1/node-flow-collector-darwin-x64',
    runtimeTarget: 'darwin-x64',
  },
  {
    directory: 'packages/collector-linux-arm64',
    name: '@mshamed1/node-flow-collector-linux-arm64',
    runtimeTarget: 'linux-arm64',
  },
  {
    directory: 'packages/collector-linux-x64',
    name: '@mshamed1/node-flow-collector-linux-x64',
    runtimeTarget: 'linux-x64',
  },
  {
    directory: 'packages/collector-win32-x64',
    name: '@mshamed1/node-flow-collector-win32-x64',
    runtimeTarget: 'win32-x64',
  },
  { directory: 'packages/cli', name: '@mshamed1/node-flow' },
];
