import { describe, expect, it } from 'vitest';
import { createNodeFlowInstrumentations } from '../src/instrumentation.js';

describe('NodeFlow Node instrumentation', () => {
  it('registers only the explicitly supported instrumentation set', () => {
    const names = createNodeFlowInstrumentations('http://127.0.0.1:7331')
      .map((instrumentation) => instrumentation.instrumentationName)
      .sort();

    expect(names).toEqual([
      '@opentelemetry/instrumentation-amqplib',
      '@opentelemetry/instrumentation-express',
      '@opentelemetry/instrumentation-http',
      '@opentelemetry/instrumentation-mongodb',
      '@opentelemetry/instrumentation-mongoose',
      '@opentelemetry/instrumentation-pg',
      '@opentelemetry/instrumentation-redis',
      '@opentelemetry/instrumentation-undici',
    ]);
  });
});
