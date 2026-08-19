import {
  CallHandler,
  DynamicModule,
  ExecutionContext,
  Inject,
  Injectable,
  Module,
  type NestInterceptor,
} from '@nestjs/common';
import { APP_INTERCEPTOR, DiscoveryModule } from '@nestjs/core';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { catchError, defer, finalize, type Observable, throwError } from 'rxjs';
import { NodeScopeProviderExplorer } from './provider-explorer.js';
import {
  NODESCOPE_OPTIONS,
  resolveTracingOptions,
  type NodeScopeModuleOptions,
  type ResolvedNodeScopeTracingOptions,
} from './options.js';

@Injectable()
export class NodeScopeNestInterceptor implements NestInterceptor {
  constructor(
    @Inject(NODESCOPE_OPTIONS) private readonly options: ResolvedNodeScopeTracingOptions,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.options.controllers || context.getType() !== 'http') return next.handle();
    const controller = context.getClass().name;
    const method = context.getHandler().name;
    const tracer = trace.getTracer('nodescope.nestjs.controllers');

    return defer(() =>
      tracer.startActiveSpan(
        `${controller}.${method}`,
        {
          attributes: {
            'nodescope.kind': 'controller',
            'nodescope.framework': 'nestjs',
            'nodescope.class': controller,
            'nodescope.method': method,
            'nodescope.identity': `controller:${controller}`,
            'nodescope.min_duration_ms': this.options.minDurationMs,
          },
        },
        (span) => {
          let failed = false;
          return next.handle().pipe(
            catchError((error: unknown) => {
              failed = true;
              span.recordException(error instanceof Error ? error : new Error(String(error)));
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
              });
              return throwError(() => error);
            }),
            finalize(() => {
              if (!failed) span.setStatus({ code: SpanStatusCode.OK });
              span.end();
            }),
          );
        },
      ),
    );
  }
}

const defaultOptionsProvider = {
  provide: NODESCOPE_OPTIONS,
  useValue: resolveTracingOptions(),
};

@Module({
  imports: [DiscoveryModule],
  providers: [
    defaultOptionsProvider,
    NodeScopeProviderExplorer,
    { provide: APP_INTERCEPTOR, useClass: NodeScopeNestInterceptor },
  ],
})
export class NodeScopeModule {
  static forRoot(options: NodeScopeModuleOptions = {}): DynamicModule {
    return {
      module: NodeScopeModule,
      providers: [{ provide: NODESCOPE_OPTIONS, useValue: resolveTracingOptions(options) }],
    };
  }
}

export { shouldInstrumentProvider } from './filter.js';
export {
  instrumentProviderInstance,
  type InstanceInstrumentationResult,
} from './method-instrumentation.js';
export { NodeScopeProviderExplorer } from './provider-explorer.js';
export {
  resolveTracingOptions,
  type NodeScopeModuleOptions,
  type NodeScopeTracingOptions,
  type ResolvedNodeScopeTracingOptions,
} from './options.js';
