import { describe, expect, it } from 'vitest';
import {
  decodeTelemetryEnvelope,
  encodeTelemetryEnvelope,
  NODEFLOW_PROTOCOL_VERSION,
  type TelemetryEnvelope,
} from '../src/index.js';

describe('nodeflow.v1 protobuf telemetry', () => {
  it('round-trips span batches without losing scalar metadata', () => {
    const envelope: TelemetryEnvelope = {
      protocolVersion: NODEFLOW_PROTOCOL_VERSION,
      spanBatch: {
        serviceName: 'payments-api',
        nodeVersion: 'v22.18.0',
        spans: [
          {
            traceId: 'trace-1',
            spanId: 'span-1',
            name: 'POST /payments',
            kind: 'http-route',
            startTimeUnixMs: 1_700_000_000_000.25,
            durationMs: 12.5,
            status: 'ok',
            attributes: {
              'http.route': '/payments',
              'nodeflow.sampled': true,
              'nodeflow.sequence': 3,
            },
          },
        ],
      },
    };

    expect(decodeTelemetryEnvelope(encodeTelemetryEnvelope(envelope))).toEqual(envelope);
  });

  it('round-trips runtime metrics', () => {
    const envelope: TelemetryEnvelope = {
      protocolVersion: NODEFLOW_PROTOCOL_VERSION,
      runtimeMetrics: {
        timestamp: 1_700_000_000_000,
        serviceName: 'payments-api',
        rssBytes: 128_000_000,
        heapUsedBytes: 64_000_000,
        heapTotalBytes: 96_000_000,
        cpuPercent: 24.5,
        eventLoopUtilization: 11.25,
        uptimeSeconds: 60,
      },
    };

    expect(decodeTelemetryEnvelope(encodeTelemetryEnvelope(envelope))).toEqual(envelope);
  });

  it('rejects missing or unsupported protocol versions', () => {
    expect(() => decodeTelemetryEnvelope(Uint8Array.of())).toThrow(
      'Unsupported NodeFlow protocol version',
    );
  });
});
