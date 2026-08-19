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
  { directory: 'packages/cli', name: '@mshamed1/node-flow' },
];
