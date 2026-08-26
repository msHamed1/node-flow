import { context, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { ExportResultCode, suppressTracing, type ExportResult } from '@opentelemetry/core';
import { AmqplibInstrumentation } from '@opentelemetry/instrumentation-amqplib';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { MongoDBInstrumentation } from '@opentelemetry/instrumentation-mongodb';
import { MongooseInstrumentation } from '@opentelemetry/instrumentation-mongoose';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { RedisInstrumentation } from '@opentelemetry/instrumentation-redis';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type {
  RuntimeMetrics,
  SpanBatch,
  TelemetrySpan,
  TelemetrySpanKind,
} from '@mshamed1/node-flow-protocol';

let runningSdk: NodeSDK | undefined;

export function startNodeFlowInstrumentation(): NodeSDK {
  if (runningSdk) return runningSdk;

  const collectorUrl = process.env.NODEFLOW_COLLECTOR_URL ?? 'http://127.0.0.1:7331';
  const serviceName =
    process.env.NODEFLOW_SERVICE_NAME ?? process.env.npm_package_name ?? 'node-application';
  const exporter = new LocalCollectorExporter(collectorUrl, serviceName);
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        scheduledDelayMillis: 250,
        maxExportBatchSize: 64,
        maxQueueSize: 512,
      }),
    ],
    instrumentations: createNodeFlowInstrumentations(collectorUrl),
  });
  sdk.start();
  runningSdk = sdk;
  startRuntimeMetrics(collectorUrl, serviceName);

  const shutdown = (): void => {
    void sdk.shutdown();
  };
  process.once('beforeExit', shutdown);
  return sdk;
}

export function createNodeFlowInstrumentations(collectorUrl: string) {
  const collectorHost = new URL(collectorUrl).host;
  return [
    new HttpInstrumentation({
      ignoreOutgoingRequestHook: (request) => {
        const host =
          typeof request === 'string' ? request : (request.hostname ?? request.host ?? '');
        const path = typeof request === 'string' ? request : (request.path ?? '');
        return `${host}${path}`.includes(collectorHost);
      },
    }),
    new ExpressInstrumentation(),
    new UndiciInstrumentation({
      ignoreRequestHook: (request) => new URL(request.origin).host === collectorHost,
    }),
    new MongoDBInstrumentation(),
    new MongooseInstrumentation(),
    new PgInstrumentation(),
    new RedisInstrumentation(),
    new AmqplibInstrumentation(),
  ];
}

class LocalCollectorExporter implements SpanExporter {
  constructor(
    private readonly collectorUrl: string,
    private readonly serviceName: string,
  ) {}

  export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    const batch: SpanBatch = {
      serviceName: this.serviceName,
      nodeVersion: process.version,
      spans: spans.map(normalizeSpan),
    };
    void context.with(suppressTracing(context.active()), async () => {
      try {
        const response = await fetch(`${this.collectorUrl}/api/spans`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(2_000),
        });
        callback({ code: response.ok ? ExportResultCode.SUCCESS : ExportResultCode.FAILED });
      } catch (error) {
        if (process.env.NODEFLOW_DEBUG === '1')
          console.error('[NodeFlow] telemetry export failed:', error);
        callback({
          code: ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function normalizeSpan(span: ReadableSpan): TelemetrySpan {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      attributes[key] = value;
  }
  const kind = resolveKind(span, attributes);
  const topologyName = resolveName(span, kind, attributes);
  const keepsOperationName =
    kind === 'database' || kind === 'redis' || kind === 'queue' || kind === 'external-http';
  const name = keepsOperationName ? span.name : topologyName;
  if (keepsOperationName) {
    attributes['nodeflow.topology_name'] = topologyName;
    attributes['nodeflow.operation'] ??= span.name;
  }
  attributes['nodeflow.identity'] ??= resolveIdentity(kind, topologyName, attributes);
  return {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    ...(span.parentSpanContext?.spanId ? { parentSpanId: span.parentSpanContext.spanId } : {}),
    name,
    kind,
    startTimeUnixMs: span.startTime[0] * 1_000 + span.startTime[1] / 1_000_000,
    durationMs: Math.round((span.duration[0] * 1_000 + span.duration[1] / 1_000_000) * 100) / 100,
    status: span.status.code === SpanStatusCode.ERROR ? 'error' : 'ok',
    attributes,
  };
}

function resolveKind(
  span: ReadableSpan,
  attributes: Record<string, string | number | boolean>,
): TelemetrySpanKind {
  const minimumDuration = attributes['nodeflow.min_duration_ms'];
  const durationMs = span.duration[0] * 1_000 + span.duration[1] / 1_000_000;
  if (typeof minimumDuration === 'number' && durationMs < minimumDuration) return 'internal';

  const explicit = attributes['nodeflow.kind'];
  if (typeof explicit === 'string') return explicit as TelemetrySpanKind;
  const dbSystem = attributes['db.system'] ?? attributes['db.system.name'];
  if (dbSystem === 'redis') return 'redis';
  if (typeof dbSystem === 'string') return 'database';
  if (typeof attributes['messaging.system'] === 'string') return 'queue';
  if (span.kind === SpanKind.SERVER && hasHttpAttributes(attributes)) return 'http-route';
  if (span.kind === SpanKind.CLIENT && hasHttpAttributes(attributes)) return 'external-http';
  return 'internal';
}

function resolveName(
  span: ReadableSpan,
  kind: TelemetrySpanKind,
  attributes: Record<string, string | number | boolean>,
): string {
  if (kind === 'http-route') {
    const method = String(
      attributes['http.request.method'] ?? attributes['http.method'] ?? '',
    ).toUpperCase();
    const route = String(
      attributes['http.route'] ?? attributes['url.path'] ?? span.name.replace(/^\w+\s+/, ''),
    );
    return `${method} ${route}`.trim();
  }
  if (kind === 'external-http') {
    const host =
      attributes['server.address'] ?? attributes['net.peer.name'] ?? attributes['http.host'];
    return host ? String(host) : span.name;
  }
  if (kind === 'database' || kind === 'redis') {
    const system = String(
      attributes['db.system'] ??
        attributes['db.system.name'] ??
        (kind === 'redis' ? 'Redis' : 'Database'),
    );
    return titleCase(system);
  }
  if (kind === 'queue') {
    const system = String(attributes['messaging.system'] ?? 'Messaging');
    if (system === 'rabbitmq' || system === 'amqp' || system === 'amqplib') return 'RabbitMQ';
    return titleCase(system);
  }
  return span.name;
}

function resolveIdentity(
  kind: TelemetrySpanKind,
  name: string,
  attributes: Record<string, string | number | boolean>,
): string {
  if (kind === 'database' || kind === 'redis' || kind === 'queue') return `${kind}:${name}`;
  return `${kind}:${name}`;
}

function hasHttpAttributes(attributes: Record<string, string | number | boolean>): boolean {
  return (
    'http.request.method' in attributes ||
    'http.method' in attributes ||
    'url.full' in attributes ||
    'http.url' in attributes
  );
}

function titleCase(value: string): string {
  if (value === 'postgresql' || value === 'postgres') return 'PostgreSQL';
  // The Mongoose and MongoDB instrumentations both describe the same
  // architectural dependency. Keep their operation names in trace detail,
  // but aggregate both layers under one MongoDB topology identity.
  if (value === 'mongodb' || value === 'mongoose') return 'MongoDB';
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

function startRuntimeMetrics(collectorUrl: string, serviceName: string): void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let previousCpu = process.cpuUsage();
  let previousTime = performance.now();
  let previousElu = performance.eventLoopUtilization();

  const timer = setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage(previousCpu);
    previousCpu = process.cpuUsage();
    const elapsedMicros = Math.max(1, (now - previousTime) * 1_000);
    previousTime = now;
    const elu = performance.eventLoopUtilization(previousElu);
    previousElu = performance.eventLoopUtilization();
    const memory = process.memoryUsage();
    const metrics: RuntimeMetrics = {
      timestamp: Date.now(),
      serviceName,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      cpuPercent: Math.round(((cpu.user + cpu.system) / elapsedMicros) * 10_000) / 100,
      eventLoopUtilization: Math.round(elu.utilization * 10_000) / 100,
      uptimeSeconds: Math.round(process.uptime()),
    };
    void context.with(suppressTracing(context.active()), () =>
      fetch(`${collectorUrl}/api/runtime`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(metrics),
        signal: AbortSignal.timeout(2_000),
      }).catch(() => undefined),
    );
    histogram.reset();
  }, 2_000);
  timer.unref();
}
