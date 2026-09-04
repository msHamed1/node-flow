import type { TelemetrySpan } from '@mshamed1/node-flow-protocol';
import {
  type CanonicalEdgeMetrics,
  type CanonicalNodeMetrics,
  type CanonicalPathMetrics,
  type CanonicalTopology,
} from './canonical-topology.js';

export interface TelemetryBatch {
  serviceName: string;
  nodeVersion?: string;
  spans: TelemetrySpan[];
}

export interface GoldenFixture {
  name: string;
  covers: string[];
  batches: TelemetryBatch[];
  expected: CanonicalTopology;
}

const baseTime = 1_700_000_000_000;

export function goldenFixtures(): GoldenFixture[] {
  const routeId = 'http-route:get-/payments';
  const controllerId = 'nestjs:controller:paymentscontroller';
  const serviceId = 'nestjs:service:paymentsservice';
  const repositoryId = 'nestjs:service:paymentsrepository';
  const postgresId = 'database:postgresql';
  const mongoId = 'database:mongodb';
  const redisId = 'redis:redis';
  const queueId = 'queue:rabbitmq';
  const externalId = 'external-http:risk.example.com';
  const workerId = 'worker:paymentworker';

  return [
    {
      name: 'http controller service chain',
      covers: ['HTTP → Controller → Service'],
      batches: [
        batch(
          'payments-api',
          component('basic', 'route', undefined, 'GET /payments', 'http-route', 100, 0),
          component(
            'basic',
            'controller',
            'route',
            'PaymentsController.list',
            'controller',
            80,
            5,
            {
              identity: 'controller:PaymentsController',
              className: 'PaymentsController',
              framework: 'nestjs',
            },
          ),
          component('basic', 'service', 'controller', 'PaymentsService.list', 'service', 60, 10, {
            identity: 'service:PaymentsService',
            className: 'PaymentsService',
            framework: 'nestjs',
          }),
        ),
      ],
      expected: topology(
        ['payments-api'],
        [
          node(routeId, 'http', 'GET /payments', nmetrics(1, 0, 100)),
          node(controllerId, 'controller', 'PaymentsController', nmetrics(1, 0, 80), 'nestjs'),
          node(serviceId, 'service', 'PaymentsService', nmetrics(1, 0, 60), 'nestjs'),
        ],
        [
          edge(routeId, controllerId, emetrics(1, 0, 80)),
          edge(controllerId, serviceId, emetrics(1, 0, 60)),
        ],
        [path('GET /payments', [routeId, controllerId, serviceId], pmetrics(1, 0, 100))],
      ),
    },
    {
      name: 'nested service calls',
      covers: ['nested service calls'],
      batches: [
        batch(
          'payments-api',
          component('nested', 'service', undefined, 'PaymentsService.create', 'service', 50, 0, {
            identity: 'service:PaymentsService',
            className: 'PaymentsService',
            framework: 'nestjs',
          }),
          component(
            'nested',
            'repository',
            'service',
            'PaymentsRepository.insert',
            'service',
            30,
            5,
            {
              identity: 'service:PaymentsRepository',
              className: 'PaymentsRepository',
              framework: 'nestjs',
            },
          ),
          component('nested', 'postgres', 'repository', 'PostgreSQL', 'database', 10, 10),
        ),
      ],
      expected: topology(
        ['payments-api'],
        [
          node(postgresId, 'database', 'PostgreSQL', nmetrics(1, 0, 10)),
          node(serviceId, 'service', 'PaymentsService', nmetrics(1, 0, 50), 'nestjs'),
          node(repositoryId, 'service', 'PaymentsRepository', nmetrics(1, 0, 30), 'nestjs'),
        ],
        [
          edge(serviceId, repositoryId, emetrics(1, 0, 30)),
          edge(repositoryId, postgresId, emetrics(1, 0, 10)),
        ],
        [path('PaymentsService.create', [serviceId, repositoryId, postgresId], pmetrics(1, 0, 50))],
      ),
    },
    {
      name: 'mongoose and mongodb collapse to one dependency',
      covers: ['MongoDB / Mongoose', 'repeated dependency calls'],
      batches: [
        batch(
          'payments-api',
          component('mongo', 'service', undefined, 'PaymentsService.audit', 'service', 40, 0, {
            identity: 'service:PaymentsService',
            className: 'PaymentsService',
            framework: 'nestjs',
          }),
          component('mongo', 'mongoose', 'service', 'mongoose.Payment.save', 'database', 12, 5, {
            identity: 'database:MongoDB',
            topologyName: 'MongoDB',
          }),
          component('mongo', 'driver', 'service', 'mongodb.insert', 'database', 8, 20, {
            identity: 'database:MongoDB',
            topologyName: 'MongoDB',
          }),
        ),
      ],
      expected: topology(
        ['payments-api'],
        [
          node(mongoId, 'database', 'MongoDB', nmetrics(2, 0, 10, 8, 12, 12)),
          node(serviceId, 'service', 'PaymentsService', nmetrics(1, 0, 40), 'nestjs'),
        ],
        [edge(serviceId, mongoId, emetrics(2, 0, 10, 12))],
        [path('PaymentsService.audit', [serviceId, mongoId], pmetrics(1, 0, 40))],
      ),
    },
    {
      name: 'mixed infrastructure dependencies',
      covers: ['PostgreSQL', 'Redis', 'RabbitMQ', 'external HTTP', 'mixed dependency types'],
      batches: [
        batch(
          'payments-api',
          component('mixed', 'service', undefined, 'PaymentsService.settle', 'service', 100, 0, {
            identity: 'service:PaymentsService',
            className: 'PaymentsService',
            framework: 'nestjs',
          }),
          component('mixed', 'postgres', 'service', 'PostgreSQL', 'database', 10, 5),
          component('mixed', 'redis', 'service', 'Redis', 'redis', 5, 20, {
            identity: 'redis:Redis',
          }),
          component('mixed', 'queue', 'service', 'RabbitMQ', 'queue', 7, 35),
          component('mixed', 'http', 'service', 'risk.example.com', 'external-http', 15, 50, {
            identity: 'external-http:risk.example.com',
          }),
        ),
      ],
      expected: topology(
        ['payments-api'],
        [
          node(postgresId, 'database', 'PostgreSQL', nmetrics(1, 0, 10)),
          node(externalId, 'external-service', 'risk.example.com', nmetrics(1, 0, 15)),
          node(queueId, 'queue', 'RabbitMQ', nmetrics(1, 0, 7)),
          node(redisId, 'cache', 'Redis', nmetrics(1, 0, 5)),
          node(serviceId, 'service', 'PaymentsService', nmetrics(1, 0, 100), 'nestjs'),
        ],
        [
          edge(serviceId, postgresId, emetrics(1, 0, 10)),
          edge(serviceId, externalId, emetrics(1, 0, 15)),
          edge(serviceId, queueId, emetrics(1, 0, 7)),
          edge(serviceId, redisId, emetrics(1, 0, 5)),
        ],
        [
          path('PaymentsService.settle', [serviceId, postgresId], pmetrics(1, 0, 100)),
          path('PaymentsService.settle', [serviceId, externalId], pmetrics(1, 0, 100)),
          path('PaymentsService.settle', [serviceId, queueId], pmetrics(1, 0, 100)),
          path('PaymentsService.settle', [serviceId, redisId], pmetrics(1, 0, 100)),
        ],
      ),
    },
    {
      name: 'local event is trace detail rather than a topology node',
      covers: ['local events'],
      batches: [
        batch(
          'payments-api',
          component('event', 'service', undefined, 'PaymentsService.create', 'service', 40, 0, {
            identity: 'service:PaymentsService',
            className: 'PaymentsService',
            framework: 'nestjs',
          }),
          component('event', 'event', 'service', 'payments.created', 'custom', 4, 5),
          component(
            'event',
            'repository',
            'event',
            'PaymentsRepository.insert',
            'service',
            10,
            10,
            {
              identity: 'service:PaymentsRepository',
              className: 'PaymentsRepository',
              framework: 'nestjs',
            },
          ),
        ),
      ],
      expected: topology(
        ['payments-api'],
        [
          node(serviceId, 'service', 'PaymentsService', nmetrics(1, 0, 40), 'nestjs'),
          node(repositoryId, 'service', 'PaymentsRepository', nmetrics(1, 0, 10), 'nestjs'),
        ],
        [edge(serviceId, repositoryId, emetrics(1, 0, 10))],
        [path('PaymentsService.create', [serviceId, repositoryId], pmetrics(1, 0, 40))],
      ),
    },
    {
      name: 'worker background job',
      covers: ['workers / background jobs'],
      batches: [
        batch(
          'payments-worker',
          component('worker', 'worker', undefined, 'PaymentWorker.process', 'worker', 70, 0, {
            identity: 'worker:PaymentWorker',
          }),
          component('worker', 'mongo', 'worker', 'MongoDB', 'database', 20, 10, {
            identity: 'database:MongoDB',
            topologyName: 'MongoDB',
          }),
        ),
      ],
      expected: topology(
        ['payments-worker'],
        [
          node(mongoId, 'database', 'MongoDB', nmetrics(1, 0, 20)),
          node(workerId, 'provider', 'PaymentWorker.process', nmetrics(1, 0, 70)),
        ],
        [edge(workerId, mongoId, emetrics(1, 0, 20))],
        [path('PaymentWorker.process', [workerId, mongoId], pmetrics(1, 0, 70))],
      ),
    },
    {
      name: 'errors propagate to nodes edges and paths',
      covers: ['errors'],
      batches: [
        batch(
          'payments-api',
          component('error', 'route', undefined, 'GET /payments', 'http-route', 30, 0),
          component('error', 'postgres', 'route', 'PostgreSQL', 'database', 10, 5, {}, 'error'),
        ),
      ],
      expected: topology(
        ['payments-api'],
        [
          node(routeId, 'http', 'GET /payments', nmetrics(1, 0, 30)),
          node(postgresId, 'database', 'PostgreSQL', nmetrics(1, 1, 10)),
        ],
        [edge(routeId, postgresId, emetrics(1, 1, 10))],
        [path('GET /payments', [routeId, postgresId], pmetrics(1, 1, 30))],
      ),
    },
    {
      name: 'parallel and repeated operations aggregate deterministically',
      covers: ['parallel operations', 'repeated dependency calls'],
      batches: [
        batch(
          'payments-api',
          component('parallel-a', 'service', undefined, 'PaymentsService.read', 'service', 40, 0, {
            identity: 'service:PaymentsService',
            className: 'PaymentsService',
            framework: 'nestjs',
          }),
          component('parallel-a', 'postgres', 'service', 'PostgreSQL', 'database', 5, 5),
          component(
            'parallel-b',
            'service',
            undefined,
            'PaymentsService.read',
            'service',
            60,
            100,
            {
              identity: 'service:PaymentsService',
              className: 'PaymentsService',
              framework: 'nestjs',
            },
          ),
          component('parallel-b', 'postgres', 'service', 'PostgreSQL', 'database', 15, 105),
        ),
      ],
      expected: topology(
        ['payments-api'],
        [
          node(postgresId, 'database', 'PostgreSQL', nmetrics(2, 0, 10, 5, 15, 15)),
          node(serviceId, 'service', 'PaymentsService', nmetrics(2, 0, 50, 40, 60, 60), 'nestjs'),
        ],
        [edge(serviceId, postgresId, emetrics(2, 0, 10, 15))],
        [path('PaymentsService.read', [serviceId, postgresId], pmetrics(2, 0, 50, 60))],
      ),
    },
    {
      name: 'duplicate span replay is idempotent',
      covers: ['duplicate spans'],
      batches: [
        batch(
          'payments-api',
          component('duplicate', 'route', undefined, 'GET /payments', 'http-route', 20, 0),
          component('duplicate', 'postgres', 'route', 'PostgreSQL', 'database', 5, 5),
        ),
        batch(
          'payments-api',
          component('duplicate', 'route', undefined, 'GET /payments', 'http-route', 20, 0),
          component('duplicate', 'postgres', 'route', 'PostgreSQL', 'database', 5, 5),
        ),
      ],
      expected: topology(
        ['payments-api'],
        [
          node(routeId, 'http', 'GET /payments', nmetrics(1, 0, 20)),
          node(postgresId, 'database', 'PostgreSQL', nmetrics(1, 0, 5)),
        ],
        [edge(routeId, postgresId, emetrics(1, 0, 5))],
        [path('GET /payments', [routeId, postgresId], pmetrics(1, 0, 20))],
      ),
    },
    {
      name: 'missing parent leaves a disconnected node',
      covers: ['missing parent spans'],
      batches: [
        batch(
          'payments-api',
          component('missing', 'postgres', 'absent', 'PostgreSQL', 'database', 9, 0),
        ),
      ],
      expected: topology(
        ['payments-api'],
        [node(postgresId, 'database', 'PostgreSQL', nmetrics(1, 0, 9))],
        [],
        [],
      ),
    },
    {
      name: 'late and out-of-order parents reconcile topology',
      covers: ['late-arriving spans', 'out-of-order spans'],
      batches: [
        batch(
          'payments-api',
          component('late', 'postgres', 'service', 'PostgreSQL', 'database', 8, 20),
          component('late', 'service', 'controller', 'PaymentsService.list', 'service', 30, 10, {
            identity: 'service:PaymentsService',
            className: 'PaymentsService',
            framework: 'nestjs',
          }),
        ),
        batch(
          'payments-api',
          component('late', 'route', undefined, 'GET /payments', 'http-route', 50, 0),
          component('late', 'controller', 'route', 'PaymentsController.list', 'controller', 40, 5, {
            identity: 'controller:PaymentsController',
            className: 'PaymentsController',
            framework: 'nestjs',
          }),
        ),
      ],
      expected: topology(
        ['payments-api'],
        [
          node(postgresId, 'database', 'PostgreSQL', nmetrics(1, 0, 8)),
          node(routeId, 'http', 'GET /payments', nmetrics(1, 0, 50)),
          node(controllerId, 'controller', 'PaymentsController', nmetrics(1, 0, 40), 'nestjs'),
          node(serviceId, 'service', 'PaymentsService', nmetrics(1, 0, 30), 'nestjs'),
        ],
        [
          edge(routeId, controllerId, emetrics(1, 0, 40)),
          edge(controllerId, serviceId, emetrics(1, 0, 30)),
          edge(serviceId, postgresId, emetrics(1, 0, 8)),
        ],
        [path('GET /payments', [routeId, controllerId, serviceId, postgresId], pmetrics(1, 0, 50))],
      ),
    },
    {
      name: 'multiple services form one cross-service trace',
      covers: ['multiple application services', 'service relationships'],
      batches: [
        batch(
          'payments-api',
          component('cross', 'route', undefined, 'GET /payments', 'http-route', 100, 0),
          component('cross', 'queue', 'route', 'RabbitMQ', 'queue', 5, 5),
        ),
        batch(
          'payments-worker',
          component('cross', 'worker', 'queue', 'PaymentWorker.process', 'worker', 50, 20, {
            identity: 'worker:PaymentWorker',
          }),
          component('cross', 'mongo', 'worker', 'MongoDB', 'database', 10, 30, {
            identity: 'database:MongoDB',
            topologyName: 'MongoDB',
          }),
        ),
      ],
      expected: topology(
        ['payments-api', 'payments-worker'],
        [
          node(mongoId, 'database', 'MongoDB', nmetrics(1, 0, 10)),
          node(routeId, 'http', 'GET /payments', nmetrics(1, 0, 100)),
          node(queueId, 'queue', 'RabbitMQ', nmetrics(1, 0, 5)),
          node(workerId, 'provider', 'PaymentWorker.process', nmetrics(1, 0, 50)),
        ],
        [
          edge(routeId, queueId, emetrics(1, 0, 5)),
          edge(queueId, workerId, emetrics(1, 0, 50)),
          edge(workerId, mongoId, emetrics(1, 0, 10)),
        ],
        [path('GET /payments', [routeId, queueId, workerId, mongoId], pmetrics(1, 0, 100))],
      ),
    },
    {
      name: 'internal span is a transparent error boundary',
      covers: ['internal spans', 'error propagation across transparent spans'],
      batches: [
        batch(
          'payments-api',
          component('internal', 'route', undefined, 'GET /payments', 'http-route', 30, 0),
          component(
            'internal',
            'middleware',
            'route',
            'auth.middleware',
            'internal',
            20,
            2,
            {},
            'error',
          ),
          component('internal', 'postgres', 'middleware', 'PostgreSQL', 'database', 8, 5),
        ),
      ],
      expected: topology(
        ['payments-api'],
        [
          node(routeId, 'http', 'GET /payments', nmetrics(1, 0, 30)),
          node(postgresId, 'database', 'PostgreSQL', nmetrics(1, 0, 8)),
        ],
        [edge(routeId, postgresId, emetrics(1, 0, 8))],
        [path('GET /payments', [routeId, postgresId], pmetrics(1, 1, 30))],
      ),
    },
    {
      name: 'recursive service spans collapse consecutive identity',
      covers: ['recursive service calls', 'stable identity collapse'],
      batches: [
        batch(
          'payments-api',
          component('recursive', 'outer', undefined, 'PaymentsService.outer', 'service', 40, 0, {
            identity: 'service:PaymentsService',
            className: 'PaymentsService',
            framework: 'nestjs',
          }),
          component('recursive', 'inner', 'outer', 'PaymentsService.inner', 'service', 25, 5, {
            identity: 'service:PaymentsService',
            className: 'PaymentsService',
            framework: 'nestjs',
          }),
          component('recursive', 'postgres', 'inner', 'PostgreSQL', 'database', 8, 10),
        ),
      ],
      expected: topology(
        ['payments-api'],
        [
          node(postgresId, 'database', 'PostgreSQL', nmetrics(1, 0, 8)),
          node(serviceId, 'service', 'PaymentsService', nmetrics(2, 0, 32.5, 25, 40, 40), 'nestjs'),
        ],
        [edge(serviceId, postgresId, emetrics(1, 0, 8))],
        [path('PaymentsService.outer', [serviceId, postgresId], pmetrics(1, 0, 40))],
      ),
    },
  ];
}

interface ComponentMetadata {
  identity?: string;
  className?: string;
  framework?: string;
  topologyName?: string;
}

function component(
  traceId: string,
  spanId: string,
  parentSpanId: string | undefined,
  name: string,
  kind: TelemetrySpan['kind'],
  durationMs: number,
  offsetMs: number,
  metadata: ComponentMetadata = {},
  status: TelemetrySpan['status'] = 'ok',
): TelemetrySpan {
  return {
    traceId,
    spanId: `${traceId}-${spanId}`,
    ...(parentSpanId ? { parentSpanId: `${traceId}-${parentSpanId}` } : {}),
    name,
    kind,
    startTimeUnixMs: baseTime + offsetMs,
    durationMs,
    status,
    ...(Object.keys(metadata).length
      ? {
          attributes: {
            ...(metadata.identity ? { 'nodeflow.identity': metadata.identity } : {}),
            ...(metadata.className ? { 'nodeflow.class': metadata.className } : {}),
            ...(metadata.framework ? { 'nodeflow.framework': metadata.framework } : {}),
            ...(metadata.topologyName ? { 'nodeflow.topology_name': metadata.topologyName } : {}),
          },
        }
      : {}),
  };
}

function batch(serviceName: string, ...spans: TelemetrySpan[]): TelemetryBatch {
  return { serviceName, spans };
}

function topology(
  services: string[],
  nodes: CanonicalTopology['nodes'],
  edges: CanonicalTopology['edges'],
  paths: CanonicalTopology['paths'],
): CanonicalTopology {
  return {
    format: 'nodeflow.topology-golden.v1',
    snapshotVersion: '1.0',
    applicationRuntime: 'nodejs',
    services,
    nodes,
    edges,
    paths,
  };
}

function node(
  id: string,
  type: string,
  name: string,
  metrics: CanonicalNodeMetrics,
  framework?: string,
): CanonicalTopology['nodes'][number] {
  return { id, type, name, ...(framework ? { framework } : {}), metrics };
}

function edge(
  source: string,
  target: string,
  metrics: CanonicalEdgeMetrics,
): CanonicalTopology['edges'][number] {
  return {
    id: `dependency:${source}->${target}`,
    source,
    target,
    type: 'runtime-dependency',
    metrics,
  };
}

function path(
  entrypoint: string,
  nodes: string[],
  metrics: CanonicalPathMetrics,
): CanonicalTopology['paths'][number] {
  return { entrypoint, nodes, metrics };
}

function nmetrics(
  calls: number,
  errors: number,
  avgMs: number,
  p50Ms = avgMs,
  p95Ms = avgMs,
  p99Ms = p95Ms,
): CanonicalNodeMetrics {
  return { calls, errors, avgMs, p50Ms, p95Ms, p99Ms };
}

function emetrics(
  calls: number,
  errors: number,
  avgMs: number,
  p95Ms = avgMs,
): CanonicalEdgeMetrics {
  return { calls, errors, avgMs, p95Ms };
}

function pmetrics(
  calls: number,
  errors: number,
  avgMs: number,
  p95Ms = avgMs,
): CanonicalPathMetrics {
  return { calls, errors, avgMs, p95Ms };
}
