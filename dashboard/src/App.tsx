import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
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
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  Activity,
  ArrowDown,
  Box,
  Braces,
  ChevronDown,
  ChevronRight,
  Database,
  Eye,
  EyeOff,
  FileDiff,
  GitBranch,
  Layers3,
  Network,
  Radio,
  Search,
  Server,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  CollectorMessage,
  NodeFlowSnapshot,
  RecentTrace,
  TopologyEdge,
  TopologyNode,
  TopologyNodeType,
  TopologySnapshot,
  TraceSpan,
} from '@mshamed1/node-flow-protocol';
import {
  architectureSummary,
  comparisonFromSnapshots,
  dependencyRows,
  edgeVisualWeight,
  groupRuntimePaths,
  layoutArchitecture,
  liveInsights,
  searchArchitecture,
  topologyStructureKey,
  validateSnapshotShape,
  type DiffStatus,
  type GraphPerspective,
  type NodePosition,
  type PathDisplayMode,
  type RuntimePathGroup,
  type SnapshotComparison,
} from './explorer.js';

const emptySnapshot: TopologySnapshot = {
  revision: 0,
  generatedAt: Date.now(),
  nodes: [],
  edges: [],
  paths: [],
  traces: [],
  activity: { nodeIds: [], edgeIds: [] },
};

type FlowNodeData = Record<string, unknown> &
  TopologyNode & {
    active: boolean;
    dimmed: boolean;
    onSelectedPath: boolean;
    selected: boolean;
    perspective: GraphPerspective;
    heat: number;
    diffStatus?: DiffStatus;
  };
type FlowNode = Node<FlowNodeData, 'scope'>;

const nodeTypes = { scope: ScopeNode };
const perspectives: Array<{ id: GraphPerspective; label: string }> = [
  { id: 'architecture', label: 'Architecture' },
  { id: 'traffic', label: 'Traffic' },
  { id: 'latency', label: 'Latency' },
  { id: 'errors', label: 'Errors' },
];

export function App(): React.JSX.Element {
  const [liveSnapshot, setLiveSnapshot] = useState(emptySnapshot);
  const [connected, setConnected] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [selectedTraceId, setSelectedTraceId] = useState<string>();
  const [selectedEntrypoint, setSelectedEntrypoint] = useState('');
  const [pathDisplayMode, setPathDisplayMode] = useState<PathDisplayMode>('dim');
  const [perspective, setPerspective] = useState<GraphPerspective>('architecture');
  const [showTrafficLabels, setShowTrafficLabels] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [tracePanelOpen, setTracePanelOpen] = useState(false);
  const [snapshotPanelOpen, setSnapshotPanelOpen] = useState(false);
  const [beforeSnapshot, setBeforeSnapshot] = useState<NodeFlowSnapshot>();
  const [afterSnapshot, setAfterSnapshot] = useState<NodeFlowSnapshot>();
  const [snapshotError, setSnapshotError] = useState('');
  const [flow, setFlow] = useState<ReactFlowInstance<FlowNode, Edge>>();

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
        if (message.type === 'snapshot') setLiveSnapshot(message.payload);
      };
    };
    connect();
    return () => {
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

  const comparison = useMemo<SnapshotComparison | undefined>(
    () =>
      beforeSnapshot && afterSnapshot
        ? comparisonFromSnapshots(beforeSnapshot, afterSnapshot)
        : undefined,
    [afterSnapshot, beforeSnapshot],
  );
  const snapshot = comparison?.snapshot ?? liveSnapshot;
  const structureKey = topologyStructureKey(snapshot);
  // Layout depends only on node/edge identity. Metric-only WebSocket updates reuse it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const positions = useMemo(() => layoutArchitecture(snapshot), [structureKey]);
  const pathGroups = useMemo(() => groupRuntimePaths(snapshot), [snapshot]);
  const selectedPath = pathGroups.find((path) => path.entrypoint === selectedEntrypoint);
  const summary = useMemo(() => architectureSummary(snapshot), [snapshot]);
  const insights = useMemo(
    () => comparison?.insights ?? liveInsights(snapshot),
    [comparison, snapshot],
  );
  const searchResults = useMemo(
    () => searchArchitecture(snapshot, searchQuery),
    [searchQuery, snapshot],
  );
  const { nodes, edges } = useMemo(
    () =>
      buildFlow({
        snapshot,
        positions,
        selectedPath,
        pathDisplayMode,
        perspective,
        showTrafficLabels,
        selectedNodeId,
        nodeStatuses: comparison?.nodeStatuses,
        edgeStatuses: comparison?.edgeStatuses,
      }),
    [
      comparison,
      pathDisplayMode,
      perspective,
      positions,
      selectedNodeId,
      selectedPath,
      showTrafficLabels,
      snapshot,
    ],
  );
  const selectedNode = snapshot.nodes.find((node) => node.id === selectedNodeId);
  const selectedTrace = liveSnapshot.traces.find((trace) => trace.id === selectedTraceId);

  useEffect(() => {
    if (!flow || !nodes.length) return;
    const frame = window.requestAnimationFrame(() =>
      flow.fitView({ padding: 0.22, duration: 350 }),
    );
    return () => window.cancelAnimationFrame(frame);
    // Fit only after structural changes, never for metric-only revisions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, structureKey]);

  useEffect(() => {
    if (selectedEntrypoint && !pathGroups.some((path) => path.entrypoint === selectedEntrypoint)) {
      setSelectedEntrypoint('');
    }
  }, [pathGroups, selectedEntrypoint]);

  const focusNode = useCallback(
    (nodeId: string): void => {
      setSelectedNodeId(nodeId);
      setSearchQuery('');
      const position = positions.get(nodeId);
      if (flow && position) {
        void flow.setCenter(position.x + 112, position.y + 42, { zoom: 1.15, duration: 350 });
      }
    },
    [flow, positions],
  );

  const loadSnapshot = useCallback(
    async (file: File | undefined, target: 'before' | 'after'): Promise<void> => {
      if (!file) return;
      try {
        const parsed: unknown = JSON.parse(await file.text());
        if (!validateSnapshotShape(parsed)) {
          throw new Error('Expected a valid NodeFlow snapshot with version 1.0.');
        }
        if (target === 'before') setBeforeSnapshot(parsed);
        else setAfterSnapshot(parsed);
        setSnapshotError('');
        setSelectedEntrypoint('');
        setSelectedNodeId(undefined);
      } catch (error) {
        setSnapshotError(error instanceof Error ? error.message : String(error));
      }
    },
    [],
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Network size={18} />
          </div>
          <span>NodeFlow</span>
          <span className="version">LOCAL</span>
        </div>
        <div className="product-line">See your Node.js architecture execute in real time.</div>
        <div className={`connection ${connected ? 'online' : ''}`}>
          <span className="connection-dot" />
          {connected ? 'Live' : 'Reconnecting'}
        </div>
      </header>

      <section className="explorer">
        <aside className="explorer-rail">
          <section className="rail-section summary-section">
            <div className="section-heading">
              <span className="eyebrow">RUNTIME ARCHITECTURE</span>
              {comparison && <span className="mode-badge">COMPARE</span>}
            </div>
            <div className="summary-primary">
              <SummaryValue value={summary.components} label="components" />
              <SummaryValue value={summary.dependencies} label="dependencies" />
              <SummaryValue value={summary.entrypoints} label="entrypoints" />
              <SummaryValue value={summary.runtimePaths} label="runtime paths" />
            </div>
            <div className="summary-infra">
              <span>{summary.databases} DB</span>
              <span>{summary.caches} cache</span>
              <span>{summary.queues} queue</span>
              <span>{summary.externalServices} external</span>
            </div>
          </section>

          <section className="rail-section paths-section">
            <div className="section-heading">
              <span>
                <GitBranch size={13} /> Runtime paths
              </span>
              <span className="count-badge">{pathGroups.length}</span>
            </div>
            <button
              type="button"
              className={`path-row ${selectedEntrypoint === '' ? 'selected' : ''}`}
              onClick={() => setSelectedEntrypoint('')}
            >
              <span>All runtime traffic</span>
            </button>
            <div className="path-list">
              {pathGroups.length ? (
                pathGroups.map((path) => (
                  <button
                    type="button"
                    className={`path-row ${selectedEntrypoint === path.entrypoint ? 'selected' : ''}`}
                    key={path.entrypoint}
                    onClick={() => setSelectedEntrypoint(path.entrypoint)}
                  >
                    <span>
                      <strong>{methodOf(path.entrypoint)}</strong>
                      {routeOf(path.entrypoint)}
                    </span>
                    <small>{formatInteger(path.calls)} calls</small>
                  </button>
                ))
              ) : (
                <p className="empty-copy">Paths appear after application traffic.</p>
              )}
            </div>
          </section>

          <section className="rail-section insights-section">
            <div className="section-heading">
              <span>
                <Sparkles size={13} /> Observations
              </span>
            </div>
            {insights.length ? (
              insights.map((insight) => (
                <div className="insight" key={insight.id}>
                  <strong>{insight.title}</strong>
                  <span>{insight.detail}</span>
                </div>
              ))
            ) : (
              <p className="empty-copy">No deterministic observations yet.</p>
            )}
          </section>

          <section className="rail-section collapsible-section">
            <button
              type="button"
              className="collapse-heading"
              onClick={() => setSnapshotPanelOpen((open) => !open)}
            >
              <span>
                <FileDiff size={13} /> Compare snapshots
              </span>
              {snapshotPanelOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {snapshotPanelOpen && (
              <div className="snapshot-loader">
                <SnapshotInput
                  label="Before"
                  loaded={beforeSnapshot?.generatedAt}
                  onFile={(file) => void loadSnapshot(file, 'before')}
                />
                <SnapshotInput
                  label="After"
                  loaded={afterSnapshot?.generatedAt}
                  onFile={(file) => void loadSnapshot(file, 'after')}
                />
                {snapshotError && <p className="loader-error">{snapshotError}</p>}
                {comparison && (
                  <button
                    type="button"
                    className="clear-compare"
                    onClick={() => {
                      setBeforeSnapshot(undefined);
                      setAfterSnapshot(undefined);
                    }}
                  >
                    Return to live architecture
                  </button>
                )}
                <div className="diff-legend">
                  <span className="added">+ Added</span>
                  <span className="removed">− Removed</span>
                  <span className="changed">~ Changed</span>
                </div>
              </div>
            )}
          </section>

          <section className="rail-section collapsible-section traces-section">
            <button
              type="button"
              className="collapse-heading"
              onClick={() => setTracePanelOpen((open) => !open)}
            >
              <span>
                <Activity size={13} /> Recent traces{' '}
                <span className="count-badge">{liveSnapshot.traces.length}</span>
              </span>
              {tracePanelOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {tracePanelOpen && (
              <TraceList traces={liveSnapshot.traces} onSelect={setSelectedTraceId} />
            )}
          </section>
        </aside>

        <section className="graph-panel">
          <div className="graph-toolbar">
            <div className="search-control">
              <Search size={14} />
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search architecture..."
                aria-label="Search architecture"
              />
              {searchQuery && (
                <div className="search-results">
                  {searchResults.length ? (
                    searchResults.map((node) => (
                      <button type="button" key={node.id} onClick={() => focusNode(node.id)}>
                        <NodeTypeIcon type={node.type} />
                        <span>
                          <strong>{node.name}</strong>
                          <small>{labelForType(node.type)}</small>
                        </span>
                      </button>
                    ))
                  ) : (
                    <span>No matching components.</span>
                  )}
                </div>
              )}
            </div>
            <div className="perspective-tabs" aria-label="Graph perspective">
              {perspectives.map((view) => (
                <button
                  type="button"
                  key={view.id}
                  className={perspective === view.id ? 'selected' : ''}
                  onClick={() => setPerspective(view.id)}
                >
                  {view.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`toolbar-toggle ${showTrafficLabels ? 'selected' : ''}`}
              onClick={() => setShowTrafficLabels((visible) => !visible)}
              title="Toggle edge traffic labels"
            >
              <Radio size={13} /> Labels
            </button>
            {selectedPath && (
              <button
                type="button"
                className="toolbar-toggle selected"
                onClick={() => setPathDisplayMode((mode) => (mode === 'dim' ? 'hide' : 'dim'))}
                title="Toggle unrelated nodes between dimmed and hidden"
              >
                {pathDisplayMode === 'dim' ? <Eye size={13} /> : <EyeOff size={13} />}
                {pathDisplayMode === 'dim' ? 'Dim' : 'Hide'}
              </button>
            )}
          </div>

          <div className="layer-direction" aria-label="Architecture layers">
            <span>ENTRYPOINTS</span>
            <ArrowDown size={12} />
            <span>APPLICATION</span>
            <ArrowDown size={12} />
            <span>SERVICES</span>
            <ArrowDown size={12} />
            <span>INFRASTRUCTURE</span>
          </div>

          {nodes.length ? (
            <ReactFlow<FlowNode, Edge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onInit={setFlow}
              onNodeClick={(_event, node) => focusNode(node.id)}
              fitView
              fitViewOptions={{ padding: 0.22 }}
              minZoom={0.08}
              maxZoom={1.8}
              nodesDraggable={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#293140" />
              <Controls position="bottom-left" showInteractive={false} />
            </ReactFlow>
          ) : (
            <EmptyTopology />
          )}

          {selectedPath && (
            <PathMetrics path={selectedPath} snapshot={snapshot} onNode={focusNode} />
          )}
          {comparison && <ComparisonSummary comparison={comparison} />}
        </section>
      </section>

      {selectedNode && (
        <NodeDrawer
          node={selectedNode}
          snapshot={snapshot}
          onNavigate={focusNode}
          onClose={() => setSelectedNodeId(undefined)}
        />
      )}
      {selectedTrace && (
        <TraceDrawer trace={selectedTrace} onClose={() => setSelectedTraceId(undefined)} />
      )}
    </main>
  );
}

function ScopeNode({ data }: NodeProps<FlowNode>): React.JSX.Element {
  const Icon = iconForType(data.type);
  const style = { '--heat': data.heat.toFixed(2) } as CSSProperties;
  return (
    <div
      style={style}
      className={[
        'scope-node',
        `type-${data.type}`,
        `perspective-${data.perspective}`,
        data.active && 'active',
        data.errorCount && 'has-error',
        data.dimmed && 'dimmed',
        data.onSelectedPath && 'path-selected',
        data.selected && 'selected-node',
        data.diffStatus && `diff-${data.diffStatus}`,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Handle type="target" position={Position.Top} />
      <div className="node-icon">
        <Icon size={17} />
      </div>
      <div className="node-copy">
        <span className="node-type">{labelForType(data.type)}</span>
        <strong title={data.name}>{data.name}</strong>
        <span className="node-stats">
          {formatInteger(data.requestCount)} calls · {formatNumber(data.avgLatencyMs)} ms avg
        </span>
      </div>
      {data.diffStatus && (
        <span className={`diff-marker ${data.diffStatus}`}>{diffSymbol(data.diffStatus)}</span>
      )}
      {data.errorCount > 0 && <span className="node-error">{data.errorCount}</span>}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export function buildFlow({
  snapshot,
  positions,
  selectedPath,
  pathDisplayMode,
  perspective,
  showTrafficLabels,
  selectedNodeId,
  nodeStatuses,
  edgeStatuses,
}: {
  snapshot: TopologySnapshot;
  positions: Map<string, NodePosition>;
  selectedPath?: RuntimePathGroup;
  pathDisplayMode: PathDisplayMode;
  perspective: GraphPerspective;
  showTrafficLabels: boolean;
  selectedNodeId?: string;
  nodeStatuses?: Map<string, DiffStatus>;
  edgeStatuses?: Map<string, DiffStatus>;
}): { nodes: FlowNode[]; edges: Edge[] } {
  const pathNodeIds = new Set(selectedPath?.nodeIds ?? []);
  const pathEdgeKeys = new Set(selectedPath?.edgeKeys ?? []);
  const visibleNodes = new Set(
    snapshot.nodes
      .filter((node) => !selectedPath || pathDisplayMode !== 'hide' || pathNodeIds.has(node.id))
      .map((node) => node.id),
  );
  const maxNodeMetric = Math.max(0, ...snapshot.nodes.map((node) => nodeMetric(node, perspective)));
  const nodes: FlowNode[] = snapshot.nodes
    .filter((node) => visibleNodes.has(node.id))
    .map((node) => ({
      id: node.id,
      type: 'scope',
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: {
        ...node,
        active: snapshot.activity.nodeIds.includes(node.id),
        dimmed: Boolean(selectedPath) && pathDisplayMode === 'dim' && !pathNodeIds.has(node.id),
        onSelectedPath: Boolean(selectedPath) && pathNodeIds.has(node.id),
        selected: node.id === selectedNodeId,
        perspective,
        heat: maxNodeMetric ? nodeMetric(node, perspective) / maxNodeMetric : 0,
        ...(nodeStatuses?.get(node.id) ? { diffStatus: nodeStatuses.get(node.id) } : {}),
      },
    }));
  const edges: Edge[] = snapshot.edges
    .filter((edge) => visibleNodes.has(edge.source) && visibleNodes.has(edge.target))
    .map((edge) => {
      const edgeKey = `${edge.source}->${edge.target}`;
      const onPath = Boolean(selectedPath) && pathEdgeKeys.has(edgeKey);
      const status = edgeStatuses?.get(edge.id);
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        animated: !selectedPath && snapshot.activity.edgeIds.includes(edge.id),
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        ...(showTrafficLabels ? { label: edgeLabel(edge, perspective) } : {}),
        className: [
          'flow-edge',
          `perspective-${perspective}`,
          edge.errorCount && 'error',
          selectedPath && pathDisplayMode === 'dim' && !onPath && 'dimmed',
          onPath && 'path-selected',
          status && `diff-${status}`,
        ]
          .filter(Boolean)
          .join(' '),
        style: { strokeWidth: edgeVisualWeight(snapshot.edges, edge, perspective) },
        labelStyle: { fontSize: 10, fontWeight: 600 },
      };
    });
  return { nodes, edges };
}

function SummaryValue({ value, label }: { value: number; label: string }): React.JSX.Element {
  return (
    <div>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function SnapshotInput({
  label,
  loaded,
  onFile,
}: {
  label: string;
  loaded?: string;
  onFile: (file?: File) => void;
}): React.JSX.Element {
  return (
    <label className="snapshot-input">
      <span>{label}</span>
      <strong>{loaded ? new Date(loaded).toLocaleString() : 'Choose JSON snapshot'}</strong>
      <input
        type="file"
        accept="application/json,.json"
        onChange={(event) => onFile(event.target.files?.[0])}
      />
    </label>
  );
}

function PathMetrics({
  path,
  snapshot,
  onNode,
}: {
  path: RuntimePathGroup;
  snapshot: TopologySnapshot;
  onNode: (id: string) => void;
}): React.JSX.Element {
  const components = path.nodeIds
    .map((id) => snapshot.nodes.find((node) => node.id === id))
    .filter((node): node is TopologyNode => Boolean(node));
  return (
    <aside className="path-metrics">
      <div className="path-metrics-title">
        <span className="eyebrow">SELECTED RUNTIME PATH</span>
        <strong>{path.entrypoint}</strong>
      </div>
      <div className="path-stat-grid">
        <Detail label="Calls" value={formatInteger(path.calls)} />
        <Detail
          label="Average"
          value={path.avgDurationMs === undefined ? '—' : `${formatNumber(path.avgDurationMs)} ms`}
        />
        <Detail
          label="P95"
          value={path.p95DurationMs === undefined ? '—' : `${formatNumber(path.p95DurationMs)} ms`}
        />
        <Detail
          label="Errors"
          value={path.errors === undefined ? '—' : formatInteger(path.errors)}
          error={Boolean(path.errors)}
        />
      </div>
      <div className="path-components">
        {components.map((node, index) => (
          <button type="button" key={node.id} onClick={() => onNode(node.id)}>
            <span>{index + 1}</span>
            {node.name}
          </button>
        ))}
      </div>
      {path.externalSystems.length > 0 && (
        <p className="path-systems">
          Touches {path.externalSystems.map((node) => node.name).join(', ')}
        </p>
      )}
    </aside>
  );
}

function ComparisonSummary({ comparison }: { comparison: SnapshotComparison }): React.JSX.Element {
  const statuses = [...comparison.nodeStatuses.values(), ...comparison.edgeStatuses.values()];
  return (
    <div className="comparison-summary">
      <span>
        <b>+</b> {statuses.filter((status) => status === 'added').length}
      </span>
      <span>
        <b>−</b> {statuses.filter((status) => status === 'removed').length}
      </span>
      <span>
        <b>~</b> {statuses.filter((status) => status === 'changed').length}
      </span>
    </div>
  );
}

function EmptyTopology(): React.JSX.Element {
  return (
    <div className="empty-topology">
      <div className="empty-rings">
        <Layers3 size={28} />
      </div>
      <h2>Waiting for runtime architecture</h2>
      <p>
        Send a request to your application. Executed routes, controllers, services, and dependencies
        will appear in semantic layers.
      </p>
      <code>curl -X POST http://127.0.0.1:3000/payments</code>
    </div>
  );
}

function NodeDrawer({
  node,
  snapshot,
  onNavigate,
  onClose,
}: {
  node: TopologyNode;
  snapshot: TopologySnapshot;
  onNavigate: (id: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <aside className="drawer">
      <div className="drawer-header">
        <div>
          <span className="eyebrow">ARCHITECTURE COMPONENT</span>
          <h2>{node.name}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close node details"
        >
          <X size={18} />
        </button>
      </div>
      <span className={`type-badge type-${node.type}`}>{labelForType(node.type)}</span>
      <div className="detail-grid">
        <Detail label="Calls" value={formatInteger(node.requestCount)} />
        <Detail label="Errors" value={formatInteger(node.errorCount)} error={node.errorCount > 0} />
        <Detail label="Average" value={`${formatNumber(node.avgLatencyMs)} ms`} />
        <Detail label="P95" value={`${formatNumber(node.p95LatencyMs)} ms`} />
      </div>
      <DependencySection
        title="Inbound dependencies"
        rows={dependencyRows(node.id, 'inbound', snapshot)}
        onNavigate={onNavigate}
      />
      <DependencySection
        title="Outbound dependencies"
        rows={dependencyRows(node.id, 'outbound', snapshot)}
        onNavigate={onNavigate}
      />
    </aside>
  );
}

function DependencySection({
  title,
  rows,
  onNavigate,
}: {
  title: string;
  rows: ReturnType<typeof dependencyRows>;
  onNavigate: (id: string) => void;
}): React.JSX.Element {
  return (
    <>
      <h3>{title}</h3>
      <div className="dependency-list">
        {rows.length ? (
          rows.map(({ edge, node, percentage }) => (
            <button type="button" key={edge.id} onClick={() => onNavigate(node.id)}>
              <span>
                {node.name}
                <small>
                  {labelForType(node.type)} · {formatInteger(edge.requestCount)} calls
                </small>
              </span>
              {percentage !== undefined && <strong>{percentage.toFixed(0)}%</strong>}
              <ChevronRight size={14} />
            </button>
          ))
        ) : (
          <span className="muted">None observed.</span>
        )}
      </div>
    </>
  );
}

function TraceList({
  traces,
  onSelect,
}: {
  traces: RecentTrace[];
  onSelect: (id: string) => void;
}): React.JSX.Element {
  return (
    <div className="trace-list">
      {traces.length ? (
        traces.slice(0, 10).map((trace) => (
          <button
            type="button"
            className={`trace-row ${trace.status === 'error' ? 'failed' : ''}`}
            key={trace.id}
            onClick={() => onSelect(trace.id)}
          >
            <span>{trace.name}</span>
            <small>{formatNumber(trace.durationMs)} ms</small>
          </button>
        ))
      ) : (
        <p className="empty-copy">No requests captured yet.</p>
      )}
    </div>
  );
}

function TraceDrawer({
  trace,
  onClose,
}: {
  trace: RecentTrace;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <aside className="drawer trace-drawer">
      <div className="drawer-header">
        <div>
          <span className="eyebrow">TRACE WATERFALL</span>
          <h2>{trace.name}</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close trace">
          <X size={18} />
        </button>
      </div>
      <div className="trace-meta">
        <span>{formatTime(trace.startedAt)}</span>
        <strong>{formatNumber(trace.durationMs)} ms</strong>
      </div>
      <div className="waterfall">
        {trace.spans.map((span) => (
          <TraceBranch key={span.spanId} span={span} trace={trace} depth={0} />
        ))}
      </div>
    </aside>
  );
}

function TraceBranch({
  span,
  trace,
  depth,
}: {
  span: TraceSpan;
  trace: RecentTrace;
  depth: number;
}): React.JSX.Element {
  const offset = Math.max(
    0,
    ((span.startTimeUnixMs - trace.startedAt) / Math.max(trace.durationMs, 1)) * 100,
  );
  const width = Math.max(2, (span.durationMs / Math.max(trace.durationMs, 1)) * 100);
  return (
    <>
      <div
        className={`waterfall-row ${span.status === 'error' ? 'failed' : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
      >
        <div className="waterfall-label">
          <span>{span.name}</span>
          <small>{labelForSpan(span)}</small>
        </div>
        <div className="waterfall-track">
          <span style={{ left: `${offset}%`, width: `${Math.min(width, 100 - offset)}%` }} />
        </div>
        <strong>{formatNumber(span.durationMs)} ms</strong>
      </div>
      {span.children.map((child) => (
        <TraceBranch key={child.spanId} span={child} trace={trace} depth={depth + 1} />
      ))}
    </>
  );
}

function Detail({
  label,
  value,
  error,
}: {
  label: string;
  value: string;
  error?: boolean;
}): React.JSX.Element {
  return (
    <div className={error ? 'detail error' : 'detail'}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function NodeTypeIcon({ type }: { type: TopologyNodeType }): React.JSX.Element {
  const Icon = iconForType(type);
  return <Icon size={14} />;
}

function iconForType(type: TopologyNodeType): typeof Server {
  switch (type) {
    case 'database':
    case 'redis':
      return Database;
    case 'http-route':
    case 'external-http':
      return Server;
    case 'queue':
    case 'worker':
      return Radio;
    case 'controller':
      return Braces;
    case 'service':
      return Box;
  }
}

function labelForType(type: TopologyNodeType): string {
  return {
    'http-route': 'HTTP entrypoint',
    controller: 'NestJS controller',
    service: 'NestJS provider',
    database: 'Database',
    redis: 'Cache',
    queue: 'Queue',
    worker: 'Worker',
    'external-http': 'External service',
  }[type];
}

function labelForSpan(span: TraceSpan): string {
  if (span.kind === 'internal') return 'Framework';
  if (span.kind === 'custom') return 'Custom span';
  return labelForType(span.kind);
}

function nodeMetric(node: TopologyNode, perspective: GraphPerspective): number {
  if (perspective === 'traffic') return node.requestCount;
  if (perspective === 'latency') return node.p95LatencyMs;
  if (perspective === 'errors') return node.errorCount;
  return 0;
}

function edgeLabel(edge: TopologyEdge, perspective: GraphPerspective): string {
  if (perspective === 'latency') return `${formatNumber(edge.p95LatencyMs)} ms p95`;
  if (perspective === 'errors') return `${formatInteger(edge.errorCount)} errors`;
  return `${formatInteger(edge.requestCount)} calls`;
}

function diffSymbol(status: DiffStatus): string {
  return status === 'added' ? '+' : status === 'removed' ? '−' : '~';
}
function formatInteger(value: number): string {
  return new Intl.NumberFormat().format(value);
}
function formatNumber(value: number): string {
  return value < 10 ? value.toFixed(1) : Math.round(value).toString();
}
function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
function methodOf(name: string): string {
  return name.split(' ')[0] ?? 'REQ';
}
function routeOf(name: string): string {
  return name.split(' ').slice(1).join(' ') || name;
}
