import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const port = Number.parseInt(process.env.PORT ?? '3100', 10);
const host = process.env.HOST ?? '0.0.0.0';

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    respond(response, 200, { ok: true });
    return;
  }
  if (request.method === 'POST' && request.url === '/risk/check') {
    const body = await readJson(request);
    if (body.fail === true) {
      respond(response, 500, { error: 'Deterministic risk-service failure' });
      return;
    }
    const amount = typeof body.amount === 'number' ? body.amount : 0;
    respond(response, 200, {
      approved: amount < 10_000,
      score: Math.min(99, Math.max(1, Math.round(amount / 100))),
    });
    return;
  }
  respond(response, 404, { error: 'Not found' });
});

server.listen(port, host, () => {
  console.log(`Mock risk service: http://${host}:${port}`);
});

process.once('SIGTERM', () => server.close());
process.once('SIGINT', () => server.close());

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
