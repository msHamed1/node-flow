export interface NodeScopeTracingOptions {
  /** Automatically instrument singleton application providers. */
  services?: boolean;
  /** Create one semantic span for each executed controller route handler. */
  controllers?: boolean;
  /** Provider class names that must never be instrumented. */
  excludeProviders?: string[];
  /** Hide faster provider/controller spans from topology and trace views. */
  minDurationMs?: number;
}

export interface NodeScopeModuleOptions {
  tracing?: NodeScopeTracingOptions;
}

export interface ResolvedNodeScopeTracingOptions {
  services: boolean;
  controllers: boolean;
  excludeProviders: ReadonlySet<string>;
  minDurationMs: number;
}

export const NODESCOPE_OPTIONS = Symbol('NODESCOPE_OPTIONS');

export function resolveTracingOptions(
  options: NodeScopeModuleOptions = {},
): ResolvedNodeScopeTracingOptions {
  return {
    services: options.tracing?.services ?? true,
    controllers: options.tracing?.controllers ?? true,
    excludeProviders: new Set(options.tracing?.excludeProviders ?? []),
    minDurationMs: Math.max(0, options.tracing?.minDurationMs ?? 0),
  };
}
