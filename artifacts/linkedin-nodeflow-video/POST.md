# LinkedIn post draft

Architecture diagrams are useful—but they start becoming outdated as soon as the system changes.

I built NodeFlow to explore a different approach: derive the architecture from the Node.js code
paths that actually execute.

Run your application through one development command, exercise normal traffic, and NodeFlow builds
a local runtime map of:

- HTTP routes
- NestJS controllers and providers
- Databases and caches
- Queues and external services
- Calls, latency, errors, runtime paths, and individual request waterfalls

You can also capture an architecture snapshot before a change and compare it afterward to see new
components, dependencies, and meaningful performance movement.

NodeFlow is local-first: the collector binds to localhost, telemetry stays in memory, and there are
no accounts or cloud uploads.

Repository: https://github.com/msHamed1/node-flow

I would love feedback from Node.js and NestJS developers: which runtime architecture question
should the tool answer next?

#NodeJS #NestJS #OpenTelemetry #SoftwareArchitecture #DeveloperTools #TypeScript
