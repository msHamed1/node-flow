# @mshamed1/node-flow

NodeFlow is a local-first runtime architecture explorer for Node.js and NestJS applications. It
captures real local traffic and renders executed controllers, providers, databases, queues, caches,
and external calls as a live architecture map.

```bash
npm install --save-dev @mshamed1/node-flow
npx node-flow dev -- npm run start:dev
```

While the local collector is running, save and compare derived runtime architectures:

```bash
npx node-flow snapshot --output before.json
npx node-flow snapshot --output after.json
npx node-flow compare before.json after.json
```

Snapshots contain stable components, executed dependencies, aggregate metrics, and runtime paths;
they omit raw spans.

NestJS applications import `NodeFlowModule` once from `@mshamed1/node-flow/nestjs`. See the
[repository README](https://github.com/msHamed1/node-flow#readme) for installation, configuration,
privacy, troubleshooting, and current limitations.
