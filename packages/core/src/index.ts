import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import type { TopologyNodeType } from '@nodescope/protocol';

export interface BoundaryOptions {
  type: TopologyNodeType;
  name: string;
  operation?: string;
  identity?: string;
  attributes?: Attributes;
}

const tracer = trace.getTracer('nodescope.boundaries');

/** Instrument an architectural boundary that auto-instrumentation cannot see. */
export async function traceBoundary<T>(options: BoundaryOptions, work: () => Promise<T> | T): Promise<T> {
  return tracer.startActiveSpan(options.name, {
    attributes: {
      'nodescope.type': options.type,
      'nodescope.identity': options.identity ?? `${options.type}:${options.name}`,
      ...(options.operation ? { 'nodescope.operation': options.operation } : {}),
      ...options.attributes,
    },
  }, async (span) => {
    try {
      const result = await work();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}

export function traceServiceOperation<T>(serviceName: string, work: () => Promise<T> | T): Promise<T> {
  return traceBoundary({ type: 'service', name: serviceName, identity: `service:${serviceName}` }, work);
}
