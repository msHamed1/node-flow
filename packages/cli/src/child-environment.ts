import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const registerUrl = pathToFileURL(
  require.resolve('@mshamed1/node-flow-instrumentation-node/register'),
).href;

export function createInstrumentedEnvironment(
  environment: NodeJS.ProcessEnv,
  collectorUrl: string,
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
  };
}

export function getNodeFlowPreloadUrl(): string {
  return registerUrl;
}
