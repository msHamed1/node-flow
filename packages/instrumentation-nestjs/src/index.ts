import { CallHandler, ExecutionContext, Injectable, Module, type NestInterceptor } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { catchError, defer, finalize, type Observable, throwError } from 'rxjs';

@Injectable()
export class NodeScopeNestInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const controller = context.getClass().name;
    const handler = context.getHandler().name;
    const tracer = trace.getTracer('nodescope.nestjs');

    return defer(() => tracer.startActiveSpan(controller, {
      attributes: {
        'nodescope.type': 'controller',
        'nodescope.identity': `controller:${controller}`,
        'nodescope.operation': handler,
      },
    }, (span) => next.handle().pipe(
      catchError((error: unknown) => {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        return throwError(() => error);
      }),
      finalize(() => span.end()),
    )));
  }
}

@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: NodeScopeNestInterceptor }],
})
export class NodeScopeModule {}
