import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {
  Activity,
  Box,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Cpu,
  Database,
  GitBranch,
  HardDrive,
  MemoryStick,
  Network,
  Radio,
  Server,
  TimerReset,
  X,
  Zap,
} from 'lucide-react';
import type { CollectorMessage, RecentTrace, TopologyNode, TopologyNodeType, TopologySnapshot, TraceSpan } from '@nodescope/protocol';

const emptySnapshot: TopologySnapshot = {
  revision: 0,
  generatedAt: Date.now(),
  nodes: [],
  edges: [],
  traces: [],
  activity: { nodeIds: [], edgeIds: [] },
};

type FlowNodeData = Record<string, unknown> & TopologyNode & { active: boolean };
type FlowNode = Node<FlowNodeData, 'scope'>;

const nodeTypes = { scope: ScopeNode };

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [connected, setConnected] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [selectedTraceId, setSelectedTraceId] = useState<string>();
  const [tracePanelOpen, setTracePanelOpen] = useState(true);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let reconnectTimer: number | undefined;
    const connect = (): void => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${location.host}/ws`);
      socket.onopen = () => setConnected(true);
      socket.onclose = () => {
        setConnected(false);
        reconnectTimer = window.setTimeout(connect, 1_500);
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as CollectorMessage;
        if (message.type === 'snapshot') setSnapshot(message.payload);
      };
    };
    connect();
    return () => {
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  const { nodes, edges } = useMemo(() => buildFlow(snapshot), [snapshot]);
  const selectedNode = snapshot.nodes.find((node) => node.id === selectedNodeId);
  const selectedTrace = snapshot.traces.find((trace) => trace.id === selectedTraceId);
  const totals = useMemo(() => calculateTotals(snapshot), [snapshot]);
  const runtime = snapshot.runtime;
  const onNodeClick = useCallback((_event: React.MouseEvent, node: FlowNode) => setSelectedNodeId(node.id), []);

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Network size={18} /></div>
          <span>NodeScope</span>
          <span className="version">LOCAL</span>
        </div>
        <div className={`connection ${connected ? 'online' : ''}`}>
          <span className="connection-dot" />
          {connected ? 'Live stream connected' : 'Reconnecting to collector'}
        </div>
      </header>

      <section className="metric-strip" aria-label="Runtime summary">
        <Metric icon={<Radio />} label="Requests" value={formatInteger(totals.requests)} />
        <Metric icon={<Clock3 />} label="Avg latency" value={`${formatNumber(totals.avgLatency)} ms`} />
        <Metric icon={<Activity />} label="P95 latency" value={`${formatNumber(totals.p95Latency)} ms`} />
        <Metric icon={<CircleAlert />} label="Errors" value={formatInteger(totals.errors)} tone={totals.errors ? 'error' : undefined} />
        <Metric icon={<MemoryStick />} label="Heap used" value={runtime ? formatBytes(runtime.heapUsedBytes) : '—'} />
        <Metric icon={<Cpu />} label="CPU" value={runtime ? `${runtime.cpuPercent.toFixed(1)}%` : '—'} />
        <Metric icon={<Zap />} label="Event loop" value={runtime ? `${runtime.eventLoopUtilization.toFixed(1)}%` : '—'} />
        <Metric icon={<TimerReset />} label="Uptime" value={runtime ? formatUptime(runtime.uptimeSeconds) : '—'} />
      </section>

      <section className={`workspace ${tracePanelOpen ? '' : 'traces-collapsed'}`}>
        <div className="graph-panel">
          <div className="panel-heading overlay-heading">
            <div>
              <span className="eyebrow">LIVE TOPOLOGY</span>
              <h1>Runtime architecture</h1>
            </div>
            <span className="revision">REV {snapshot.revision}</span>
          </div>
          {nodes.length ? (
            <ReactFlow<FlowNode, Edge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={onNodeClick}
              fitView
              fitViewOptions={{ padding: 0.24 }}
              minZoom={0.15}
              maxZoom={1.8}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#293140" />
              <Controls position="bottom-left" showInteractive={false} />
            </ReactFlow>
          ) : (
            <EmptyTopology />
          )}
        </div>

        <aside className="trace-panel">
          <button className="trace-heading" type="button" onClick={() => setTracePanelOpen((value) => !value)}>
            <span><GitBranch size={15} /> Recent traces</span>
            <span className="trace-count">{snapshot.traces.length}</span>
            {tracePanelOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
          {tracePanelOpen && (
            <div className="trace-list">
              {snapshot.traces.length === 0 ? <div className="empty-list">No requests captured yet.</div> : snapshot.traces.map((trace) => (
                <button
                  type="button"
                  className={`trace-row ${trace.status === 'error' ? 'failed' : ''}`}
                  key={trace.id}
                  onClick={() => setSelectedTraceId(trace.id)}
                >
                  <span className="trace-method">{methodOf(trace.name)}</span>
                  <span className="trace-name">{routeOf(trace.name)}</span>
                  <span className="trace-latency">{formatNumber(trace.durationMs)} ms</span>
                  <span className="trace-time">{formatTime(trace.startedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </aside>
      </section>

      {selectedNode && (
        <NodeDrawer node={selectedNode} snapshot={snapshot} onClose={() => setSelectedNodeId(undefined)} />
      )}
      {selectedTrace && (
        <TraceDrawer trace={selectedTrace} onClose={() => setSelectedTraceId(undefined)} />
      )}
    </main>
  );
}

function ScopeNode({ data }: NodeProps<FlowNode>): React.JSX.Element {
  const Icon = iconForType(data.type);
  return (
    <div className={`scope-node type-${data.type} ${data.active ? 'active' : ''} ${data.errorCount ? 'has-error' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="node-icon"><Icon size={17} /></div>
      <div className="node-copy">
        <span className="node-type">{labelForType(data.type)}</span>
        <strong>{data.name}</strong>
        <span className="node-stats">{data.requestCount} calls · {formatNumber(data.avgLatencyMs)} ms avg</span>
      </div>
      {data.errorCount > 0 && <span className="node-error">{data.errorCount}</span>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function Metric({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone?: 'error' }): React.JSX.Element {
  return (
    <div className={`metric ${tone ?? ''}`}>
      <span className="metric-icon">{icon}</span>
      <span className="metric-copy"><span>{label}</span><strong>{value}</strong></span>
    </div>
  );
}

function EmptyTopology(): React.JSX.Element {
  return (
    <div className="empty-topology">
      <div className="empty-rings"><Activity size={28} /></div>
      <h2>Waiting for runtime traffic</h2>
      <p>Send a request to your application. Executed routes, controllers, services, and dependencies will appear here.</p>
      <code>curl -X POST http://localhost:3000/payments</code>
    </div>
  );
}

function NodeDrawer({ node, snapshot, onClose }: { node: TopologyNode; snapshot: TopologySnapshot; onClose: () => void }): React.JSX.Element {
  const connected = snapshot.edges
    .filter((edge) => edge.source === node.id || edge.target === node.id)
    .map((edge) => snapshot.nodes.find((candidate) => candidate.id === (edge.source === node.id ? edge.target : edge.source)))
    .filter((candidate): candidate is TopologyNode => Boolean(candidate));
  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div><span className="eyebrow">NODE DETAILS</span><h2>{node.name}</h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close node details"><X size={18} /></button>
      </div>
      <span className={`type-badge type-${node.type}`}>{labelForType(node.type)}</span>
      <div className="detail-grid">
        <Detail label="Requests" value={formatInteger(node.requestCount)} />
        <Detail label="Errors" value={formatInteger(node.errorCount)} error={node.errorCount > 0} />
        <Detail label="Error rate" value={`${node.errorRate.toFixed(1)}%`} error={node.errorRate > 0} />
        <Detail label="Avg latency" value={`${formatNumber(node.avgLatencyMs)} ms`} />
        <Detail label="P95 latency" value={`${formatNumber(node.p95LatencyMs)} ms`} />
        <Detail label="Operation" value={node.operation ?? '—'} />
      </div>
      <h3>Connected dependencies</h3>
      <div className="dependency-list">
        {connected.length ? connected.map((dependency) => (
          <div key={dependency.id}><span>{dependency.name}</span><small>{labelForType(dependency.type)}</small></div>
        )) : <span className="muted">No connected nodes yet.</span>}
      </div>
    </aside>
  );
}

function TraceDrawer({ trace, onClose }: { trace: RecentTrace; onClose: () => void }): React.JSX.Element {
  return (
    <aside className="drawer trace-drawer">
      <div className="drawer-header">
        <div><span className="eyebrow">TRACE WATERFALL</span><h2>{trace.name}</h2></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close trace"><X size={18} /></button>
      </div>
      <div className="trace-meta"><span>{formatTime(trace.startedAt)}</span><strong>{formatNumber(trace.durationMs)} ms</strong></div>
      <div className="waterfall">
        {trace.spans.map((span) => <TraceBranch key={span.spanId} span={span} trace={trace} depth={0} />)}
      </div>
    </aside>
  );
}

function TraceBranch({ span, trace, depth }: { span: TraceSpan; trace: RecentTrace; depth: number }): React.JSX.Element {
  const offset = Math.max(0, ((span.startTimeUnixMs - trace.startedAt) / Math.max(trace.durationMs, 1)) * 100);
  const width = Math.max(2, (span.durationMs / Math.max(trace.durationMs, 1)) * 100);
  return (
    <>
      <div className={`waterfall-row ${span.status === 'error' ? 'failed' : ''}`} style={{ paddingLeft: 12 + depth * 16 }}>
        <div className="waterfall-label"><span>{span.name}</span><small>{labelForSpan(span)}</small></div>
        <div className="waterfall-track"><span style={{ left: `${offset}%`, width: `${Math.min(width, 100 - offset)}%` }} /></div>
        <strong>{formatNumber(span.durationMs)} ms</strong>
      </div>
      {span.children.map((child) => <TraceBranch key={child.spanId} span={child} trace={trace} depth={depth + 1} />)}
    </>
  );
}

function Detail({ label, value, error }: { label: string; value: string; error?: boolean }): React.JSX.Element {
  return <div className={error ? 'detail error' : 'detail'}><span>{label}</span><strong>{value}</strong></div>;
}

function buildFlow(snapshot: TopologySnapshot): { nodes: FlowNode[]; edges: Edge[] } {
  const levels = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const edge of snapshot.edges) incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
  const levelOf = (id: string, seen = new Set<string>()): number => {
    if (levels.has(id)) return levels.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const parents = incoming.get(id) ?? [];
    const level = parents.length ? 1 + Math.max(...parents.map((parent) => levelOf(parent, new Set(seen)))) : 0;
    levels.set(id, level);
    return level;
  };
  snapshot.nodes.forEach((node) => levelOf(node.id));
  const rows = new Map<number, number>();
  const nodes: FlowNode[] = snapshot.nodes.map((node) => {
    const level = levels.get(node.id) ?? 0;
    const row = rows.get(level) ?? 0;
    rows.set(level, row + 1);
    return {
      id: node.id,
      type: 'scope',
      position: { x: level * 290, y: row * 122 },
      data: { ...node, active: snapshot.activity.nodeIds.includes(node.id) },
    };
  });
  const edges: Edge[] = snapshot.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: 'smoothstep',
    animated: snapshot.activity.edgeIds.includes(edge.id),
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    label: `${edge.requestCount} · ${formatNumber(edge.avgLatencyMs)} ms`,
    className: edge.errorCount ? 'flow-edge error' : 'flow-edge',
    style: { strokeWidth: snapshot.activity.edgeIds.includes(edge.id) ? 2.4 : 1.5 },
    labelStyle: { fontSize: 10, fontWeight: 600 },
  }));
  return { nodes, edges };
}

function calculateTotals(snapshot: TopologySnapshot): { requests: number; errors: number; avgLatency: number; p95Latency: number } {
  const routes = snapshot.nodes.filter((node) => node.type === 'http-route');
  const requests = routes.reduce((sum, node) => sum + node.requestCount, 0);
  const errors = routes.reduce((sum, node) => sum + node.errorCount, 0);
  const weightedLatency = routes.reduce((sum, node) => sum + node.avgLatencyMs * node.requestCount, 0);
  return {
    requests,
    errors,
    avgLatency: requests ? weightedLatency / requests : 0,
    p95Latency: routes.length ? Math.max(...routes.map((node) => node.p95LatencyMs)) : 0,
  };
}

function iconForType(type: TopologyNodeType): typeof Server {
  switch (type) {
    case 'database': case 'redis': return Database;
    case 'http-route': case 'external-http': return Server;
    case 'queue': case 'worker': return Radio;
    case 'controller': return Braces;
    case 'service': return Box;
  }
}

function labelForType(type: TopologyNodeType): string {
  return ({ 'http-route': 'HTTP route', controller: 'Controller', service: 'Service', database: 'Database', redis: 'Redis', queue: 'Queue', worker: 'Worker', 'external-http': 'External HTTP' })[type];
}

function labelForSpan(span: TraceSpan): string {
  return span.kind === 'internal' ? 'framework' : labelForType(span.kind);
}

function formatInteger(value: number): string { return new Intl.NumberFormat().format(value); }
function formatNumber(value: number): string { return value < 10 ? value.toFixed(1) : Math.round(value).toString(); }
function formatBytes(value: number): string { return `${(value / 1024 / 1024).toFixed(1)} MB`; }
function formatTime(value: number): string { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function formatUptime(seconds: number): string { const minutes = Math.floor(seconds / 60); return minutes < 1 ? `${seconds}s` : `${minutes}m`; }
function methodOf(name: string): string { return name.split(' ')[0] ?? 'REQ'; }
function routeOf(name: string): string { return name.split(' ').slice(1).join(' ') || name; }
