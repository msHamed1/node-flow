export const runtimeProtocolVersion = 1;

export const runtimePackages = [
  runtime('darwin', 'arm64'),
  runtime('darwin', 'x64'),
  runtime('linux', 'arm64'),
  runtime('linux', 'x64'),
  runtime('win32', 'x64'),
];

export function runtimePackageFor(platform, architecture) {
  return runtimePackages.find(
    (candidate) => candidate.platform === platform && candidate.architecture === architecture,
  );
}

function runtime(platform, architecture) {
  const target = `${platform}-${architecture}`;
  return {
    platform,
    architecture,
    target,
    goos: platform === 'win32' ? 'windows' : platform,
    goarch: architecture === 'x64' ? 'amd64' : architecture,
    directory: `packages/collector-${target}`,
    packageName: `@mshamed1/node-flow-collector-${target}`,
    binaryName: platform === 'win32' ? 'nodeflow-collector.exe' : 'nodeflow-collector',
  };
}
