package topology

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const snapshotVersion = "1.0"

var topologyKinds = map[string]bool{
	"http-route": true, "controller": true, "service": true, "database": true,
	"redis": true, "queue": true, "worker": true, "external-http": true,
}

var traceKinds = map[string]bool{
	"http-route": true, "controller": true, "service": true, "database": true,
	"redis": true, "queue": true, "worker": true, "external-http": true, "custom": true,
}

type Options struct {
	MaxRecentTraces   int
	MaxLatencySamples int
	MaxRuntimePaths   int
	ApplicationName   string
	NodeVersion       string
}

type metricAccumulator struct {
	count          int
	errors         int
	totalLatencyMS float64
	latencies      []float64
}

type nodeState struct {
	id        string
	name      string
	kind      string
	framework string
	operation string
	metrics   metricAccumulator
}

type edgeState struct {
	id      string
	source  string
	target  string
	metrics metricAccumulator
}

type pathState struct {
	id            string
	entrypoint    string
	nodes         []string
	metrics       metricAccumulator
	lastUpdatedAt uint64
}

type pathContribution struct {
	durationMS float64
	failed     bool
}

type traceState struct {
	traceID           string
	spans             map[string]Span
	spanOrder         []string
	lastUpdatedAt     uint64
	pathContributions map[string]pathContribution
}

// Engine uses a single ownership lock for all mutable topology state. Ingest
// performs admission, edge reconciliation, and path replacement atomically;
// snapshots therefore observe either the state before or after a whole batch.
type Engine struct {
	mu sync.RWMutex

	nodes           map[string]*nodeState
	edges           map[string]*edgeState
	paths           map[string]*pathState
	traces          map[string]*traceState
	seenSpanIDs     map[string]bool
	seenEdgeSpanIDs map[string]bool

	maxRecentTraces   int
	maxLatencySamples int
	maxRuntimePaths   int
	applicationNames  map[string]bool
	nodeVersion       string
	clock             uint64
}

func New(options Options) *Engine {
	if options.MaxRecentTraces == 0 {
		options.MaxRecentTraces = 50
	}
	if options.MaxLatencySamples == 0 {
		options.MaxLatencySamples = 1000
	}
	if options.MaxRuntimePaths == 0 {
		options.MaxRuntimePaths = 1000
	}
	if options.NodeVersion == "" {
		options.NodeVersion = "unknown"
	}
	engine := &Engine{
		nodes:             make(map[string]*nodeState),
		edges:             make(map[string]*edgeState),
		paths:             make(map[string]*pathState),
		traces:            make(map[string]*traceState),
		seenSpanIDs:       make(map[string]bool),
		seenEdgeSpanIDs:   make(map[string]bool),
		maxRecentTraces:   options.MaxRecentTraces,
		maxLatencySamples: options.MaxLatencySamples,
		maxRuntimePaths:   options.MaxRuntimePaths,
		applicationNames:  make(map[string]bool),
		nodeVersion:       options.NodeVersion,
	}
	if name := strings.TrimSpace(options.ApplicationName); name != "" {
		engine.applicationNames[name] = true
	}
	return engine
}

func (e *Engine) RegisterApplication(name, nodeVersion string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if name = strings.TrimSpace(name); name != "" {
		e.applicationNames[name] = true
	}
	if nodeVersion = strings.TrimSpace(nodeVersion); nodeVersion != "" {
		e.nodeVersion = nodeVersion
	}
}

func (e *Engine) Ingest(spans []Span) {
	e.mu.Lock()
	defer e.mu.Unlock()

	touched := make([]string, 0, len(spans))
	touchedSet := make(map[string]bool, len(spans))
	for _, span := range spans {
		if !touchedSet[span.TraceID] {
			touchedSet[span.TraceID] = true
			touched = append(touched, span.TraceID)
		}
		if e.seenSpanIDs[span.SpanID] {
			continue
		}
		e.seenSpanIDs[span.SpanID] = true
		trace := e.traces[span.TraceID]
		if trace == nil {
			trace = &traceState{
				traceID:           span.TraceID,
				spans:             make(map[string]Span),
				pathContributions: make(map[string]pathContribution),
			}
			e.traces[span.TraceID] = trace
		}
		if _, exists := trace.spans[span.SpanID]; !exists {
			trace.spanOrder = append(trace.spanOrder, span.SpanID)
		}
		trace.spans[span.SpanID] = span
		e.clock++
		trace.lastUpdatedAt = e.clock
		if node := e.resolveNode(span, true); node != nil {
			e.record(&node.metrics, span.DurationMS, span.Status == "error")
		}
	}

	for _, traceID := range touched {
		trace := e.traces[traceID]
		if trace == nil {
			continue
		}
		for _, spanID := range trace.spanOrder {
			child := trace.spans[spanID]
			if child.ParentSpanID == "" {
				continue
			}
			edgeSpanKey := child.TraceID + ":" + child.SpanID
			if e.seenEdgeSpanIDs[edgeSpanKey] {
				continue
			}
			parentNode := e.findNearestParentNode(trace, child.ParentSpanID)
			childNode := e.resolveNode(child, false)
			if parentNode == nil || childNode == nil || parentNode.id == childNode.id {
				continue
			}
			edgeID := StableEdgeID(parentNode.id, childNode.id)
			edge := e.edges[edgeID]
			if edge == nil {
				edge = &edgeState{id: edgeID, source: parentNode.id, target: childNode.id}
				e.edges[edgeID] = edge
			}
			e.record(&edge.metrics, child.DurationMS, child.Status == "error")
			e.seenEdgeSpanIDs[edgeSpanKey] = true
		}
	}

	for _, traceID := range touched {
		if trace := e.traces[traceID]; trace != nil {
			e.aggregateRuntimePaths(trace)
		}
	}
	e.trimTraces()
}

func (e *Engine) CreateSnapshot() Snapshot {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.snapshotLocked()
}

func (e *Engine) snapshotLocked() Snapshot {
	services := make([]string, 0, len(e.applicationNames))
	for name := range e.applicationNames {
		services = append(services, name)
	}
	sort.Strings(services)

	nodes := make([]Node, 0, len(e.nodes))
	for _, state := range e.nodes {
		nodes = append(nodes, Node{
			ID: state.id, Type: architectureNodeType(state.kind), Name: state.name,
			Framework: state.framework, Metrics: nodeMetrics(state.metrics),
		})
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].ID < nodes[j].ID })

	edges := make([]Edge, 0, len(e.edges))
	for _, state := range e.edges {
		edges = append(edges, Edge{
			ID: state.id, Source: state.source, Target: state.target, Type: "runtime-dependency",
			Metrics: edgeMetrics(state.metrics),
		})
	}
	sort.Slice(edges, func(i, j int) bool { return edges[i].ID < edges[j].ID })

	paths := make([]Path, 0, len(e.paths))
	for _, state := range e.paths {
		paths = append(paths, Path{
			ID: state.id, Entrypoint: state.entrypoint, Nodes: append([]string(nil), state.nodes...),
			Calls: state.metrics.count, Errors: state.metrics.errors,
			AvgDurationMS: average(state.metrics), P95DurationMS: percentile(state.metrics.latencies, .95),
		})
	}
	sort.Slice(paths, func(i, j int) bool {
		if paths[i].Calls != paths[j].Calls {
			return paths[i].Calls > paths[j].Calls
		}
		return paths[i].ID < paths[j].ID
	})

	snapshot := Snapshot{
		Version: snapshotVersion, GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Application: Application{Runtime: "nodejs", NodeVersion: e.nodeVersion},
		Nodes:       nodes, Edges: edges, Paths: paths,
	}
	if len(services) > 0 {
		snapshot.Application.Name = services[0]
	}
	if len(services) > 1 {
		snapshot.Metadata = map[string]any{"serviceNames": services}
	}
	return snapshot
}

func (e *Engine) resolveNode(span Span, create bool) *nodeState {
	if !topologyKinds[span.Kind] {
		return nil
	}
	identity := attributeStringValue(span.Attributes["nodeflow.identity"], span.Name)
	className := stringAttribute(span, "nodeflow.class")
	framework := stringAttribute(span, "nodeflow.framework")
	name := stringAttribute(span, "nodeflow.topology_name")
	if (span.Kind == "controller" || span.Kind == "service") && className != "" {
		name = className
	} else if name == "" {
		name = span.Name
	}
	id := StableNodeID(span.Kind, identity, framework)
	node := e.nodes[id]
	if node == nil && create {
		node = &nodeState{
			id: id, name: name, kind: span.Kind, framework: framework,
			operation: firstNonEmpty(stringAttribute(span, "nodeflow.method"), stringAttribute(span, "nodeflow.operation")),
		}
		e.nodes[id] = node
	}
	return node
}

func (e *Engine) findNearestParentNode(trace *traceState, parentSpanID string) *nodeState {
	current, exists := trace.spans[parentSpanID]
	visited := make(map[string]bool)
	for exists && !visited[current.SpanID] {
		visited[current.SpanID] = true
		if node := e.resolveNode(current, false); node != nil {
			return node
		}
		if current.ParentSpanID == "" {
			break
		}
		current, exists = trace.spans[current.ParentSpanID]
	}
	return nil
}

func (e *Engine) record(metrics *metricAccumulator, durationMS float64, failed bool) {
	metrics.count++
	if failed {
		metrics.errors++
	}
	metrics.totalLatencyMS += durationMS
	metrics.latencies = append(metrics.latencies, durationMS)
	if len(metrics.latencies) > e.maxLatencySamples {
		copy(metrics.latencies, metrics.latencies[1:])
		metrics.latencies = metrics.latencies[:e.maxLatencySamples]
	}
}

func (e *Engine) removeRecord(metrics *metricAccumulator, durationMS float64, failed bool) {
	if metrics.count > 0 {
		metrics.count--
	}
	if failed && metrics.errors > 0 {
		metrics.errors--
	}
	metrics.totalLatencyMS -= durationMS
	if metrics.totalLatencyMS < 0 {
		metrics.totalLatencyMS = 0
	}
	for index, sample := range metrics.latencies {
		if sample == durationMS {
			metrics.latencies = append(metrics.latencies[:index], metrics.latencies[index+1:]...)
			break
		}
	}
}

func (e *Engine) aggregateRuntimePaths(trace *traceState) {
	recent := e.buildTrace(trace)
	if len(recent.roots) == 0 {
		return
	}
	type uniquePath struct {
		entrypoint string
		nodes      []string
	}
	unique := make(map[string]uniquePath)
	uniqueOrder := make([]string, 0)
	for _, root := range recent.roots {
		if root.nodeID == "" || (root.span.Kind != "http-route" && root.span.Kind != "worker" && root.span.Kind != "controller" && root.span.Kind != "service") {
			continue
		}
		for _, nodes := range collectNodePaths(root, nil) {
			if len(nodes) == 0 {
				continue
			}
			key := strings.Join(nodes, ">")
			if _, exists := unique[key]; !exists {
				uniqueOrder = append(uniqueOrder, key)
			}
			unique[key] = uniquePath{entrypoint: root.span.Name, nodes: nodes}
		}
	}

	type desiredPath struct {
		path       uniquePath
		durationMS float64
		failed     bool
	}
	desired := make(map[string]desiredPath, len(unique))
	desiredOrder := make([]string, 0, len(unique))
	for _, key := range uniqueOrder {
		path := unique[key]
		id := stablePathID(path.entrypoint, path.nodes)
		if _, exists := desired[id]; !exists {
			desiredOrder = append(desiredOrder, id)
		}
		desired[id] = desiredPath{path: path, durationMS: recent.durationMS, failed: recent.failed}
	}

	for id, contribution := range trace.pathContributions {
		next, exists := desired[id]
		if exists && next.durationMS == contribution.durationMS && next.failed == contribution.failed {
			continue
		}
		state := e.paths[id]
		if state == nil {
			continue
		}
		e.removeRecord(&state.metrics, contribution.durationMS, contribution.failed)
		if state.metrics.count == 0 {
			delete(e.paths, id)
		}
	}

	nextContributions := make(map[string]pathContribution, len(desired))
	for _, id := range desiredOrder {
		contribution := desired[id]
		nextContributions[id] = pathContribution{durationMS: contribution.durationMS, failed: contribution.failed}
		previous, hadPrevious := trace.pathContributions[id]
		if hadPrevious && previous.durationMS == contribution.durationMS && previous.failed == contribution.failed && e.paths[id] != nil {
			continue
		}
		state := e.paths[id]
		if state == nil {
			if len(e.paths) >= e.maxRuntimePaths {
				e.removeLeastUsefulPath()
			}
			state = &pathState{id: id, entrypoint: contribution.path.entrypoint, nodes: append([]string(nil), contribution.path.nodes...)}
			e.paths[id] = state
		}
		e.record(&state.metrics, contribution.durationMS, contribution.failed)
		e.clock++
		state.lastUpdatedAt = e.clock
	}
	trace.pathContributions = nextContributions
}

func (e *Engine) removeLeastUsefulPath() {
	var candidate *pathState
	for _, state := range e.paths {
		if candidate == nil || state.metrics.count < candidate.metrics.count ||
			(state.metrics.count == candidate.metrics.count && state.lastUpdatedAt < candidate.lastUpdatedAt) {
			candidate = state
		}
	}
	if candidate != nil {
		delete(e.paths, candidate.id)
	}
}

func (e *Engine) trimTraces() {
	if len(e.traces) <= e.maxRecentTraces {
		return
	}
	ordered := make([]*traceState, 0, len(e.traces))
	for _, trace := range e.traces {
		ordered = append(ordered, trace)
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].lastUpdatedAt < ordered[j].lastUpdatedAt })
	for _, trace := range ordered[:len(e.traces)-e.maxRecentTraces] {
		delete(e.traces, trace.traceID)
		for _, spanID := range trace.spanOrder {
			delete(e.seenSpanIDs, spanID)
			delete(e.seenEdgeSpanIDs, trace.traceID+":"+spanID)
		}
	}
}

type traceSpan struct {
	span     Span
	nodeID   string
	children []*traceSpan
}

type builtTrace struct {
	roots      []*traceSpan
	durationMS float64
	failed     bool
}

func (e *Engine) buildTrace(trace *traceState) builtTrace {
	traceSpans := make(map[string]*traceSpan)
	for _, spanID := range trace.spanOrder {
		span := trace.spans[spanID]
		if !traceKinds[span.Kind] {
			continue
		}
		item := &traceSpan{span: span}
		if topologyKinds[span.Kind] {
			item.nodeID = StableNodeID(span.Kind, attributeStringValue(span.Attributes["nodeflow.identity"], span.Name), stringAttribute(span, "nodeflow.framework"))
		}
		traceSpans[spanID] = item
	}

	roots := make([]*traceSpan, 0)
	for _, spanID := range trace.spanOrder {
		item := traceSpans[spanID]
		if item == nil {
			continue
		}
		if parent := findNearestTraceParent(item.span, trace.spans, traceSpans); parent != nil {
			parent.children = append(parent.children, item)
		} else {
			roots = append(roots, item)
		}
	}
	sortTraceSpans(roots)

	earliest := 0.0
	latest := 0.0
	first := true
	failed := false
	for _, spanID := range trace.spanOrder {
		span := trace.spans[spanID]
		if first || span.StartTimeUnixMS < earliest {
			earliest = span.StartTimeUnixMS
		}
		end := span.StartTimeUnixMS + span.DurationMS
		if first || end > latest {
			latest = end
		}
		first = false
		failed = failed || span.Status == "error"
	}
	return builtTrace{roots: roots, durationMS: round(latest - earliest), failed: failed}
}

func findNearestTraceParent(span Span, allSpans map[string]Span, topologySpans map[string]*traceSpan) *traceSpan {
	parentID := span.ParentSpanID
	visited := make(map[string]bool)
	for parentID != "" && !visited[parentID] {
		visited[parentID] = true
		if parent := topologySpans[parentID]; parent != nil {
			return parent
		}
		parent, exists := allSpans[parentID]
		if !exists {
			return nil
		}
		parentID = parent.ParentSpanID
	}
	return nil
}

func sortTraceSpans(spans []*traceSpan) {
	sort.SliceStable(spans, func(i, j int) bool { return spans[i].span.StartTimeUnixMS < spans[j].span.StartTimeUnixMS })
	for _, span := range spans {
		sortTraceSpans(span.children)
	}
}

func collectNodePaths(span *traceSpan, parentNodes []string) [][]string {
	nodes := append([]string(nil), parentNodes...)
	if span.nodeID != "" && (len(nodes) == 0 || nodes[len(nodes)-1] != span.nodeID) {
		nodes = append(nodes, span.nodeID)
	}
	if len(span.children) == 0 {
		return [][]string{nodes}
	}
	paths := make([][]string, 0)
	for _, child := range span.children {
		paths = append(paths, collectNodePaths(child, nodes)...)
	}
	return paths
}

func nodeMetrics(metrics metricAccumulator) NodeMetrics {
	return NodeMetrics{
		CallCount: metrics.count, ErrorCount: metrics.errors, AvgDurationMS: average(metrics),
		P50DurationMS: percentile(metrics.latencies, .5), P95DurationMS: percentile(metrics.latencies, .95),
		P99DurationMS: percentile(metrics.latencies, .99),
	}
}

func edgeMetrics(metrics metricAccumulator) EdgeMetrics {
	return EdgeMetrics{
		CallCount: metrics.count, ErrorCount: metrics.errors, AvgDurationMS: average(metrics),
		P95DurationMS: percentile(metrics.latencies, .95),
	}
}

func average(metrics metricAccumulator) float64 {
	if metrics.count == 0 {
		return 0
	}
	return round(metrics.totalLatencyMS / float64(metrics.count))
}

func architectureNodeType(kind string) string {
	return map[string]string{
		"http-route": "http", "controller": "controller", "service": "service",
		"database": "database", "redis": "cache", "queue": "queue",
		"worker": "provider", "external-http": "external-service",
	}[kind]
}

func stringAttribute(span Span, key string) string {
	value, _ := span.Attributes[key].(string)
	return value
}

func attributeStringValue(value any, fallback string) string {
	if value == nil {
		return fallback
	}
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(typed), 'f', -1, 32)
	case bool:
		return strconv.FormatBool(typed)
	case int:
		return strconv.Itoa(typed)
	default:
		return fmt.Sprint(typed)
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func sortFloat64s(values []float64) {
	sort.Float64s(values)
}
