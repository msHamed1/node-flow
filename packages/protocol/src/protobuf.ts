import protobuf from 'protobufjs/minimal.js';
import {
  NODEFLOW_PROTOCOL_VERSION,
  type RuntimeMetrics,
  type SpanBatch,
  type TelemetryEnvelope,
  type TelemetrySpan,
  type TelemetrySpanKind,
} from './index.js';

const { Reader, Writer } = protobuf;

const kindToWire: Record<TelemetrySpanKind, number> = {
  'http-route': 1,
  controller: 2,
  service: 3,
  database: 4,
  redis: 5,
  queue: 6,
  worker: 7,
  'external-http': 8,
  custom: 9,
  internal: 10,
};

const wireToKind = new Map<number, TelemetrySpanKind>(
  Object.entries(kindToWire).map(([kind, wire]) => [wire, kind as TelemetrySpanKind]),
);

export function encodeTelemetryEnvelope(envelope: TelemetryEnvelope): Uint8Array {
  const writer = Writer.create();
  writer.uint32(10).string(envelope.protocolVersion);
  if (envelope.spanBatch) {
    encodeSpanBatch(envelope.spanBatch, writer.uint32(18).fork()).ldelim();
  } else {
    encodeRuntimeMetrics(envelope.runtimeMetrics, writer.uint32(26).fork()).ldelim();
  }
  return writer.finish();
}

export function decodeTelemetryEnvelope(input: Uint8Array): TelemetryEnvelope {
  const reader = Reader.create(input);
  let protocolVersion = '';
  let spanBatch: SpanBatch | undefined;
  let runtimeMetrics: RuntimeMetrics | undefined;
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        protocolVersion = reader.string();
        break;
      case 2:
        spanBatch = decodeSpanBatch(reader, reader.uint32());
        break;
      case 3:
        runtimeMetrics = decodeRuntimeMetrics(reader, reader.uint32());
        break;
      default:
        reader.skipType(tag & 7);
    }
  }
  if (protocolVersion !== NODEFLOW_PROTOCOL_VERSION) {
    throw new Error(`Unsupported NodeFlow protocol version: ${protocolVersion || '<missing>'}`);
  }
  if ((spanBatch ? 1 : 0) + (runtimeMetrics ? 1 : 0) !== 1) {
    throw new Error('A telemetry envelope must contain exactly one payload.');
  }
  return spanBatch
    ? { protocolVersion: NODEFLOW_PROTOCOL_VERSION, spanBatch }
    : { protocolVersion: NODEFLOW_PROTOCOL_VERSION, runtimeMetrics: runtimeMetrics! };
}

function encodeSpanBatch(batch: SpanBatch, writer: protobuf.Writer): protobuf.Writer {
  if (batch.serviceName) writer.uint32(10).string(batch.serviceName);
  if (batch.nodeVersion) writer.uint32(18).string(batch.nodeVersion);
  for (const span of batch.spans) encodeSpan(span, writer.uint32(26).fork()).ldelim();
  return writer;
}

function encodeSpan(span: TelemetrySpan, writer: protobuf.Writer): protobuf.Writer {
  if (span.traceId) writer.uint32(10).string(span.traceId);
  if (span.spanId) writer.uint32(18).string(span.spanId);
  if (span.parentSpanId) writer.uint32(26).string(span.parentSpanId);
  if (span.name) writer.uint32(34).string(span.name);
  writer.uint32(40).int32(kindToWire[span.kind]);
  writer.uint32(49).double(span.startTimeUnixMs);
  writer.uint32(57).double(span.durationMs);
  writer.uint32(64).int32(span.status === 'error' ? 2 : 1);
  for (const [key, value] of Object.entries(span.attributes ?? {})) {
    const entry = writer.uint32(74).fork();
    entry.uint32(10).string(key);
    const attribute = entry.uint32(18).fork();
    if (typeof value === 'string') attribute.uint32(10).string(value);
    else if (typeof value === 'number') attribute.uint32(17).double(value);
    else attribute.uint32(24).bool(value);
    attribute.ldelim();
    entry.ldelim();
  }
  return writer;
}

function encodeRuntimeMetrics(metrics: RuntimeMetrics, writer: protobuf.Writer): protobuf.Writer {
  writer.uint32(9).double(metrics.timestamp);
  if (metrics.serviceName) writer.uint32(18).string(metrics.serviceName);
  writer.uint32(24).uint64(metrics.rssBytes);
  writer.uint32(32).uint64(metrics.heapUsedBytes);
  writer.uint32(40).uint64(metrics.heapTotalBytes);
  writer.uint32(49).double(metrics.cpuPercent);
  writer.uint32(57).double(metrics.eventLoopUtilization);
  writer.uint32(65).double(metrics.uptimeSeconds);
  return writer;
}

function decodeSpanBatch(reader: protobuf.Reader, length: number): SpanBatch {
  const end = reader.pos + length;
  let serviceName = '';
  let nodeVersion: string | undefined;
  const spans: TelemetrySpan[] = [];
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        serviceName = reader.string();
        break;
      case 2:
        nodeVersion = reader.string();
        break;
      case 3:
        spans.push(decodeSpan(reader, reader.uint32()));
        break;
      default:
        reader.skipType(tag & 7);
    }
  }
  return { serviceName, ...(nodeVersion ? { nodeVersion } : {}), spans };
}

function decodeSpan(reader: protobuf.Reader, length: number): TelemetrySpan {
  const end = reader.pos + length;
  let traceId = '';
  let spanId = '';
  let parentSpanId: string | undefined;
  let name = '';
  let kind: TelemetrySpanKind = 'internal';
  let startTimeUnixMs = 0;
  let durationMs = 0;
  let status: TelemetrySpan['status'] = 'ok';
  const attributes: NonNullable<TelemetrySpan['attributes']> = {};
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        traceId = reader.string();
        break;
      case 2:
        spanId = reader.string();
        break;
      case 3:
        parentSpanId = reader.string();
        break;
      case 4:
        name = reader.string();
        break;
      case 5:
        kind = wireToKind.get(reader.int32()) ?? 'internal';
        break;
      case 6:
        startTimeUnixMs = reader.double();
        break;
      case 7:
        durationMs = reader.double();
        break;
      case 8:
        status = reader.int32() === 2 ? 'error' : 'ok';
        break;
      case 9: {
        const [key, value] = decodeAttributeEntry(reader, reader.uint32());
        if (key && value !== undefined) attributes[key] = value;
        break;
      }
      default:
        reader.skipType(tag & 7);
    }
  }
  return {
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name,
    kind,
    startTimeUnixMs,
    durationMs,
    status,
    ...(Object.keys(attributes).length ? { attributes } : {}),
  };
}

function decodeAttributeEntry(
  reader: protobuf.Reader,
  length: number,
): [string, string | number | boolean | undefined] {
  const end = reader.pos + length;
  let key = '';
  let value: string | number | boolean | undefined;
  while (reader.pos < end) {
    const tag = reader.uint32();
    if (tag >>> 3 === 1) key = reader.string();
    else if (tag >>> 3 === 2) value = decodeAttribute(reader, reader.uint32());
    else reader.skipType(tag & 7);
  }
  return [key, value];
}

function decodeAttribute(
  reader: protobuf.Reader,
  length: number,
): string | number | boolean | undefined {
  const end = reader.pos + length;
  let value: string | number | boolean | undefined;
  while (reader.pos < end) {
    const tag = reader.uint32();
    if (tag >>> 3 === 1) value = reader.string();
    else if (tag >>> 3 === 2) value = reader.double();
    else if (tag >>> 3 === 3) value = reader.bool();
    else reader.skipType(tag & 7);
  }
  return value;
}

function decodeRuntimeMetrics(reader: protobuf.Reader, length: number): RuntimeMetrics {
  const end = reader.pos + length;
  const metrics: RuntimeMetrics = {
    timestamp: 0,
    serviceName: '',
    rssBytes: 0,
    heapUsedBytes: 0,
    heapTotalBytes: 0,
    cpuPercent: 0,
    eventLoopUtilization: 0,
    uptimeSeconds: 0,
  };
  while (reader.pos < end) {
    const tag = reader.uint32();
    switch (tag >>> 3) {
      case 1:
        metrics.timestamp = reader.double();
        break;
      case 2:
        metrics.serviceName = reader.string();
        break;
      case 3:
        metrics.rssBytes = Number(reader.uint64().toString());
        break;
      case 4:
        metrics.heapUsedBytes = Number(reader.uint64().toString());
        break;
      case 5:
        metrics.heapTotalBytes = Number(reader.uint64().toString());
        break;
      case 6:
        metrics.cpuPercent = reader.double();
        break;
      case 7:
        metrics.eventLoopUtilization = reader.double();
        break;
      case 8:
        metrics.uptimeSeconds = reader.double();
        break;
      default:
        reader.skipType(tag & 7);
    }
  }
  return metrics;
}
