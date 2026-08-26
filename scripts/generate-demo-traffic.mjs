const origin = process.env.NODEFLOW_DEMO_URL ?? 'http://127.0.0.1:3000';
const requests = [
  { path: '/auth/login', body: { email: 'developer@example.com' }, count: 8 },
  { path: '/payments', body: { amount: 125, currency: 'USD' }, count: 12 },
  { path: '/orders', body: { sku: 'nodeflow-demo', amount: 85 }, count: 6 },
];

for (const request of requests) {
  for (let index = 0; index < request.count; index += 1) {
    const response = await fetch(`${origin}${request.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
    });
    if (!response.ok) throw new Error(`${request.path} returned HTTP ${response.status}`);
  }
  console.log(`${request.path}: ${request.count} requests`);
}

console.log('NodeFlow demo traffic complete. Open http://127.0.0.1:7331');
