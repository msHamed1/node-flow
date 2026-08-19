import { Scope } from '@nestjs/common';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lastValueFrom, of } from 'rxjs';
import { shouldInstrumentProvider } from './filter.js';
import { instrumentProviderInstance } from './method-instrumentation.js';
import { resolveTracingOptions } from './options.js';
import { NodeFlowProviderExplorer } from './provider-explorer.js';
import { NodeFlowNestInterceptor } from './index.js';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let contextManager: AsyncLocalStorageContextManager;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await provider.shutdown();
  exporter.reset();
  trace.disable();
  context.disable();
  contextManager.disable();
});

describe('automatic NestJS provider instrumentation', () => {
  it('discovers and instruments an application provider at bootstrap', async () => {
    class PaymentsService {
      async processPayment(): Promise<string> {
        return 'processed';
      }
    }

    const service = new PaymentsService();
    const discoveryService = {
      getControllers: vi.fn(() => []),
      getProviders: vi.fn(() => [providerWrapper(service, PaymentsService)]),
    };
    const explorer = new NodeFlowProviderExplorer(
      discoveryService as never,
      resolveTracingOptions(),
    );

    explorer.onApplicationBootstrap();
    await expect(service.processPayment()).resolves.toBe('processed');

    expect(discoveryService.getControllers).toHaveBeenCalledOnce();
    expect(explorer.getInstrumentationResults()).toEqual([
      { className: 'PaymentsService', methods: ['processPayment'] },
    ]);
    expect(finishedSpans()).toHaveLength(1);
    expect(finishedSpans()[0]).toMatchObject({
      name: 'PaymentsService.processPayment',
      attributes: {
        'nodeflow.kind': 'service',
        'nodeflow.framework': 'nestjs',
        'nodeflow.class': 'PaymentsService',
        'nodeflow.method': 'processPayment',
      },
    });
  });

  it('preserves parent and child context across nested async providers', async () => {
    class WalletService {
      async withdraw(): Promise<number> {
        await Promise.resolve();
        return 25;
      }
    }
    class PaymentsService {
      constructor(private readonly walletService: WalletService) {}

      async processPayment(): Promise<number> {
        return this.walletService.withdraw();
      }
    }

    const wallet = new WalletService();
    const payments = new PaymentsService(wallet);
    instrumentProviderInstance(wallet, 'WalletService', resolveTracingOptions());
    instrumentProviderInstance(payments, 'PaymentsService', resolveTracingOptions());

    await expect(payments.processPayment()).resolves.toBe(25);
    const spans = finishedSpans();
    const parent = spanNamed(spans, 'PaymentsService.processPayment');
    const child = spanNamed(spans, 'WalletService.withdraw');
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
  });

  it('records an error, ends the span, and rethrows the original value', async () => {
    const failure = new Error('payment failed');
    class PaymentsService {
      async processPayment(): Promise<never> {
        await Promise.resolve();
        throw failure;
      }
    }

    const service = new PaymentsService();
    instrumentProviderInstance(service, 'PaymentsService', resolveTracingOptions());

    await expect(service.processPayment()).rejects.toBe(failure);
    const recorded = spanNamed(finishedSpans(), 'PaymentsService.processPayment');
    expect(recorded.status).toMatchObject({
      code: SpanStatusCode.ERROR,
      message: 'payment failed',
    });
    expect(recorded.events.some((event) => event.name === 'exception')).toBe(true);
  });

  it('does not convert a synchronous method into a promise', () => {
    class FeeService {
      private readonly rate = 0.02;

      calculateFee(amount: number): number {
        return amount * this.rate;
      }
    }

    const service = new FeeService();
    instrumentProviderInstance(service, 'FeeService', resolveTracingOptions());
    const result = service.calculateFee(500);

    expect(result).toBe(10);
    expect(result).not.toBeInstanceOf(Promise);
    expect(spanNamed(finishedSpans(), 'FeeService.calculateFee').status.code).toBe(
      SpanStatusCode.OK,
    );
  });

  it('does not wrap an instance more than once', () => {
    class PaymentsService {
      processPayment(): string {
        return 'ok';
      }
    }

    const service = new PaymentsService();
    const options = resolveTracingOptions();
    expect(instrumentProviderInstance(service, 'PaymentsService', options).methods).toEqual([
      'processPayment',
    ]);
    expect(instrumentProviderInstance(service, 'PaymentsService', options).methods).toEqual([]);

    expect(service.processPayment()).toBe('ok');
    expect(
      finishedSpans().filter((span) => span.name === 'PaymentsService.processPayment'),
    ).toHaveLength(1);
  });

  it('excludes framework, configured, request-scoped, and transient providers', () => {
    class Logger {
      log(): void {}
    }
    class ConfigService {
      get(): void {}
    }
    class InternalPaymentAdapter {
      run(): void {}
    }
    class RequestService {
      run(): void {}
    }

    const options = resolveTracingOptions({
      tracing: { excludeProviders: ['InternalPaymentAdapter'] },
    });
    expect(shouldInstrumentProvider(providerWrapper(new Logger(), Logger), options)).toBe(false);
    expect(
      shouldInstrumentProvider(providerWrapper(new ConfigService(), ConfigService), options),
    ).toBe(false);
    expect(
      shouldInstrumentProvider(
        providerWrapper(new InternalPaymentAdapter(), InternalPaymentAdapter),
        options,
      ),
    ).toBe(false);
    expect(
      shouldInstrumentProvider(
        { ...providerWrapper(new RequestService(), RequestService), scope: Scope.REQUEST },
        options,
      ),
    ).toBe(false);
    expect(
      shouldInstrumentProvider(
        { ...providerWrapper(new RequestService(), RequestService), scope: Scope.TRANSIENT },
        options,
      ),
    ).toBe(false);
  });

  it('skips lifecycle hooks, getters, setters, and instance arrow functions', () => {
    let getterReads = 0;
    class PaymentsService {
      readonly arrowOperation = (): string => 'arrow';

      get derivedValue(): number {
        getterReads += 1;
        return 1;
      }

      set derivedValue(_value: number) {}

      onModuleInit(): void {}

      processPayment(): string {
        return 'ok';
      }
    }

    const service = new PaymentsService();
    const result = instrumentProviderInstance(service, 'PaymentsService', resolveTracingOptions());
    expect(result.methods).toEqual(['processPayment']);
    expect(getterReads).toBe(0);
    expect(service.arrowOperation()).toBe('arrow');
    expect(service.processPayment()).toBe('ok');
    expect(finishedSpans().map((span) => span.name)).toEqual(['PaymentsService.processPayment']);
  });

  it('creates one semantic controller span without wrapping the route handler', async () => {
    class PaymentsController {
      create(): string {
        return 'created';
      }
    }

    const interceptor = new NodeFlowNestInterceptor(resolveTracingOptions());
    const executionContext = {
      getType: () => 'http',
      getClass: () => PaymentsController,
      getHandler: () => PaymentsController.prototype.create,
    };
    await expect(
      lastValueFrom(
        interceptor.intercept(executionContext as never, { handle: () => of('created') }),
      ),
    ).resolves.toBe('created');

    expect(finishedSpans()).toHaveLength(1);
    expect(finishedSpans()[0]).toMatchObject({
      name: 'PaymentsController.create',
      attributes: {
        'nodeflow.kind': 'controller',
        'nodeflow.class': 'PaymentsController',
        'nodeflow.method': 'create',
      },
    });
  });
});

function providerWrapper(instance: object, metatype: Function) {
  return {
    instance,
    metatype,
    name: metatype.name,
    scope: Scope.DEFAULT,
    isAlias: false,
    isDependencyTreeStatic: () => true,
  };
}

function finishedSpans(): ReadableSpan[] {
  return exporter.getFinishedSpans();
}

function spanNamed(spans: ReadableSpan[], name: string): ReadableSpan {
  const found = spans.find((span) => span.name === name);
  if (!found) throw new Error(`Missing span: ${name}`);
  return found;
}
