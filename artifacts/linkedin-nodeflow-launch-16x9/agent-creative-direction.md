# NodeFlow launch film — creative direction

**Role:** independent creative director  
**Format:** 55 seconds, 1920×1080, 30 fps, silent-first LinkedIn viewing  
**Mandate:** the runtime graph is the protagonist. This is one continuous product moment, not seven slides.

## Creative thesis

The film should feel as though a dormant Node.js process becomes self-aware.

The opening begins with almost nothing: a dark field, a few uncertain connections, and one uncomfortable observation about static architecture. The terminal command acts as the ignition. From that point forward, every visual event is caused by runtime activity: topology resolves because telemetry arrives; edges illuminate because calls occur; the camera moves because the viewer follows a request; the inspection panel appears because the request is selected; perspectives change the graph's encoding rather than replacing the graph.

The strongest contemporary developer-tool launches do not merely display product screens. They make the product's behavior become the visual system. NodeFlow's behavior is more distinctive than a generic dashboard, so the film should privilege living topology over chrome, marketing copy, gradients, or cinematic ornament.

## Reference interpretation

The direction borrows principles, not surfaces:

- **Linear:** disciplined type hierarchy, generous negative space, tightly controlled information density, and interface details treated as editorial figures rather than screenshots.
- **Vercel:** stark contrast, short declarative copy, precision timing, and an emphasis on moving from signal to actionable context. Vercel's current observability language also supports a continuous path from runtime events to traces and metrics.
- **Raycast:** a dark professional interface, compact command-driven interaction, tasteful material depth, and product transitions that feel immediate rather than theatrical. Raycast's 2026 redesign explicitly emphasizes tasteful material use while retaining a professional, functional character.
- **Sentry and modern observability tools:** traces, waterfalls, correlated signals, error heat, and a progressive reduction of ambiguity. The useful visual metaphor is evidence accumulating, not abstract “data flying around.”

Primary product references consulted: [Linear](https://linear.app/), [Linear's launch method](https://linear.app/method/launching), [Vercel Observability](https://vercel.com/docs/observability), [Vercel Drains](https://vercel.com/blog/introducing-vercel-drains), [The New Raycast](https://www.raycast.com/blog/the-new-raycast), and [Raycast's brand guidance](https://www.raycast.com/press).

## Product truth and assumptions

- NodeFlow is shown as **open source**, **local first**, and for **Node.js 20+ / NestJS** only where the current project can support those claims.
- The four perspectives are real product concepts: **Architecture, Traffic, Latency, Errors**.
- The request story follows the repository's documented topology:  
  `POST /orders → OrdersController → OrdersService`, branching to `PostgreSQL` and to `InventoryService → inventory.example.local`.
- Do **not** place `PaymentService` inside the order request path. It belongs to the payment flow, not the documented order flow.
- Timing values, request counts, and errors may be illustrative demo telemetry, but should be internally consistent and visually labeled as a live/demo run—not framed as production measurements.
- The film may reconstruct product UI elements so they can animate independently, but their terminology and relationships should remain recognizable as NodeFlow.

## Visual language

### Overall character

- Quietly technical, exact, and high-confidence.
- Dense enough to reward developers, clean enough to understand without pausing.
- The interface occupies 75–90% of the frame after the hook.
- Marketing copy is annotation, never the main scene after 4 seconds.
- Motion communicates causality: discovered, called, selected, compared, isolated.

### Composition system

- Use a **12-column frame grid** with 96 px outer safe margins and a 32 px internal gutter.
- Keep critical copy inside an approximate **1600×820 safe field** for LinkedIn feed cropping and player controls.
- Default graph center sits slightly right of optical center, around 57% frame width. This creates an editorial left rail for short copy without shrinking the product.
- Avoid perfectly balanced layouts. Use deliberate asymmetry:
  - graph dominant right / copy low-left;
  - inspection panel entering from right while graph shifts left;
  - request label anchored close to its active path rather than centered on screen.
- Retain the product's layered architecture structure: entrypoints, application, services, infrastructure. Layer labels are quiet coordinates, not section banners.
- Use chrome sparingly: a 54–60 px top bar and compact perspective control are sufficient. Do not reproduce an entire browser window or OS desktop.

### Typography

- **Primary:** Inter or a metrically similar modern grotesk already used by NodeFlow.
- **Telemetry/terminal:** DM Mono, already used by NodeFlow.
- Hook headline: 64–72 px, semibold, tracking approximately −0.035 em, maximum two lines.
- In-product value overlays: 30–38 px, semibold, one line whenever possible.
- Supporting copy: 20–24 px, medium, muted.
- UI labels: 14–18 px; telemetry labels 13–16 px mono.
- No all-caps headline copy. Uppercase is reserved for tiny system labels such as `LIVE`, `P95`, `TRACE`, or architecture layer names.
- Text reveals are masked by line, 8–12 frames, with 8–16 px vertical travel. No typewriter effect outside the terminal.

### Palette

Use the actual NodeFlow palette as semantic color, not decoration:

| Role | Color | Use |
|---|---:|---|
| Canvas | `#0A0D12` | true background |
| Surface | `#11151C` | node and panel base |
| Raised surface | `#171C25` | selected cards, terminal, inspector |
| Border | `#242B37` | quiet structure |
| Primary text | `#E9EDF5` | headlines and node names |
| Muted | `#8590A2` | annotations and inactive metrics |
| Runtime truth | `#4DD8C7` | discovery, active calls, connected state |
| Route / secondary signal | `#6EA8FE` | entrypoints and path identity |
| Service distinction | `#A78BFA` | services where categorical color helps |
| Latency heat | `#F3A45B` | slow spans and p95 emphasis |
| Error | `#FB7185` | error state only |

Keep 80% of the frame neutral at all times. Cyan should be earned by live state. Orange and red must only appear when the semantic mode justifies them. Avoid broad generic gradients. A faint radial lift behind the graph is acceptable if under 6% opacity.

### Shape and depth

- Node cards: 8–10 px radius, 1 px borders, compact 2-line hierarchy.
- Selected node: brighter border plus a restrained 10–16 px soft halo at low opacity—not a neon aura.
- Edges: 1–1.5 px idle, 2–3 px active. Use curved paths only where they reduce overlap; otherwise favor disciplined orthogonal or shallow-bezier connections.
- Depth comes from overlap, camera scale, slight parallax, and surface luminance—not glassmorphism everywhere.
- Blur is transitional and local: 4–10 px on elements leaving focus for 4–8 frames. Never blur the whole frame for a scene change.

## Motion grammar

### Pacing and rhythm

The rhythm moves through four phases:

1. **Tension, 0–4 s:** minimal and editorial; two claims in quick succession.
2. **Ignition and discovery, 4–18 s:** accelerating event density; terminal becomes graph.
3. **Proof, 18–39 s:** the longest, most readable section; one request is followed, inspected, then reinterpreted.
4. **Compression and resolve, 39–55 s:** faster synthesis, then a calm end hold.

Average shot duration is not meaningful because the film avoids cuts. Instead, create a new focal event every 1.2–2.5 seconds. Never leave the same product state untouched for more than 1.5 seconds.

### Transitions

- **Continuity first:** every transition reuses an existing object—terminal cursor becomes a graph origin; request pulse becomes the trace selection; waterfall collapses back into its active edge; perspective control stays fixed while encodings change.
- Use 320–650 ms transitions for UI changes and 700–1100 ms for camera travel.
- Easing: critically damped or lightly underdamped spring; fast acquisition, soft arrival. No elastic overshoot above 3–4 px.
- Crossfades are for secondary labels only. Do not crossfade whole scenes.
- A hard cut is permissible only at the final brand resolve around 48 s, and even there a graph line should survive the cut as a visual bridge.

### Camera grammar

- Camera is an observer following runtime evidence, not a floating cinematic drone.
- Maximum scale excursion: roughly 0.80× wide view to 1.35× detail view.
- Pan before zoom by 3–5 frames so movement feels motivated by selection.
- During discovery, use a near-static camera with 1–2% parallax. Let nodes create energy.
- During request propagation, follow no more than 65% of the path; allow the pulse to move within frame rather than pinning it to center.
- When the inspector opens, shift the graph—not replace it. Preserve spatial memory.
- Perspective changes do not move the camera. The same geometry is the proof that one model answers multiple questions.

### Topology discovery

- Nodes arrive from their future positions with only 10–18 px of travel, 92%→100% scale, and a 220–340 ms spring.
- A node begins as a 3 px observation point; its border traces around; label and metric resolve last.
- Discovery order follows causality, not row-by-row choreography: route, controller, service, downstream service/infrastructure.
- Edges draw only after both endpoints exist. A single small packet travels the new edge once, then settles into a quiet live shimmer.
- Stagger 90–160 ms within a causal cluster; pause 250–400 ms between branches so the topology remains readable.

### Request propagation

- A compact `POST /orders` request chip enters from the left edge of the graph and merges into the route node.
- Active path gets a cyan/blue 2–3 px stroke; unrelated topology fades to 22–30% opacity without disappearing.
- Use one bright pulse head with a 120–180 px decay tail. Do not create multiple chasing dots.
- Each node responds on arrival: border lift, 101–102% scale, metric tick, then settles.
- At `OrdersService`, show the branch deliberately: inventory verification resolves first, then the PostgreSQL write. This makes the architecture legible and preserves the real topology.

### Trace and waterfall

- The camera follows the final pulse, then the right inspection drawer is revealed from the selected path itself.
- Span rows grow from their real start offsets, not simultaneously from zero.
- Use neutral bars by default; current span cyan; slowest span orange.
- Keep the graph visible at 55–65% width behind/alongside the trace so the viewer never loses the architectural context.

### Perspective changes

- Keep node positions and camera locked.
- **Architecture:** categorical borders and type labels.
- **Traffic:** edge width and compact request-rate labels animate into place.
- **Latency:** neutral edges heat toward orange; p95 becomes the dominant metric.
- **Errors:** error-bearing node/edge turns red; healthy topology recedes, but not to black.
- The active segment in the perspective control slides continuously; never cut to four separate views.

## Timestamped storyboard

### 0:00–0:04 — Hook: the static model fails

**0:00–0:01.65**  
Nearly black canvas. Off-center left, masked line reveal: **“Your architecture diagram is already outdated.”** Behind it, only six dim observation points and hairline edges breathe into visibility. The topology is incomplete and unlabelled.

**0:01.65–0:04.00**  
The first line rises 18 px and softens to muted gray as a second line resolves below it: **“What if your Node.js app could show you what actually ran?”** One cyan pulse travels through a faint edge behind the words. The camera begins an almost imperceptible push toward the pulse. No standalone title card; the graph is present from frame one.

### 0:04–0:09 — Ignition: command becomes runtime

**0:04–0:06.50**  
A compact terminal surface grows outward from the moving pulse/cursor, occupying about 64% of the frame, anchored lower-left. Type rapidly in DM Mono:  
`npx node-flow dev -- npm run start:dev`  
The cursor has a calm 530 ms blink, not a retro terminal gimmick.

**0:06.50–0:07.65**  
Three concise startup lines arrive, each shifting the prior line up:

- `collector ready 127.0.0.1:7331`
- `instrumentation attached`
- `waiting for runtime activity…`

The connected dot changes from muted to cyan.

**0:07.65–0:09.00**  
No cut. Terminal output baselines extend rightward and bend into graph edges. The terminal's rectangular surface loses opacity while the cursor resolves into the first route node. A small system label appears: `LIVE · revision 01`. The graph chrome becomes legible behind the dissolving terminal.

### 0:09–0:18 — Discovery: architecture wakes up

**0:09–0:11.50**  
Real traffic begins. `POST /auth/login`, `POST /orders`, and `POST /payments` appear at slightly different beats. Each causes its controller to materialize below/right, then a service. Newly discovered edges draw once and settle.

**0:11.50–0:15.30**  
The graph grows through causal branches: Auth to Redis; Orders to InventoryService, inventory API, and PostgreSQL; Payments to its documented dependencies. Infrastructure nodes sit at the visual perimeter so the application remains the core.

Small copy enters low-left, aligned with the interface rather than centered: **“Built from runtime truth.”** It holds for roughly 1.7 seconds, then becomes a tiny persistent annotation.

**0:15.30–0:18.00**  
Camera eases back 6–8% to reveal the complete topology. Layer labels brighten in sequence: `ROUTES → CONTROLLERS → SERVICES → INFRASTRUCTURE`. A compact summary count increments in the chrome. Edges retain occasional, low-frequency pulses so the graph never freezes.

### 0:18–0:30 — Proof: follow one real request

**0:18–0:19.60**  
A request chip—`POST /orders` with a tiny live duration counter—enters from the left and joins the route node. Unrelated nodes fade to 26%.

**0:19.60–0:23.60**  
The camera tracks a single pulse through:  
`POST /orders → OrdersController → OrdersService`  
At OrdersService the path forks visibly. First the pulse travels to `InventoryService → inventory.example.local`, then returns visually to the service and continues to `PostgreSQL`. Each arrival causes a restrained border response and a metric tick.

An integrated lower-left annotation appears: **“See exactly where the request went.”** It is never larger than the selected node.

**0:23.60–0:26.00**  
The PostgreSQL edge remains selected. The camera pushes in to 1.25–1.35× while a compact trace identity chip grows from the pulse: `trace 7f2… · POST /orders`. The graph shifts left as an inspector drawer emerges from the right edge—one spatial movement.

**0:26.00–0:30.00**  
The waterfall animates in temporal order. Rows show controller, service, inventory call, and PostgreSQL. The slowest illustrative span warms to orange and its value settles last. Copy updates in place: **“And where the time was spent.”** Do not freeze after bars complete; keep a faint cursor line scanning across the timing scale and a live metric ticking once.

### 0:30–0:39 — One model, four questions

**0:30–0:31.20**  
The waterfall folds back into the selected PostgreSQL edge. Camera returns to the full graph. Unrelated topology regains opacity. The perspective control is already visible in the product chrome.

**0:31.20–0:38.10**  
The active control glides through four modes without changing topology geometry:

- **Architecture, 0:31.2–0:32.4:** node type chips and layer logic are clear.
- **Traffic, 0:32.4–0:34.3:** busier edges widen; `req/s` labels count up; packets become slightly more frequent.
- **Latency, 0:34.3–0:36.2:** widths normalize while hot edges grade toward orange; p95 replaces traffic labels.
- **Errors, 0:36.2–0:38.1:** one plausible failing edge/node turns red; error count appears; healthy graph recedes.

No scene cuts, no card carousel. Color, line weight, and telemetry labels morph in place.

**0:33.00–0:39.00**  
Two short lines appear sequentially in the lower-left negative space and remain modest: **“One runtime model.”** then **“Different perspectives.”** The second replaces the first rather than stacking into a title slide.

### 0:39–0:48 — Developer value: ambiguity collapses

**0:39–0:41.40**  
Several application labels briefly scramble into neutral placeholders such as `unknown-service`, while node geometry remains. Text: **“Understand unfamiliar systems faster.”** As runtime events arrive, placeholders resolve to their real labels and layers.

**0:41.40–0:44.60**  
The resolved order path highlights again; the graph camera travels with it at 1.08× rather than fully zooming. Text replaces the prior line: **“Debug flows without reading the entire codebase.”** Keep the copy to two lines maximum, low-left.

**0:44.60–0:48.00**  
Latency perspective activates and isolates the warm PostgreSQL span/edge. Everything else holds enough contrast to retain context. Text resolves: **“See architecture as it executes.”** A cyan pulse reaches the orange bottleneck and slows perceptibly—evidence, not spectacle.

### 0:48–0:55 — Resolve: the living signature

**0:48–0:49.10**  
The camera pulls back. Most UI chrome fades, but the graph does not vanish. Its primary path contracts into a small NodeFlow mark/wordmark relationship at left-center. This is the only near-cut, bridged by the surviving edge line.

**0:49.10–0:52.20**  
Asymmetric end composition: NodeFlow name at upper-left of the end-card safe area; headline below, max two lines:  
**“See your Node.js architecture execute in real time.”**

On the right, a reduced living topology continues to receive subtle request pulses. It is not a static logo lockup.

**0:52.20–0:55.00**  
Supporting line and CTA reveal beneath:

`Open source · Local first · Node.js 20+ · NestJS`  
`github.com/msHamed1/node-flow`

Final small line: **“Built from runtime truth.”** Hold the readable URL for at least 2.5 seconds. The last pulse reaches the final infrastructure node around 0:54.4; the frame settles but remains alive through the end.

## Editorial rules for copy

- Show no more than 16 marketing words at once after the opening.
- Prefer a single declarative sentence, anchored to the visual evidence it describes.
- Never show a heading and three bullet points.
- Never repeat what the UI already makes obvious. For example, the mode names should live in the real control, not in four oversized captions.
- Design for silent autoplay: every narrative turn must be clear without voiceover or sound effects.
- If sound is added later, it should follow interaction causality—keystrokes, quiet discovery ticks, a low request sweep—not compensate for unclear visuals.

## Anti-pattern checklist

Reject the render if any of the following survive:

- a full-screen headline on an empty background for more than 1.2 seconds;
- a large screenshot parked in a rounded browser frame;
- feature cards, icon grids, bullet lists, or a four-panel mode montage;
- whole-screen dissolves or blur wipes between scenes;
- repeated centered layouts;
- indiscriminate cyan glow on every object;
- arbitrary particles, star fields, code rain, fake 3D depth, lens flares, or spinning logo animation;
- terminal output that does not causally become topology;
- request dots that travel decoratively rather than through real dependencies;
- graph positions that jump between Architecture, Traffic, Latency, and Errors;
- fabricated topology relationships, especially placing `PaymentService` in the `/orders` path;
- a final end card where all product motion stops immediately.

## Acceptance bar

The video succeeds if a developer watching without sound can answer, before the CTA appears:

1. What is NodeFlow? A live view of a running Node.js application's architecture.
2. How does it start? From the developer's own terminal/runtime.
3. What evidence does it show? Discovered components, dependencies, request paths, trace timing, traffic, latency, and errors.
4. Why should I care? It shortens the path from unfamiliar system to actual execution and bottleneck.

The creative test is even simpler: pause on any frame after second 7. It should look like a product in a meaningful state—not a presentation about a product.
