export interface NodeFlowTracingOptions {
  /** Automatically instrument singleton application providers. */
  services?: boolean;
  /** Create one semantic span for each executed controller route handler. */
  controllers?: boolean;
  /** Provider class names that must never be instrumented. */
  excludeProviders?: string[];
  /** Hide faster provider/controller spans from topology and trace views. */
  minDurationMs?: number;
}

export interface NodeFlowModuleOptions {
  tracing?: NodeFlowTracingOptions;
}

export interface ResolvedNodeFlowTracingOptions {
  services: boolean;
  controllers: boolean;
  excludeProviders: ReadonlySet<string>;
  minDurationMs: number;
}

export const NODEFLOW_OPTIONS = Symbol('NODEFLOW_OPTIONS');

export function resolveTracingOptions(
  options: NodeFlowModuleOptions = {},
): ResolvedNodeFlowTracingOptions {
  return {
    services: options.tracing?.services ?? true,
    controllers: options.tracing?.controllers ?? true,
    excludeProviders: new Set(options.tracing?.excludeProviders ?? []),
    minDurationMs: Math.max(0, options.tracing?.minDurationMs ?? 0),
  };
}
