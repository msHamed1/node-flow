import { describe, expect, it } from 'vitest';
import { createNodeFlowInstrumentations, sanitizeAttributes } from '../src/instrumentation.js';

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

  it('removes credentials, payloads, database statements, and URL secrets before export', () => {
    expect(
      sanitizeAttributes({
        'http.request.header.authorization': 'Bearer secret',
        'http.request.header.cookie': 'session=secret',
        'user.password': 'secret',
        'db.statement': "select * from users where token = 'secret'",
        'http.request.body': '{"password":"secret"}',
        'url.full': 'https://user:pass@example.com/payments?access_token=secret#private',
        'http.route': '/payments/:id',
        'nodeflow.identity': 'http-route:GET /payments/:id',
      }),
    ).toEqual({
      'url.full': 'https://example.com/payments',
      'http.route': '/payments/:id',
      'nodeflow.identity': 'http-route:GET /payments/:id',
    });
  });
});
