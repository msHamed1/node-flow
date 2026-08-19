import express from 'express';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { collectorPaths, type CollectorMessage, type RuntimeMetrics, type SpanBatch, type TopologySnapshot } from '@nodescope/protocol';
import { TopologyEngine } from '@nodescope/topology-engine';

export interface CollectorOptions {
  host?: string;
  port?: number;
  dashboardDirectory?: string;
  maxRecentTraces?: number;
}

export interface RunningCollector {
  url: string;
  port: number;
  engine: TopologyEngine;
  close(): Promise<void>;
}

export async function startCollector(options: CollectorOptions = {}): Promise<RunningCollector> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 7331;
  const engine = new TopologyEngine({ maxRecentTraces: options.maxRecentTraces ?? 50 });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  const server = createServer(app);
  const websocket = new WebSocketServer({ server, path: collectorPaths.websocket });
  const broadcast = (snapshot: TopologySnapshot): void => {
    const message: CollectorMessage = { type: 'snapshot', payload: snapshot };
    const payload = JSON.stringify(message);
    for (const client of websocket.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };

  websocket.on('connection', (client) => {
    const connected: CollectorMessage = { type: 'connected', payload: { version: '0.1.0' } };
    client.send(JSON.stringify(connected));
    client.send(JSON.stringify({ type: 'snapshot', payload: engine.snapshot() } satisfies CollectorMessage));
  });

  app.get(collectorPaths.health, (_request, response) => {
    response.json({ ok: true, localOnly: true, version: '0.1.0' });
  });
  app.get(collectorPaths.snapshot, (_request, response) => response.json(engine.snapshot()));
  app.post(collectorPaths.spans, (request, response) => {
    const batch = request.body as Partial<SpanBatch>;
    if (!Array.isArray(batch.spans)) {
      response.status(400).json({ error: 'Expected a span batch.' });
      return;
    }
    const snapshot = engine.ingest(batch.spans);
    broadcast(snapshot);
    response.status(202).json({ accepted: batch.spans.length, revision: snapshot.revision });
  });
  app.post(collectorPaths.runtime, (request, response) => {
    const metrics = request.body as RuntimeMetrics;
    if (typeof metrics?.timestamp !== 'number') {
      response.status(400).json({ error: 'Expected runtime metrics.' });
      return;
    }
    broadcast(engine.updateRuntime(metrics));
    response.status(202).end();
  });

  const dashboardDirectory = options.dashboardDirectory ?? process.env.NODESCOPE_DASHBOARD_DIR;
  if (dashboardDirectory && existsSync(dashboardDirectory)) {
    app.use(express.static(dashboardDirectory));
    app.get('*path', (_request, response) => response.sendFile(resolve(dashboardDirectory, 'index.html')));
  } else {
    app.get('/', (_request, response) => {
      response.type('text').send('NodeScope collector is running. Build the dashboard to enable the UI.');
    });
  }

  await listen(server, port, host);
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  return {
    url: `http://${host}:${boundPort}`,
    port: boundPort,
    engine,
    close: async () => {
      for (const client of websocket.clients) client.close();
      await new Promise<void>((resolveClose, reject) => websocket.close((error) => error ? reject(error) : resolveClose()));
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    },
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
}
