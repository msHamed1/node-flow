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
import { NodeFlowProviderExplorer } from './provider-explorer.js';
import {
  NODEFLOW_OPTIONS,
  resolveTracingOptions,
  type NodeFlowModuleOptions,
  type ResolvedNodeFlowTracingOptions,
} from './options.js';

@Injectable()
export class NodeFlowNestInterceptor implements NestInterceptor {
  constructor(@Inject(NODEFLOW_OPTIONS) private readonly options: ResolvedNodeFlowTracingOptions) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.options.controllers || context.getType() !== 'http') return next.handle();
    const controller = context.getClass().name;
    const method = context.getHandler().name;
    const tracer = trace.getTracer('nodeflow.nestjs.controllers');

    return defer(() =>
      tracer.startActiveSpan(
        `${controller}.${method}`,
        {
          attributes: {
            'nodeflow.kind': 'controller',
            'nodeflow.framework': 'nestjs',
            'nodeflow.class': controller,
            'nodeflow.method': method,
            'nodeflow.identity': `controller:${controller}`,
            'nodeflow.min_duration_ms': this.options.minDurationMs,
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
  provide: NODEFLOW_OPTIONS,
  useValue: resolveTracingOptions(),
};

@Module({
  imports: [DiscoveryModule],
  providers: [
    defaultOptionsProvider,
    NodeFlowProviderExplorer,
    { provide: APP_INTERCEPTOR, useClass: NodeFlowNestInterceptor },
  ],
})
export class NodeFlowModule {
  static forRoot(options: NodeFlowModuleOptions = {}): DynamicModule {
    return {
      module: NodeFlowModule,
      providers: [{ provide: NODEFLOW_OPTIONS, useValue: resolveTracingOptions(options) }],
    };
  }
}

export { shouldInstrumentProvider } from './filter.js';
export {
  instrumentProviderInstance,
  type InstanceInstrumentationResult,
} from './method-instrumentation.js';
export { NodeFlowProviderExplorer } from './provider-explorer.js';
export {
  resolveTracingOptions,
  type NodeFlowModuleOptions,
  type NodeFlowTracingOptions,
  type ResolvedNodeFlowTracingOptions,
} from './options.js';
