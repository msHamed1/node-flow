package topology

import (
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

const persistedStateVersion = 1

// StateStore atomically checkpoints the derived topology state. A sink must
// complete this checkpoint before the corresponding telemetry is removed from
// the collector WAL.
type StateStore struct {
	path string
	mu   sync.Mutex
}

type persistedState struct {
	Version           int              `json:"version"`
	Checksum          uint32           `json:"checksum"`
	Nodes             []persistedNode  `json:"nodes"`
	Edges             []persistedEdge  `json:"edges"`
	Paths             []persistedPath  `json:"paths"`
	Traces            []persistedTrace `json:"traces"`
	SeenSpanIDs       []string         `json:"seenSpanIds"`
	SeenEdgeSpanIDs   []string         `json:"seenEdgeSpanIds"`
	ApplicationNames  []string         `json:"applicationNames"`
	NodeVersion       string           `json:"nodeVersion"`
	Clock             uint64           `json:"clock"`
	Revision          uint64           `json:"revision"`
	Runtime           *RuntimeMetrics  `json:"runtime,omitempty"`
	Activity          Activity         `json:"activity"`
	MaxRecentTraces   int              `json:"maxRecentTraces"`
	MaxLatencySamples int              `json:"maxLatencySamples"`
	MaxRuntimePaths   int              `json:"maxRuntimePaths"`
}

type persistedMetric struct {
	Count          int       `json:"count"`
	Errors         int       `json:"errors"`
	TotalLatencyMS float64   `json:"totalLatencyMs"`
	Latencies      []float64 `json:"latencies"`
}

type persistedNode struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Kind      string          `json:"kind"`
	Framework string          `json:"framework,omitempty"`
	Operation string          `json:"operation,omitempty"`
	Metrics   persistedMetric `json:"metrics"`
}

type persistedEdge struct {
	ID      string          `json:"id"`
	Source  string          `json:"source"`
	Target  string          `json:"target"`
	Metrics persistedMetric `json:"metrics"`
}

type persistedPath struct {
	ID            string          `json:"id"`
	Entrypoint    string          `json:"entrypoint"`
	Nodes         []string        `json:"nodes"`
	Metrics       persistedMetric `json:"metrics"`
	LastUpdatedAt uint64          `json:"lastUpdatedAt"`
}

type persistedContribution struct {
	DurationMS float64 `json:"durationMs"`
	Failed     bool    `json:"failed"`
}

type persistedTrace struct {
	TraceID           string                           `json:"traceId"`
	Spans             []Span                           `json:"spans"`
	LastUpdatedAt     uint64                           `json:"lastUpdatedAt"`
	PathContributions map[string]persistedContribution `json:"pathContributions"`
}

// OpenStateStore restores a previous checkpoint when present. Corrupt or
// unsupported state is returned as an error instead of silently starting with
// an empty topology.
func OpenStateStore(path string, options Options) (*Engine, *StateStore, error) {
	store := &StateStore{path: path}
	stale, err := filepath.Glob(filepath.Join(filepath.Dir(path), ".topology-state-*"))
	if err != nil {
		return nil, nil, fmt.Errorf("find incomplete topology checkpoints: %w", err)
	}
	for _, temporaryPath := range stale {
		if err := os.Remove(temporaryPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, nil, fmt.Errorf("remove incomplete topology checkpoint: %w", err)
		}
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return New(options), store, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("read topology state: %w", err)
	}
	var state persistedState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, nil, fmt.Errorf("decode topology state: %w", err)
	}
	if state.Version != persistedStateVersion {
		return nil, nil, fmt.Errorf("unsupported topology state version %d", state.Version)
	}
	checksum := state.Checksum
	state.Checksum = 0
	canonical, err := json.Marshal(state)
	if err != nil || checksum == 0 || crc32.ChecksumIEEE(canonical) != checksum {
		return nil, nil, fmt.Errorf("topology state checksum mismatch")
	}
	state.Checksum = checksum
	engine, err := restoreState(state, options)
	if err != nil {
		return nil, nil, err
	}
	return engine, store, nil
}

func (store *StateStore) Save(engine *Engine) (int64, error) {
	store.mu.Lock()
	defer store.mu.Unlock()

	state := engine.persistedState()
	canonical, err := json.Marshal(state)
	if err != nil {
		return 0, fmt.Errorf("encode topology state for checksum: %w", err)
	}
	state.Checksum = crc32.ChecksumIEEE(canonical)
	data, err := json.Marshal(state)
	if err != nil {
		return 0, fmt.Errorf("encode topology state: %w", err)
	}
	directory := filepath.Dir(store.path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return 0, fmt.Errorf("create topology state directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".topology-state-*")
	if err != nil {
		return 0, fmt.Errorf("create topology state checkpoint: %w", err)
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}
	if err := temporary.Chmod(0o600); err != nil {
		cleanup()
		return 0, fmt.Errorf("secure topology state checkpoint: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		cleanup()
		return 0, fmt.Errorf("write topology state checkpoint: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		cleanup()
		return 0, fmt.Errorf("sync topology state checkpoint: %w", err)
	}
	if err := temporary.Close(); err != nil {
		cleanup()
		return 0, fmt.Errorf("close topology state checkpoint: %w", err)
	}
	if err := os.Rename(temporaryPath, store.path); err != nil {
		cleanup()
		return 0, fmt.Errorf("install topology state checkpoint: %w", err)
	}
	directoryHandle, err := os.Open(directory)
	if err != nil {
		return 0, fmt.Errorf("open topology state directory: %w", err)
	}
	defer directoryHandle.Close()
	if err := directoryHandle.Sync(); err != nil {
		return 0, fmt.Errorf("sync topology state directory: %w", err)
	}
	return int64(len(data)), nil
}

func (e *Engine) persistedState() persistedState {
	e.mu.RLock()
	defer e.mu.RUnlock()

	state := persistedState{
		Version: persistedStateVersion, NodeVersion: e.nodeVersion, Clock: e.clock,
		Revision: e.revision, Activity: Activity{
			NodeIDs: append([]string{}, e.activity.NodeIDs...), EdgeIDs: append([]string{}, e.activity.EdgeIDs...),
		},
		MaxRecentTraces: e.maxRecentTraces, MaxLatencySamples: e.maxLatencySamples,
		MaxRuntimePaths: e.maxRuntimePaths,
	}
	if e.runtime != nil {
		copy := *e.runtime
		state.Runtime = &copy
	}
	for name := range e.applicationNames {
		state.ApplicationNames = append(state.ApplicationNames, name)
	}
	for id := range e.seenSpanIDs {
		state.SeenSpanIDs = append(state.SeenSpanIDs, id)
	}
	for id := range e.seenEdgeSpanIDs {
		state.SeenEdgeSpanIDs = append(state.SeenEdgeSpanIDs, id)
	}
	sort.Strings(state.ApplicationNames)
	sort.Strings(state.SeenSpanIDs)
	sort.Strings(state.SeenEdgeSpanIDs)

	for _, node := range e.nodes {
		state.Nodes = append(state.Nodes, persistedNode{
			ID: node.id, Name: node.name, Kind: node.kind, Framework: node.framework,
			Operation: node.operation, Metrics: persistMetric(node.metrics),
		})
	}
	for _, edge := range e.edges {
		state.Edges = append(state.Edges, persistedEdge{
			ID: edge.id, Source: edge.source, Target: edge.target, Metrics: persistMetric(edge.metrics),
		})
	}
	for _, path := range e.paths {
		state.Paths = append(state.Paths, persistedPath{
			ID: path.id, Entrypoint: path.entrypoint, Nodes: append([]string{}, path.nodes...),
			Metrics: persistMetric(path.metrics), LastUpdatedAt: path.lastUpdatedAt,
		})
	}
	for _, trace := range e.traces {
		item := persistedTrace{
			TraceID: trace.traceID, LastUpdatedAt: trace.lastUpdatedAt,
			PathContributions: make(map[string]persistedContribution, len(trace.pathContributions)),
		}
		for _, spanID := range trace.spanOrder {
			item.Spans = append(item.Spans, trace.spans[spanID])
		}
		for id, contribution := range trace.pathContributions {
			item.PathContributions[id] = persistedContribution{DurationMS: contribution.durationMS, Failed: contribution.failed}
		}
		state.Traces = append(state.Traces, item)
	}
	sort.Slice(state.Nodes, func(i, j int) bool { return state.Nodes[i].ID < state.Nodes[j].ID })
	sort.Slice(state.Edges, func(i, j int) bool { return state.Edges[i].ID < state.Edges[j].ID })
	sort.Slice(state.Paths, func(i, j int) bool { return state.Paths[i].ID < state.Paths[j].ID })
	sort.Slice(state.Traces, func(i, j int) bool { return state.Traces[i].TraceID < state.Traces[j].TraceID })
	return state
}

func restoreState(state persistedState, options Options) (*Engine, error) {
	if state.MaxRecentTraces > 0 {
		options.MaxRecentTraces = state.MaxRecentTraces
	}
	if state.MaxLatencySamples > 0 {
		options.MaxLatencySamples = state.MaxLatencySamples
	}
	if state.MaxRuntimePaths > 0 {
		options.MaxRuntimePaths = state.MaxRuntimePaths
	}
	if state.NodeVersion != "" {
		options.NodeVersion = state.NodeVersion
	}
	engine := New(options)
	engine.clock = state.Clock
	engine.revision = state.Revision
	engine.activity = Activity{NodeIDs: append([]string{}, state.Activity.NodeIDs...), EdgeIDs: append([]string{}, state.Activity.EdgeIDs...)}
	if state.Runtime != nil {
		copy := *state.Runtime
		engine.runtime = &copy
	}
	for _, name := range state.ApplicationNames {
		engine.applicationNames[name] = true
	}
	for _, id := range state.SeenSpanIDs {
		engine.seenSpanIDs[id] = true
	}
	for _, id := range state.SeenEdgeSpanIDs {
		engine.seenEdgeSpanIDs[id] = true
	}
	for _, node := range state.Nodes {
		if node.ID == "" || engine.nodes[node.ID] != nil {
			return nil, fmt.Errorf("invalid or duplicate persisted topology node %q", node.ID)
		}
		engine.nodes[node.ID] = &nodeState{id: node.ID, name: node.Name, kind: node.Kind, framework: node.Framework, operation: node.Operation, metrics: restoreMetric(node.Metrics)}
	}
	for _, edge := range state.Edges {
		if edge.ID == "" || engine.edges[edge.ID] != nil {
			return nil, fmt.Errorf("invalid or duplicate persisted topology edge %q", edge.ID)
		}
		engine.edges[edge.ID] = &edgeState{id: edge.ID, source: edge.Source, target: edge.Target, metrics: restoreMetric(edge.Metrics)}
	}
	for _, path := range state.Paths {
		if path.ID == "" || engine.paths[path.ID] != nil {
			return nil, fmt.Errorf("invalid or duplicate persisted topology path %q", path.ID)
		}
		engine.paths[path.ID] = &pathState{id: path.ID, entrypoint: path.Entrypoint, nodes: append([]string{}, path.Nodes...), metrics: restoreMetric(path.Metrics), lastUpdatedAt: path.LastUpdatedAt}
	}
	for _, trace := range state.Traces {
		if trace.TraceID == "" || engine.traces[trace.TraceID] != nil {
			return nil, fmt.Errorf("invalid or duplicate persisted topology trace %q", trace.TraceID)
		}
		restored := &traceState{traceID: trace.TraceID, spans: make(map[string]Span), pathContributions: make(map[string]pathContribution), lastUpdatedAt: trace.LastUpdatedAt}
		for _, span := range trace.Spans {
			if span.SpanID == "" || restored.spans[span.SpanID].SpanID != "" {
				return nil, fmt.Errorf("invalid or duplicate persisted span %q", span.SpanID)
			}
			restored.spans[span.SpanID] = span
			restored.spanOrder = append(restored.spanOrder, span.SpanID)
		}
		for id, contribution := range trace.PathContributions {
			restored.pathContributions[id] = pathContribution{durationMS: contribution.DurationMS, failed: contribution.Failed}
		}
		engine.traces[trace.TraceID] = restored
	}
	return engine, nil
}

func persistMetric(metric metricAccumulator) persistedMetric {
	return persistedMetric{Count: metric.count, Errors: metric.errors, TotalLatencyMS: metric.totalLatencyMS, Latencies: append([]float64{}, metric.latencies...)}
}

func restoreMetric(metric persistedMetric) metricAccumulator {
	return metricAccumulator{count: metric.Count, errors: metric.Errors, totalLatencyMS: metric.TotalLatencyMS, latencies: append([]float64{}, metric.Latencies...)}
}
