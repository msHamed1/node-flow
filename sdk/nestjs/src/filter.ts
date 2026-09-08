import { Scope } from '@nestjs/common';
import type { ResolvedNodeFlowTracingOptions } from './options.js';

export interface DiscoverableProvider {
  instance?: unknown;
  metatype?: Function | null;
  name?: string;
  scope?: Scope;
  isAlias?: boolean;
  subtype?: string;
  isDependencyTreeStatic?: () => boolean;
}

const internalProviderNames = new Set([
  'ApplicationConfig',
  'ConfigService',
  'DiscoveryService',
  'EventSubscribersLoader',
  'ExternalContextCreator',
  'GraphInspector',
  'HttpAdapterHost',
  'Injector',
  'InstanceLoader',
  'LazyModuleLoader',
  'Logger',
  'MetadataScanner',
  'ModuleRef',
  'ModulesContainer',
  'NestApplication',
  'NestApplicationContext',
  'Reflector',
  'RouterExplorer',
  'RoutesResolver',
  'SerializedGraph',
  'useFactory',
]);

const internalProviderSuffixes = ['ExceptionFilter', 'Guard', 'Interceptor', 'Middleware', 'Pipe'];

export function shouldInstrumentProvider(
  wrapper: DiscoverableProvider,
  options: ResolvedNodeFlowTracingOptions,
): wrapper is DiscoverableProvider & { instance: object; metatype: Function } {
  if (!options.services || wrapper.isAlias || wrapper.subtype) return false;
  if (!wrapper.instance || typeof wrapper.instance !== 'object') return false;
  if (typeof wrapper.metatype !== 'function') return false;
  if (wrapper.scope === Scope.REQUEST || wrapper.scope === Scope.TRANSIENT) return false;

  try {
    if (wrapper.isDependencyTreeStatic && !wrapper.isDependencyTreeStatic()) return false;
  } catch {
    return false;
  }

  const className = wrapper.metatype.name || wrapper.name || wrapper.instance.constructor.name;
  if (!className || className === 'Object') return false;
  if (className.startsWith('NodeFlow')) return false;
  if (options.excludeProviders.has(className) || internalProviderNames.has(className)) return false;
  if (internalProviderSuffixes.some((suffix) => className.endsWith(suffix))) return false;

  const source = Function.prototype.toString.call(wrapper.metatype);
  return !source.includes('[native code]');
}

export function isLifecycleMethod(methodName: string): boolean {
  return lifecycleMethods.has(methodName);
}

const lifecycleMethods = new Set([
  'constructor',
  'onModuleInit',
  'onApplicationBootstrap',
  'onModuleDestroy',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
]);
