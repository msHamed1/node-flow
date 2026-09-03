# NodeFlow launch video — approved storyboard and motion contract

Status: locked for first-cut implementation  
Format: 55 seconds, 1920×1080, 30 fps, H.264 MP4, silent-first LinkedIn playback  
Creative rule: one persistent runtime graph world; no slides, screenshots, feature cards, or scene-level crossfades.

This document synthesizes the independent Creative Director, Product Storytelling, and Motion Design passes. It is the implementation source of truth. The first implementation agent may solve technical problems, but must not redesign the narrative, typography hierarchy, topology, timing, or transition grammar.

## Product truth

- NodeFlow visualizes architectural boundaries that actually execute; it does not statically scan an entire codebase.
- Start command: `npx node-flow dev -- npm run start:dev`.
- Compact CLI confirmation: `NodeFlow started` and `Runtime map: http://127.0.0.1:7331`.
- Implemented perspectives: Architecture, Traffic, Latency, Errors.
- The featured path is the real demo path: `POST /orders → OrdersController → OrdersService`, branching to `InventoryService → inventory.example.local` and `PostgreSQL`.
- Do not place `PaymentService` or `PaymentsService` in the order path.
- Timing values and counts are illustrative demo telemetry and must remain internally consistent.
- End-card claims: Open source · Local first · Node.js 20+ · NestJS.

## Visual system

- Canvas `#0A0D12`; surfaces `#11151C` and `#171C25`; border `#242B37`; primary text `#E9EDF5`; muted `#8590A2`.
- Runtime cyan `#4DD8C7`; routes blue `#6EA8FE`; services violet `#A78BFA`; latency orange `#F3A45B`; errors red `#FB7185`.
- Inter or equivalent modern grotesk for product/copy; DM Mono or equivalent for terminal and telemetry.
- UI owns 75–90% of the frame after second 4. Copy is an annotation in negative space, normally left aligned.
- Critical content stays inside 120 px horizontal and 72 px vertical safe margins.
- Node cards use 8–10 px radii and restrained 1 px borders. Active glow is local and low-opacity.
- Keep at least 80% of each frame neutral. Accent color represents state, not decoration.

## Motion system

- `enterSpring`: mass 0.85, stiffness 165, damping 22; settle about 420 ms.
- `microSpring`: mass 0.65, stiffness 240, damping 26; settle about 250 ms.
- Camera: cubic-bezier(0.22, 1, 0.36, 1), 700–1100 ms.
- Reframes: cubic-bezier(0.65, 0, 0.35, 1), 500–750 ms.
- Text/panel reveals: cubic-bezier(0.16, 1, 0.3, 1).
- Opacity transitions: cubic-bezier(0.4, 0, 0.2, 1), 180–320 ms.
- Node entrance: 8 px upward travel, 0.96→1 scale, border trace, then label reveal.
- Edge discovery begins after the source node is at least 75% visible; trim path over 260–420 ms.
- Request signal: one bright 7–10 px capsule with a 22 px restrained wake. Never use particle swarms or looping dots.
- Camera anticipates the request by 3–5 frames. It never orbits or uses fake 3D.
- Perspective changes keep topology coordinates and camera stable; only encodings change.
- The graph remains mounted for the full 55 seconds. Terminal, inspector, value sequence, and end composition transform from it.

## Scene-by-scene storyboard

### 0:00–0:04 — Hook: an incomplete model wakes up

At 0:00 the viewer is already inside a nearly black graph world, not on a title card. Five to seven unlabelled observation points and incomplete hairline edges sit at 6–10% opacity.

- 0:00–0:01.65: masked left-aligned reveal: **“Your architecture diagram is already outdated.”** Position near x=150, y=390. Maximum two lines, 68 px semibold.
- 0:01.65–0:02.05: the sentence exits upward through its mask while one ghost edge begins drawing.
- 0:01.90–0:03.55: reveal **“What if your Node.js app showed you what actually ran?”** in the lower-left negative space. Emphasize “actually ran” with weight/cyan, not a separate animation.
- 0:03.55–0:04.00: the active ghost edge extends left and becomes the terminal prompt baseline. The camera pushes toward it by about 2%.

Continuity anchor: ghost edge → terminal prompt.

### 0:04–0:09 — Ignition: terminal becomes topology

- 0:04–0:04.35: a compact terminal surface grows from the prompt baseline to roughly 68% frame width and 44% height. The ghost graph remains behind it.
- 0:04.35–0:05.55: type `npx node-flow dev -- npm run start:dev` at 32–38 characters per second with lightly varied cadence.
- 0:05.55–0:06.60: reveal `NodeFlow started` and `Runtime map: http://127.0.0.1:7331` as compact output lines. No fabricated startup log wall.
- 0:06.25–0:08.45: route/controller/service/infrastructure tokens detach from terminal baselines, condense into node primitives, and travel to their final graph coordinates. Their baselines lengthen and bend into edges. Stagger 110–150 ms.
- 0:08.45–0:09.00: terminal chrome collapses into a small connected/live status chip in the app header while the camera settles into the discovery framing. Motion continues across the scene boundary.

Continuity anchor: terminal tokens and cursor → nodes and live status.

### 0:09–0:18 — Runtime discovery: architecture comes alive

The causal order is real traffic, never a row-by-row tile reveal.

- 0:09–0:11.50: `POST /auth/login`, `POST /orders`, and `POST /payments` appear on separate beats; their route→controller edges draw and pulse once.
- 0:10.20–0:14.70: controllers reveal services. Use 80–160 ms staggering within each causal cluster.
- 0:11.50–0:16.90: branches complete: AuthService→Redis; PaymentsService→MongoDB/RabbitMQ; OrdersService→InventoryService→inventory.example.local and OrdersService→PostgreSQL.
- 0:09.70–0:12.20: small low-left annotation: **“Built from runtime truth.”** It later contracts into quiet UI microcopy.
- 0:16.20–0:18.00: camera eases back 6–8% and reveals layer coordinates: **“Routes → Controllers → Services → Infrastructure”**. The full graph holds for only 650–800 ms. `POST /orders` brightens around 0:17.65.

Continuity anchor: discovered full topology → selected order route.

### 0:18–0:30 — Proof: follow one request and inspect its time

- 0:18–0:18.75: compact `POST /orders` request chip enters from the left and compresses into a route input signal. Unrelated topology fades to 38%, never disappears.
- 0:18.65–0:21.10: camera reframes around the route/controller. The single signal traverses route→OrdersController; each node activates only on arrival.
- 0:20.80–0:24.00: camera anticipates the path into OrdersService. A small metric row expands. Overlay: **“See exactly where the request went.”**
- 0:22.20–0:26.10: OrdersService visibly branches. The primary signal travels to InventoryService→inventory.example.local; a lower-intensity side-effect signal travels OrdersService→PostgreSQL. The slow dependency signal moves 25% slower and keeps a warm residual edge.
- 0:25.65–0:27.15: the active node metric row grows into a right-side trace inspector while the graph shifts left 6–12 px. There is no cut and no replacement screen.
- 0:26.60–0:29.35: waterfall rows reveal in traversal order at 90 ms stagger; bars grow from their real start offsets. The bottleneck warms to orange only after reaching 70% width. Copy replaces in place: **“And where the time was spent.”**
- 0:29.35–0:30.00: inspector folds back toward the selected edge/header anchor as the graph begins pulling out. Warm bottleneck color survives into the next mode.

Illustrative consistent timings for the trace: POST /orders 142 ms; OrdersController 7 ms; OrdersService 128 ms; InventoryService 76 ms; inventory.example.local 64 ms; PostgreSQL 41 ms.

Continuity anchor: active path → inspector → bottleneck color.

### 0:30–0:39 — One model, different perspectives

The graph identity, coordinates, and camera remain recognizable. The active indicator glides through one persistent mode rail.

- 0:30–0:31.30 Architecture: structural borders/type labels return. Reveal **“One runtime model.”** beside the graph, never centered.
- 0:31.30–0:33.30 Traffic: edge widths interpolate; restrained `req/s` labels count up; a few live signals appear. Camera may nudge up to 40 px toward the busiest cluster.
- 0:33.30–0:35.45 Latency: signals quiet first; p95 replaces throughput labels; cool edges remap toward orange without moving.
- 0:35.45–0:37.60 Errors: markers emerge from existing ports; one error path receives restrained red, while healthy context remains visible.
- 0:37.00–0:39.00: reveal **“Different perspectives.”** The mode rail folds into a compact state chip around 0:38.55 as labels begin reorganizing for the value sequence.

Continuity anchor: unchanged graph geometry across all four encodings.

### 0:39–0:48 — Developer value: ambiguity collapses

This is a single transformation inside the same coordinate system—not three value cards.

- 0:39–0:40.75: labels become neutral semantic placeholders such as `unknown route`, `service`, and `dependency`; a few edges become incomplete. Reveal **“Understand unfamiliar systems faster.”**
- 0:40.75–0:42.50: a runtime-discovery sweep resolves real node names and completes edges as it intersects them.
- 0:42.50–0:44.55: the real order path retraces at 1.35× prior speed with compact trace rows attached to the active node. Replace copy with **“Trace a request before reading the entire codebase.”**
- 0:44.55–0:46.35: signal visibly decelerates at the slow dependency. Camera arrives four frames early; other topology eases to 28%. A compact latency annotation appears next to the edge.
- 0:46.05–0:48.00: replace copy with **“See architecture as it executes.”** The graph begins moving toward the end framing while one live path pulse remains.

Continuity anchor: unknown graph → resolved graph → request path → bottleneck → end graph.

### 0:48–0:55 — Resolve: a living end composition

- 0:48–0:49.20: camera eases to a 0.78× world view, moving the graph to the right. UI chrome simplifies; the graph never disappears.
- 0:49.00–0:50.40: reveal `NodeFlow`, then the two-line headline: **“See your Node.js architecture / execute in real time.”** Left aligned.
- 0:50.20–0:51.40: reveal `Open source · Local first · Node.js 20+ · NestJS` as one line, not badges.
- 0:51.20–0:52.25: reveal `github.com/msHamed1/node-flow` as a quiet mono CTA; draw a 2 px underline using the same edge language.
- 0:52.10–0:53.10: reveal **“Built from runtime truth.”** at low contrast.
- 0:53.10–0:55.00: hold all copy. The reduced graph remains alive with one request pulse, one small metric update, and at most 4 px camera drift. Keep the CTA visible on the final frame.

Continuity anchor: active graph line → CTA underline and living end topology.

## Remotion component contract

The implementation must expose independently animated primitives:

- `GraphWorld`: persistent world transform and subtle parallax field.
- `RuntimeNode`: entrance, active/completed/dim state, metrics, and label resolution.
- `RuntimeEdge`: trim progress, mode styling, and completion state.
- `Signal`: path progress, speed profile, wake length, and direction.
- `Terminal`: surface morph, cursor, token connectors, and token-to-node transformation.
- `Inspector`: anchor, masked surface growth, rows, waterfall bars, and selection cursor.
- `ModeRail`: continuous indicator and compact state.
- `CopyBlock`: per-line masks; never a full-scene opacity layer.
- `Camera`: continuously interpolated center/scale across all sequence boundaries.

Use absolute frames/shared state functions. Do not mount and unmount seven full-screen scenes. Audio is optional; the visual story must work completely muted.

## Rejection gates for the first render

Reject and revise if any condition is true:

- Graph is static for more than 1.2 seconds outside the final readability hold.
- Full-screen headline replaces the product for more than 0.8 seconds.
- Terminal disappears instead of visibly becoming graph primitives.
- Request propagation is decorative or uses a fabricated dependency.
- Camera lags behind the signal, perspective tabs rebuild the graph, or node positions jump.
- Waterfall order/names do not match the visible request path.
- Copy becomes centered presentation content when product negative space exists.
- Glow, particles, gradients, browser chrome, screenshots, feature cards, page swipes, or carousel behavior dominate.
- End state becomes a dead title card.

## Mandatory first-render review checkpoints

The independent reviewer must inspect the actual MP4 and representative rendered frames/motion around:

`00:03.8`, `00:06.8`, `00:08.8`, `00:12.5`, `00:16.5`, `00:20.8`, `00:23.8`, `00:25.8`, `00:27.6`, `00:31.8`, `00:34.0`, `00:36.2`, `00:41.5`, `00:43.6`, `00:45.6`, `00:48.6`, and `00:53.5`.

The reviewer must judge the rendered result—not only source code—and provide concrete timestamped fixes before the final implementation pass.
