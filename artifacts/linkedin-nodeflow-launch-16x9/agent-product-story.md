# NodeFlow LinkedIn Launch — Product Storytelling Brief

Role: independent product-storytelling pass. This document defines the strongest truthful 55-second narrative from repository evidence. It does not prescribe implementation details beyond what must be visible to prove each claim.

## Story thesis

Most architecture diagrams describe intent. NodeFlow shows observed execution.

The video should therefore behave like a proof, not a feature tour:

1. Establish the credibility gap: static diagrams age immediately.
2. Show the low-friction start command.
3. Let real requests create the architecture in front of the viewer.
4. Select one request path and expose both its dependencies and timing.
5. Reuse the same runtime model to answer traffic, latency, and error questions.
6. Land the developer outcome: orient, trace, and find the next place to investigate.

The graph is the evidence. Copy should name what the viewer is already seeing, never compete with it.

## Recommended 55-second narrative

### 0:00–0:04 — The problem

**Narrative purpose:** Create tension around a familiar developer pain in one sentence, then immediately make the product promise.

**Exact on-screen copy:**

> Your architecture diagram is already outdated.

Then replace it with:

> What if your Node.js app showed you what actually ran?

**Proof requirement:** A faint, incomplete topology should begin forming before the question finishes. The product needs to answer the hook visually within the first four seconds.

**Claim status:** “Already outdated” is intentionally provocative launch language, not a factual claim about every diagram. “What actually ran” is supported: NodeFlow derives nodes, dependencies, and runtime paths from completed runtime spans and only shows executed components.

### 0:04–0:09 — One command, then runtime discovery

**Narrative purpose:** Remove setup anxiety and move directly into the live product.

**Exact on-screen copy:**

```text
npx node-flow dev -- npm run start:dev
```

Brief terminal confirmation, matching the real CLI:

```text
NodeFlow started
Runtime map: http://127.0.0.1:7331
```

**Proof requirement:** The terminal must resolve into the runtime map rather than ending as a separate scene. Do not imply that the command alone discovers the full system; nodes should appear only as application traffic arrives.

**Claim status:** Command and output are implemented. NestJS users must also import `NodeFlowModule` once in the root module for semantic controller/provider nodes. That nuance is too detailed for the video but must remain accurate in supporting post/README copy.

### 0:09–0:18 — Runtime truth becomes architecture

**Narrative purpose:** Deliver the core product differentiator before showing secondary features.

**Exact on-screen copy:**

> Built from runtime truth.

Then, smaller and adjacent to the graph:

> Routes → Controllers → Services → Infrastructure

Optional microcopy in the UI, not as a title:

> Components appear as they execute

**Proof sequence:** Show the three repository demo flows arrive progressively rather than revealing every technology at once:

1. `POST /auth/login → AuthController → AuthService → Redis`
2. `POST /payments → PaymentsController → PaymentsService → MongoDB / RabbitMQ`
3. `POST /orders → OrdersController → OrdersService → InventoryService → inventory.example.local`, with `OrdersService → PostgreSQL`

This sequence naturally expands the system from one simple vertical slice into a connected runtime architecture. Repeated traffic should update call/latency metrics on existing nodes, not duplicate nodes.

**Claim status:** All three paths exist in the included NestJS demo. The simulated demo uses `traceBoundary()` adapters for infrastructure latency, but the graph is still produced by actual HTTP traffic and exported spans; no topology is inserted directly. The separate Docker integration lab exercises real PostgreSQL, MongoDB, Redis, RabbitMQ, outgoing HTTP, API, and worker infrastructure.

### 0:18–0:30 — Follow one real request

**Narrative purpose:** Convert the system map from “interesting picture” into a debugging instrument.

**Exact on-screen copy:**

First:

> See exactly where the request went.

Then, as the trace waterfall becomes dominant:

> And where the time was spent.

**Truthful request path:**

```text
POST /orders
→ OrdersController
→ OrdersService
→ InventoryService
→ inventory.example.local

OrdersService
→ PostgreSQL
```

**Proof requirement:** Highlight the selected runtime path and dim unrelated components, then enter a trace waterfall for that individual request. Timing rows should retain the same names so viewers understand that graph path and waterfall are two views of one execution.

**Correction to the illustrative brief:** `PaymentService` is not part of the repository’s `POST /orders` flow. The actual class is `PaymentsService`, and it belongs to `POST /payments`, where it calls MongoDB and RabbitMQ. For `POST /orders`, use `OrdersService → InventoryService → inventory.example.local` and `OrdersService → PostgreSQL`. Do not fabricate `OrdersService → PaymentService → External API`.

**Claim status:** Runtime-path selection, dim/hide behavior, recent traces, nested spans, duration display, and a trace waterfall are implemented in the dashboard.

### 0:30–0:39 — One model, multiple questions

**Narrative purpose:** Show breadth without starting a feature-list montage.

**Exact on-screen copy:**

> One runtime model.

Then:

> Different perspectives.

Keep the implemented tab labels visible:

```text
Architecture   Traffic   Latency   Errors
```

**Proof requirement:** Keep graph identity and layout stable while visual encoding changes. The viewer should recognize the same nodes and edges as call volume, p95 latency, and error counts become the emphasis.

**Claim status:** These four perspectives are implemented. Traffic uses request count, Latency uses p95 latency, and Errors uses error count for node/edge emphasis and labels.

### 0:39–0:48 — Developer outcome

**Narrative purpose:** Translate product mechanics into an immediate reason to try it.

**Exact on-screen copy, one line at a time:**

> Understand unfamiliar systems faster.

> Trace a request before reading the entire codebase.

> See architecture as it executes.

**Proof chain underneath the copy:** Unknown system → observed runtime topology → selected request path → slow dependency highlighted.

**Why this wording:** “Trace a request before reading the entire codebase” is more credible than “Debug flows without reading the entire codebase.” NodeFlow shows architectural boundaries and request traces; it does not trace every JavaScript function, replace source inspection, or automatically diagnose root cause.

**Claim status:** “Faster” is a product-value proposition rather than a measured benchmark. The visual proof should make it plausible without presenting it as quantified evidence. “Architecture as it executes” is directly aligned with implemented behavior.

### 0:48–0:55 — Product identity and action

**Narrative purpose:** Name the product only after the viewer has seen the proof, then give one clear next action.

**Exact on-screen copy:**

> NodeFlow

> See your Node.js architecture execute in real time.

Supporting line:

> Open source · Local first · Node.js 20+ · NestJS

CTA:

> github.com/msHamed1/node-flow

Final signature:

> Built from runtime truth.

**Claim status:**

- Open source: repository contains an Apache-2.0 license and package metadata identifies Apache-2.0.
- Local first: the collector defaults to `127.0.0.1:7331`; telemetry is process-local/in-memory and the documented product has no accounts, API keys, analytics, cloud sync, or remote collectors.
- Node.js 20+: enforced in the public package engine metadata.
- NestJS: semantic controller/provider instrumentation is implemented through the NodeFlow NestJS module. NodeFlow also supports Node.js infrastructure instrumentation, so avoid saying “NestJS only.”
- CTA: the configured repository remote and package metadata point to `msHamed1/node-flow`.

## Exact copy deck

Use this as the authoritative on-screen wording:

```text
Your architecture diagram is already outdated.

What if your Node.js app showed you what actually ran?

npx node-flow dev -- npm run start:dev

Built from runtime truth.
Routes → Controllers → Services → Infrastructure

POST /orders
See exactly where the request went.
And where the time was spent.

One runtime model.
Different perspectives.

Understand unfamiliar systems faster.
Trace a request before reading the entire codebase.
See architecture as it executes.

NodeFlow
See your Node.js architecture execute in real time.
Open source · Local first · Node.js 20+ · NestJS
github.com/msHamed1/node-flow
Built from runtime truth.
```

## Claim guardrails

### Safe claims

- Captures executed HTTP, NestJS controller/provider, PostgreSQL, MongoDB/Mongoose, Redis, RabbitMQ/amqplib, and outgoing HTTP/fetch boundaries where supported.
- Turns completed runtime telemetry into semantic components, executed dependencies, aggregated runtime paths, recent traces, and waterfalls.
- Shows architecture, traffic, latency, and error perspectives over the same topology.
- Keeps normal controller/service business code free of NodeFlow tracing calls after the required NestJS module registration.
- Runs locally with an in-memory collector and dashboard.
- Supports local snapshots and before/after architecture comparison, though this feature is not necessary for the 55-second launch story.

### Claims to avoid or qualify

- Do not say “zero configuration” for NestJS. One root `NodeFlowModule` import is required for semantic controllers/providers.
- Do not imply static analysis, full codebase scanning, or that unexecuted code appears. Only executed components appear.
- Do not say NodeFlow traces every JavaScript function. It instruments architectural boundaries.
- Do not claim automatic root-cause diagnosis. It identifies observed paths, timings, counts, and errors that guide investigation.
- Do not show `PaymentService` in the order flow. The implemented class is `PaymentsService`, and it belongs to the payment flow.
- Do not imply explicit multi-service grouping or multi-host collection; those remain outside the current release.
- Do not call simulated demo adapters “real databases.” If the video shows the compact included demo, describe its requests as real and its infrastructure spans as simulated. The repository’s Docker lab is the real-infrastructure proof.
- Do not put a package version on the end card. `packages/cli/package.json` is `1.1.1`, while one README sentence still says stable npm release `1.0.0`; the evergreen CTA avoids this repository inconsistency.
- Do not overstate “real time” as instantaneous. The implementation batches span export on a 250 ms schedule and updates the dashboard over WebSocket; “execute in real time” is established product language, not a strict latency guarantee.

## Evidence map

| Story claim | Repository evidence |
| --- | --- |
| Product definition and executed-only topology | `README.md:10-30`, `README.md:69-72`, `README.md:257-258` |
| Real start command | `README.md:63-67`, `packages/cli/src/cli.ts:15-20`, `packages/cli/src/cli.ts:36-40` |
| Actual CLI confirmation | `packages/cli/src/cli.ts:146-149` |
| Local in-memory behavior | `README.md:98-108`, `apps/collector/src/index.ts:29-32` |
| WebSocket live updates | `apps/collector/src/index.ts:37-53`, `apps/collector/src/index.ts:62-73` |
| Implemented four perspectives | `README.md:86-96`, `apps/dashboard/src/App.tsx:55-60`, `apps/dashboard/src/App.tsx:415-425`, `apps/dashboard/src/App.tsx:969-979` |
| Runtime-path selection and trace waterfall | `README.md:90-96`, `apps/dashboard/src/App.tsx:269-315`, `apps/dashboard/src/App.tsx:369-384`, `apps/dashboard/src/App.tsx:843-907` |
| Included demo’s three paths | `README.md:455-489`, `apps/demo-nestjs/src/main.ts:24-126` |
| Actual orders flow | `apps/demo-nestjs/src/main.ts:54-77`, `apps/demo-nestjs/src/main.ts:100-109`, `apps/demo-nestjs/src/simulated-infrastructure.ts:77-94`, `apps/demo-nestjs/src/simulated-postgres.ts:21-48` |
| Actual payments flow | `apps/demo-nestjs/src/main.ts:32-52`, `apps/demo-nestjs/src/main.ts:90-98` |
| Supported infrastructure instrumentation | `README.md:337-352`, `packages/instrumentation-node/src/instrumentation.ts:58-78` |
| Metrics retained on nodes and edges | `README.md:354-364` |
| Node.js 20+ and Apache-2.0 | `packages/cli/package.json:2-9` |
| Repository CTA | `packages/cli/package.json:45-50`; Git remote `origin git@github.com:msHamed1/node-flow.git` |
| Current scope exclusion | `README.md:452-453` |

## Editorial recommendation

The launch should spend roughly 70% of its runtime proving the product through the living graph and request trace, 20% translating that proof into developer value, and no more than 10% on product identity/CTA. Avoid a voiceover-dependent structure: every critical idea should remain understandable with LinkedIn autoplay muted. If narration is added later, it should reinforce the same short sentences rather than introduce extra claims.
