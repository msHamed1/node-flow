import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const registerUrl = pathToFileURL(
  require.resolve('@mshamed1/node-flow-instrumentation-node/register'),
).href;

export function createInstrumentedEnvironment(
  environment: NodeJS.ProcessEnv,
  collectorUrl: string,
  options: { exportProtocol?: 'json' | 'protobuf'; runtimePid?: number } = {},
): NodeJS.ProcessEnv {
  const preloadOption = `--import=${registerUrl}`;
  const existingOptions = environment.NODE_OPTIONS?.trim();
  const nodeOptions = existingOptions?.includes(preloadOption)
    ? existingOptions
    : [existingOptions, preloadOption].filter(Boolean).join(' ');

  return {
    ...environment,
    NODE_OPTIONS: nodeOptions,
    NODEFLOW_COLLECTOR_URL: collectorUrl,
    ...(options.exportProtocol ? { NODEFLOW_EXPORT_PROTOCOL: options.exportProtocol } : {}),
    ...(options.runtimePid ? { NODEFLOW_RUNTIME_PID: String(options.runtimePid) } : {}),
  };
}

export function getNodeFlowPreloadUrl(): string {
  return registerUrl;
}
