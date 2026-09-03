# NodeFlow Launch Video — Motion Design Specification

Motion-design input for a 55-second, 16:9, 30 fps Remotion film. This document defines movement and choreography only. It assumes every graph node, edge, label, pulse, terminal line, metric, panel, trace span, tab, and text line is an independently animated primitive.

## Motion thesis

The graph is the film's persistent world. The camera never leaves it; terminal, inspection, perspectives, and the end state are transformations or lenses over the same runtime model. Avoid scene cards. Each sequence must inherit at least one spatial anchor or moving element from the previous sequence.

The application should feel calm, precise, and fast—not hyperactive. Most motion is driven by discovery, request execution, or a user action. Ambient motion is almost imperceptible.

## Global system

### Composition and hierarchy

- Master: 1920 × 1080, 30 fps, 55 seconds.
- Safe frame: keep essential UI and copy inside 120 px left/right and 72 px top/bottom.
- The runtime graph occupies 70–88% of the frame in all product sequences.
- Copy never blocks the active request path. Use negative space created by the current camera framing.
- Maximum simultaneous hierarchy: one active node, one active edge pulse, one active message, one supporting panel.
- Inactive graph content stays visible at 28–45% opacity so topology context is never lost.
- Camera is 2D and restrained: translation, scale, and at most 0.2° of rotational drift. No fake perspective or 3D orbit.

### Timing vocabulary

Use a small, consistent set of curves:

| Name | Curve / parameters | Use |
| --- | --- | --- |
| `enterSpring` | damped spring, mass 0.85, stiffness 165, damping 22; settle ≈ 420 ms | Nodes, chips, compact panels |
| `microSpring` | mass 0.65, stiffness 240, damping 26; settle ≈ 250 ms | Active outlines, tab indicators, badges |
| `cameraEase` | cubic-bezier(0.22, 1, 0.36, 1) | 700–1100 ms camera moves |
| `reframeEase` | cubic-bezier(0.65, 0, 0.35, 1) | 500–750 ms perspective reframing |
| `revealEase` | cubic-bezier(0.16, 1, 0.3, 1) | Text masks, panel reveals |
| `signalEase` | linear | Request pulses and edge traversal |
| `fadeEase` | cubic-bezier(0.4, 0, 0.2, 1) | 180–320 ms opacity changes |

Springs must not bounce visibly. Overshoot is capped at roughly 1.5%. Never apply springs to long text blocks or full-frame camera movement.

### Camera coordinate model

Treat the complete graph bounds as normalized coordinates `x: 0–100`, `y: 0–100`, with route entrypoints on the left, application logic in the center, and infrastructure on the right.

| Shot | Center | Scale | Purpose |
| --- | --- | --- | --- |
| `WORLD_GHOST` | (50, 50) | 0.84 | Faint topology behind hook |
| `WORLD_DISCOVERY` | (48, 49) | 0.94 | Full topology assembly |
| `REQUEST_ENTRY` | (30, 47) | 1.12 | Route and controller |
| `REQUEST_CORE` | (53, 49) | 1.22 | Services and active edge |
| `REQUEST_EXIT` | (73, 52) | 1.16 | External/API and database result |
| `TRACE_FOCUS` | (60, 51) | 1.07 | Graph left, inspector right/bottom |
| `PERSPECTIVE_WORLD` | (50, 50) | 0.91 | Whole-model mode switching |
| `BOTTLENECK_FOCUS` | (61, 54) | 1.18 | Slow span and dependency highlighted |
| `END_WORLD` | (66, 52) | 0.78 | Graph moved right to create copy space |

Camera movement must begin 3–5 frames before an active pulse reaches the edge of the current framing, so the camera appears to anticipate execution rather than chase it.

### Graph primitive behavior

- Node arrival: 8 px upward travel, opacity 0→1, scale 0.96→1 with `enterSpring`; shadow appears after 60% of the entrance.
- Node discovery state: border draws clockwise over 240 ms, then title and type label reveal over 160 ms.
- Edge discovery: trim-path 0→1 over 260–420 ms depending on length. Edge begins only after its source node reaches 75% entrance.
- Dependency pulse: 7–10 px soft capsule traveling along an already-drawn edge; 420–650 ms per edge. One bright core plus a 22 px low-opacity wake. Do not use particles.
- Active node: outline opacity 0.35→1 in 120 ms, slight 1.015 scale with `microSpring`, inner surface lightens 4–6%.
- Completed node: active treatment settles to a thin accent border over 180 ms rather than disappearing.
- Inactive node during a request: desaturate by 25%, opacity 0.38, scale unchanged.
- Metric changes: numerals crossfade with vertical 4 px motion; do not odometer-spin.
- Edge direction is shown by a single moving signal, not looping dots or marching ants.

### Typography motion

- Headlines reveal from a 105% line-height clipping mask with 18 px vertical travel, 420–520 ms per line.
- Supporting text reveals in 280–360 ms with no character-by-character effect.
- Stagger between headline lines: 120–160 ms.
- Text exits by mask reversal plus 6 px drift, 220–300 ms.
- Terminal typing is the only character-by-character animation.
- Avoid kinetic typography. The UI remains the primary action.

### Layered depth

- Background grid/dots: translate at 0.10× camera movement.
- Edge field: 0.92× camera movement.
- Nodes: 1× camera movement.
- Floating panel or copy: 1.03× camera movement, capped to 8 px total offset.
- Use 10–18 px blur only during panel transformations, never as a full-screen transition.

## Timestamped choreography

### 0:00–0:04 — Hook: an outdated diagram wakes up

**0:00–0:00.30**

- Begin from near-black, not a title card. A barely visible grid fades to 10% opacity.
- Reveal the first sentence at x≈150, y≈390, left aligned: “Your architecture diagram is already outdated.”
- The line reveals in two masked segments over 480 ms. No scale-up.

**0:00.30–0:01.65**

- Behind the copy, 5–7 ghost nodes materialize at 6–10% opacity in `WORLD_GHOST` framing.
- Their edges appear as incomplete hairlines. Two nodes drift by less than 2 px, implying unresolved structure rather than decorative motion.

**0:01.65–0:02.05**

- First sentence exits upward through its mask in 260 ms.
- Simultaneously, one ghost edge begins to draw and becomes the spatial bridge into the second question.

**0:01.90–0:03.55**

- Reveal the two-line question in the lower-left negative space: “What if your Node.js app could show you / what actually ran?”
- Emphasize “actually ran” using weight or accent color, not a different animation.
- Ghost graph clarity increases to 17%. A slow signal traverses one edge once, finishing just before the terminal appears.

**0:03.55–0:04.00**

- Copy fades to 15% while the active edge extends leftward beyond the graph bounds.
- The leading edge becomes the terminal prompt baseline. This is the start of the terminal transition—no cut to black.

### 0:04–0:09 — Start NodeFlow: terminal becomes topology

**0:04–0:04.35**

- A compact terminal surface grows outward from the transformed graph edge at x≈120, y≈260 to occupy roughly 68% width and 44% height.
- Use masked width/height expansion with `revealEase`, corner radius interpolating 3→12 px. No pop-in.
- The faint graph remains visible behind it at 10–14% opacity.

**0:04.35–0:05.55**

- Type `npx node-flow dev -- npm run start:dev` at 32–38 characters/second.
- Cursor cadence is 520 ms, but stop blinking while characters are actively typed.
- Apply small clusters of variable typing cadence: 2–4 frame gaps, never a uniform typewriter rhythm.

**0:05.55–0:06.60**

- Three short output lines arrive at 140–190 ms intervals. Each enters with a 4 px vertical motion and opacity, not typing.
- When runtime discovery begins, route/service tokens in the output briefly receive a 160 ms accent flash.

**0:06.25–0:08.45**

- Each recognized token emits a thin connector from its terminal line to its future graph position.
- Terminal lines detach in sequence: text opacity falls while a compact node card condenses from the same baseline and travels 80–240 px to its graph coordinate.
- Start with one route and controller, then a service, then infrastructure. Stagger 110–150 ms.
- Terminal surface becomes increasingly transparent and narrower as graph occupancy increases. It should feel absorbed by the topology.
- Camera moves continuously from terminal framing into `WORLD_DISCOVERY` over 1050 ms with `cameraEase`.

**0:08.45–0:09.00**

- The terminal chrome collapses into a small terminal status chip in the product top bar.
- Remaining graph primitives retain velocity into the next sequence. Never finish all animation exactly at 0:09.

### 0:09–0:18 — Architecture comes alive

Discovery follows causal layers, not random tile animation.

**0:09–0:10.70 — Entrypoints**

- Route nodes appear left-to-right with 120 ms stagger.
- A subtle “runtime discovery” scan travels vertically once across the graph, but it only reveals nodes when data exists; it is not a decorative beam.
- Small integrated overlay enters near the upper-left graph boundary: “Built from runtime truth.”

**0:10.20–0:12.30 — Controllers**

- Route→controller edges trim on first, then controller nodes resolve at the edge endpoints.
- Each edge gets exactly one 480 ms pulse after discovery.
- Camera drifts center from x=42 to x=49, scale 0.98→1.03; movement is almost unnoticed.

**0:11.80–0:14.70 — Services**

- Controller→service dependencies arrive in small causal groups, not all at once.
- Branching paths use 80 ms staggering between siblings.
- Service nodes remain visually dominant; route and infrastructure groups are slightly smaller or lower contrast.

**0:14.20–0:16.90 — Infrastructure**

- Redis, databases, queue, and external API nodes appear as edges reach them.
- Infrastructure icons can receive a single 140 ms surface tint when discovered; no icon bounce.
- Ambient edge pulses begin at very low opacity, with no more than two on screen at once.

**0:16.20–0:18.00**

- Supporting overlay reveals close to the lower-left margin: “Routes → Controllers → Services → Infrastructure”.
- Graph reaches stable full-topology framing for only 650–800 ms—long enough to read, not long enough to become a screenshot.
- At 0:17.65 the `POST /orders` route subtly brightens, preparing the request sequence before the copy exits.

### 0:18–0:30 — A real request moves through the topology

Use a product-real path. The motion system supports branching without inventing a dependency; for example: route → controller → service → downstream service/external dependency, with a database write as a branch when that relationship exists.

**0:18–0:18.75 — Trigger**

- A small request chip slides from the left app edge toward the route node: `POST /orders`.
- Chip uses 20 px travel and `enterSpring`, then compresses into a colored signal at the route's input port.
- Unrelated nodes ease to 38% opacity over 280 ms.

**0:18.65–0:21.10 — Entry traversal**

- Camera moves to `REQUEST_ENTRY` over 820 ms.
- Route activates for 260 ms. The request signal traverses to the controller over 430 ms.
- Controller activates on signal arrival—not earlier. A tiny latency tag appears 90 ms afterward.
- Completed route retains a quiet accent border.

**0:20.80–0:24.00 — Core traversal**

- Camera anticipates the signal and moves to `REQUEST_CORE` in 740 ms.
- The service node expands its compact metric row by 12 px height to expose live duration; content reveals with a mask.
- If the flow branches, pause the signal for 120 ms at the branching service, then send the primary signal first and a lower-intensity write/side-effect signal 90 ms later.
- Copy enters in available upper-left space: “See exactly where the request went.” It remains subordinate to the active path.

**0:23.70–0:26.10 — Dependency exit and bottleneck cue**

- Reframe to `REQUEST_EXIT` over 700 ms.
- On the longest downstream edge, slow the pulse's visible travel by 25% and lengthen its wake. This makes latency legible before any chart appears.
- Destination node activates; response signal returns only as a thin, quick 320 ms reverse pulse—not a second full traversal.
- The slow segment remains warm-accented after completion.

**0:25.65–0:27.15 — Graph becomes the inspector**

- Do not cut to an inspection screen.
- Pin the active path in place while the camera shifts to `TRACE_FOCUS`.
- The right/bottom inspection panel grows out of the active service node's metric row: first a connecting line, then a surface mask expands over 520 ms.
- Graph nodes slide 6–12 px to make room; they do not abruptly resize.

**0:26.60–0:29.35 — Waterfall builds**

- Trace rows reveal in the exact order of request traversal at 90 ms stagger.
- Each timing bar grows from its actual start offset to its duration using `revealEase`, 360–620 ms.
- The bottleneck bar grows slightly slower and receives a subtle warm edge when it passes 70% completion.
- Cursor/selection indicator travels down the trace rows once, synchronized with node highlights still visible in the graph.
- Replace overlay copy with “And where the time was spent.” via mask cross-reveal, not a separate title.

**0:29.35–0:30.00**

- Collapse the inspector toward its mode-control/header anchor while the graph begins zooming out.
- Preserve the bottleneck color as the connective visual into the latency/error perspectives.

### 0:30–0:39 — One model, different perspectives

This is one continuous product state. Tabs switch; the graph geometry remains stable. Do not make four mini-slides.

**0:30–0:31.30 — Architecture**

- Camera settles at `PERSPECTIVE_WORLD`.
- Mode rail/tab indicator glides into view from the product header over 300 ms.
- “Architecture” is active. Node borders and type colors return to structural encoding.
- Overlay enters left of the mode rail: “One runtime model.”

**0:31.30–0:33.30 — Traffic**

- Active-tab underline travels horizontally with `microSpring` over 260 ms.
- Edge widths and request counters interpolate over 420 ms. High-traffic edges brighten; a restrained set of signals appears.
- Do not replace the graph or crossfade to a different screenshot.
- Camera nudges 40 px toward the busiest cluster.

**0:33.30–0:35.45 — Latency**

- Tab indicator continues from its current position.
- Signals cease first, then edges remap to cool→warm latency color over 360 ms.
- Longest path receives a soft 180 ms outline pulse and metric labels update with vertical crossfade.
- Camera moves to a midpoint between `PERSPECTIVE_WORLD` and `BOTTLENECK_FOCUS`.

**0:35.45–0:37.60 — Errors**

- Error markers emerge from existing node status ports in 220 ms; never fly in from offscreen.
- Healthy paths fade slightly. Error-connected edges gain a restrained red accent and a single pulse stops at the failing node.
- No screen shake, warning siren animation, or red full-frame wash.

**0:37.00–0:39.00**

- Reveal the second line under the first: “Different perspectives.”
- Modes briefly remain visible as a connected sequence; underline settles under the most narratively useful final mode.
- At 0:38.55 the mode rail folds into a small state chip while graph opacity and labels reorganize for the value sequence.

### 0:39–0:48 — Developer value as a transformation, not cards

The four ideas—unknown codebase, runtime topology, request trace, bottleneck—must occupy the same coordinate system and continuously resolve.

**0:39–0:40.75 — Unknown**

- Graph labels scramble to semantic placeholders such as `unknown route`, `service`, and `dependency`; topology geometry stays visible at 24–30%.
- A few edges remain dashed/incomplete, with no decorative glitch effect.
- Copy reveals at x≈130, y≈210: “Understand unfamiliar systems faster.”

**0:40.75–0:42.50 — Resolved topology**

- Runtime discovery sweep moves left→right once. Each node resolves its real name as the sweep intersects it.
- Dashed edges become solid through trim-path continuation, not crossfade.
- Camera moves from world framing toward the route/service cluster over 780 ms.

**0:42.50–0:44.55 — Request trace**

- The request path reactivates at 1.35× the earlier traversal speed, reusing the same route and geometry.
- Small trace rows trail the signal as a compact overlay attached to the active node.
- First copy masks upward; second line replaces it: “Debug flows without reading the entire codebase.”

**0:44.55–0:46.35 — Bottleneck**

- Signal reaches the slow dependency and visibly decelerates. Camera arrives at `BOTTLENECK_FOCUS` 4 frames before the signal.
- Everything except the bottleneck path fades to 28% over 220 ms.
- A compact latency annotation expands beside the slow edge, then stops moving. No pulsing red circles.

**0:46.05–0:48.00 — Architecture executing**

- Final value line reveals: “See architecture as it executes.”
- Active route-to-dependency path remains alive with one clean pulse.
- Inactive graph content begins migrating toward `END_WORLD`; copy remains anchored so the move feels like opening space, not ending a slide.

### 0:48–0:55 — End state built from the live graph

**0:48–0:49.20**

- Camera eases to `END_WORLD`; graph shifts to the right and scales down.
- Labels simplify, but nodes remain visibly alive. One low-opacity request signal continues every 2.4 seconds, maximum two traversals during the end state.
- The last value line transforms into the headline position rather than disappearing to black.

**0:49.00–0:50.40**

- NodeFlow wordmark reveals from a horizontal mask at upper-left.
- Headline reveals below it in two compact lines: “See your Node.js architecture / execute in real time.”
- Reveal duration 560 ms, line stagger 120 ms.

**0:50.20–0:51.40**

- Supporting line fades/masks in: `Open source · Local first · Node.js 20+ · NestJS`.
- Feature separators appear with the text; never animate each claim as a badge.

**0:51.20–0:52.25**

- CTA enters as a quiet code-like row: `github.com/msHamed1/node-flow`.
- A 2 px accent line draws beneath the repository path over 420 ms, aligned to the moving edge language used earlier.

**0:52.10–0:53.10**

- Final line “Built from runtime truth.” reveals at low contrast.
- The visible graph on the right resolves back to Architecture mode colors, closing the film on the same structural truth introduced at 0:09.

**0:53.10–0:55.00**

- Hold the full end composition for readability, but keep it alive: one request pulse, a 1–2% node metric update, and a 4 px camera drift.
- Fade only the peripheral grid and ambient edges in the last 300 ms. Do not fade the headline or CTA before the final frame; LinkedIn's loop/stop frame should remain useful.

## Continuity map

Every transition inherits a visual object:

1. Ghost graph edge → terminal prompt baseline.
2. Terminal tokens → discovered graph nodes.
3. Full topology → selected request route.
4. Active node metric row → trace inspector panel.
5. Bottleneck trace color → latency/error graph encoding.
6. Perspective graph → unknown/resolved developer-value graph.
7. Active graph path → living end-card topology.

If an edit cannot identify its inherited object, it is probably becoming a slide transition and should be redesigned.

## Remotion implementation contract

The later implementer should expose these independently addressable layers:

- `GraphWorld`: world transform, parallax grid, group bounds.
- `RuntimeNode`: entrance progress, active/completed/dim state, metric state, label-resolution state.
- `RuntimeEdge`: draw progress, mode color/width, completed state.
- `Signal`: path progress, speed profile, wake length, direction.
- `Terminal`: surface morph bounds, line tokens, cursor, token-to-node connectors.
- `Inspector`: anchor point, mask growth, rows, waterfall bars, selection.
- `ModeRail`: active mode, underline x/width, compact/folded state.
- `CopyBlock`: line masks and per-line alpha; no global scene opacity.
- `Camera`: center/scale derived continuously across scene boundaries.

Drive each property from absolute frames or shared motion-state functions. Do not mount/unmount entire scenes at cut points. Keep the graph world mounted for all 55 seconds and interpolate states across narrative intervals.

## Quality gates: reject the render if any are true

- The graph is fully static for more than 1.2 seconds outside the final readability hold.
- A full-screen title replaces the product for more than 0.8 seconds.
- A transition uses a page swipe, card carousel, zoom-through-logo, hard cut to a screenshot, or generic gradient wipe.
- Multiple unrelated nodes pulse continuously.
- Copy is centered over the graph when useful negative space exists.
- Perspective switching moves or rebuilds the topology instead of remapping the same graph.
- The terminal disappears before its tokens visibly become graph primitives.
- The request pulse arrives at a node before the node visually activates.
- The waterfall timing is disconnected from graph traversal order.
- Glow is stronger than typography or node labels.
- The final end state looks dead or disconnected from the preceding graph.

## Render-review checkpoints

Review actual frames and motion around these timestamps after the first render:

- 0:03.8 — ghost edge becoming terminal baseline.
- 0:06.8 — terminal tokens beginning to become nodes.
- 0:08.8 — terminal chrome collapsing into the app.
- 0:12.5 and 0:16.5 — causal topology discovery remains readable.
- 0:20.8, 0:23.8, 0:25.8 — signal/camera synchronization across the request.
- 0:27.6 — waterfall bars map to the visible path.
- 0:31.8, 0:34.0, 0:36.2 — same graph clearly changes perspective without slide-like resets.
- 0:41.5, 0:43.6, 0:45.6 — continuous unknown→trace→bottleneck transformation.
- 0:48.6 — graph repositions into end composition without a cut.
- 0:53.5 — end text is readable while the graph remains subtly alive.

