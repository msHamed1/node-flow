import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import { isLifecycleMethod } from './filter.js';
import type { ResolvedNodeFlowTracingOptions } from './options.js';

const wrappedMethod = Symbol.for('nodeflow.nestjs.wrapped-method');
const instrumentedInstances = new WeakSet<object>();

type InstrumentedFunction = ((...args: unknown[]) => unknown) & {
  [wrappedMethod]?: boolean;
};

export interface InstanceInstrumentationResult {
  className: string;
  methods: string[];
}

export function instrumentProviderInstance(
  instance: object,
  className: string,
  options: ResolvedNodeFlowTracingOptions,
): InstanceInstrumentationResult {
  if (instrumentedInstances.has(instance)) return { className, methods: [] };

  const prototype = Object.getPrototypeOf(instance) as object | null;
  if (!prototype || prototype === Object.prototype) return { className, methods: [] };

  const methods: string[] = [];
  for (const methodName of Object.getOwnPropertyNames(prototype)) {
    if (isLifecycleMethod(methodName)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, methodName);
    if (!descriptor || descriptor.get || descriptor.set || typeof descriptor.value !== 'function')
      continue;

    const original = descriptor.value as InstrumentedFunction;
    if (original[wrappedMethod]) continue;
    const instrumented = createInstrumentedMethod(original, className, methodName, options);
    const installed = Reflect.defineProperty(instance, methodName, {
      configurable: true,
      enumerable: descriptor.enumerable ?? false,
      writable: true,
      value: instrumented,
    });
    if (installed) methods.push(methodName);
  }

  instrumentedInstances.add(instance);
  return { className, methods };
}

function createInstrumentedMethod(
  original: InstrumentedFunction,
  className: string,
  methodName: string,
  options: ResolvedNodeFlowTracingOptions,
): InstrumentedFunction {
  const tracer = trace.getTracer('nodeflow.nestjs.providers');
  const instrumented: InstrumentedFunction = function (this: unknown, ...args: unknown[]): unknown {
    return tracer.startActiveSpan(
      `${className}.${methodName}`,
      {
        attributes: {
          'nodeflow.kind': 'service',
          'nodeflow.framework': 'nestjs',
          'nodeflow.class': className,
          'nodeflow.method': methodName,
          'nodeflow.identity': `service:${className}`,
          'nodeflow.min_duration_ms': options.minDurationMs,
        },
      },
      (span) => executeWithSpan(original, this, args, span),
    );
  };

  Object.defineProperty(instrumented, wrappedMethod, { value: true });
  preserveFunctionMetadata(instrumented, original);
  return instrumented;
}

function executeWithSpan(
  original: InstrumentedFunction,
  receiver: unknown,
  args: unknown[],
  span: Span,
): unknown {
  let ended = false;
  const finish = (): void => {
    if (ended) return;
    ended = true;
    finishSpan(span);
  };
  const fail = (error: unknown): void => {
    if (ended) return;
    ended = true;
    failSpan(span, error);
  };

  try {
    const result = original.apply(receiver, args);
    if (isPromiseLike(result)) {
      return result.then(
        (value) => {
          finish();
          return value;
        },
        (error: unknown) => {
          fail(error);
          throw error;
        },
      );
    }
    finish();
    return result;
  } catch (error) {
    fail(error);
    throw error;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === 'function'
  );
}

function finishSpan(span: Span): void {
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

function failSpan(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
  span.end();
}

function preserveFunctionMetadata(target: Function, source: Function): void {
  try {
    Object.defineProperty(target, 'name', { configurable: true, value: source.name });
    Object.defineProperty(target, 'length', { configurable: true, value: source.length });
  } catch {
    // Function metadata is diagnostic only and must never block instrumentation.
  }
}
