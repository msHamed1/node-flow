export const repositoryUrl = 'git+https://github.com/msHamed1/node-flow.git';

export const publishedPackages = [
  { directory: 'protocol', name: '@mshamed1/node-flow-protocol' },
  { directory: 'reference/topology', name: '@mshamed1/node-flow-topology-engine' },
  { directory: 'sdk/core', name: '@mshamed1/node-flow-core' },
  { directory: 'sdk/node', name: '@mshamed1/node-flow-instrumentation-node' },
  {
    directory: 'sdk/nestjs',
    name: '@mshamed1/node-flow-instrumentation-nestjs',
  },
  { directory: 'reference/collector', name: '@mshamed1/node-flow-collector' },
  {
    directory: 'runtime/npm/darwin-arm64',
    name: '@mshamed1/node-flow-collector-darwin-arm64',
    runtimeTarget: 'darwin-arm64',
  },
  {
    directory: 'runtime/npm/darwin-x64',
    name: '@mshamed1/node-flow-collector-darwin-x64',
    runtimeTarget: 'darwin-x64',
  },
  {
    directory: 'runtime/npm/linux-arm64',
    name: '@mshamed1/node-flow-collector-linux-arm64',
    runtimeTarget: 'linux-arm64',
  },
  {
    directory: 'runtime/npm/linux-x64',
    name: '@mshamed1/node-flow-collector-linux-x64',
    runtimeTarget: 'linux-x64',
  },
  {
    directory: 'runtime/npm/win32-x64',
    name: '@mshamed1/node-flow-collector-win32-x64',
    runtimeTarget: 'win32-x64',
  },
  { directory: 'cli', name: '@mshamed1/node-flow' },
];
