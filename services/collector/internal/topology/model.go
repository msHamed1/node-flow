package topology

// Span is the language-neutral telemetry input consumed by the experimental
// topology engine. It intentionally mirrors the NodeFlow v1 span contract.
type Span struct {
	TraceID         string         `json:"traceId"`
	SpanID          string         `json:"spanId"`
	ParentSpanID    string         `json:"parentSpanId,omitempty"`
	Name            string         `json:"name"`
	Kind            string         `json:"kind"`
	StartTimeUnixMS float64        `json:"startTimeUnixMs"`
	DurationMS      float64        `json:"durationMs"`
	Status          string         `json:"status"`
	Attributes      map[string]any `json:"attributes,omitempty"`
}

type RuntimeMetrics struct {
	Timestamp            float64 `json:"timestamp"`
	ServiceName          string  `json:"serviceName"`
	RSSBytes             uint64  `json:"rssBytes"`
	HeapUsedBytes        uint64  `json:"heapUsedBytes"`
	HeapTotalBytes       uint64  `json:"heapTotalBytes"`
	CPUPercent           float64 `json:"cpuPercent"`
	EventLoopUtilization float64 `json:"eventLoopUtilization"`
	UptimeSeconds        float64 `json:"uptimeSeconds"`
}

type MetricSummary struct {
	RequestCount int     `json:"requestCount"`
	ErrorCount   int     `json:"errorCount"`
	ErrorRate    float64 `json:"errorRate"`
	AvgLatencyMS float64 `json:"avgLatencyMs"`
	P50LatencyMS float64 `json:"p50LatencyMs"`
	P95LatencyMS float64 `json:"p95LatencyMs"`
	P99LatencyMS float64 `json:"p99LatencyMs"`
}

type LiveNode struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Framework string `json:"framework,omitempty"`
	Operation string `json:"operation,omitempty"`
	MetricSummary
}

type LiveEdge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
	MetricSummary
}

type TraceSpan struct {
	Span
	NodeID   string      `json:"nodeId,omitempty"`
	Children []TraceSpan `json:"children"`
}

type RecentTrace struct {
	ID        string      `json:"id"`
	Name      string      `json:"name"`
	StartedAt float64     `json:"startedAt"`
	Duration  float64     `json:"durationMs"`
	Status    string      `json:"status"`
	Spans     []TraceSpan `json:"spans"`
}

type Activity struct {
	NodeIDs []string `json:"nodeIds"`
	EdgeIDs []string `json:"edgeIds"`
}

type LiveSnapshot struct {
	Revision    uint64          `json:"revision"`
	GeneratedAt int64           `json:"generatedAt"`
	Nodes       []LiveNode      `json:"nodes"`
	Edges       []LiveEdge      `json:"edges"`
	Paths       []Path          `json:"paths"`
	Traces      []RecentTrace   `json:"traces"`
	Runtime     *RuntimeMetrics `json:"runtime,omitempty"`
	Activity    Activity        `json:"activity"`
}

type NodeMetrics struct {
	CallCount     int     `json:"callCount"`
	ErrorCount    int     `json:"errorCount"`
	AvgDurationMS float64 `json:"avgDurationMs"`
	P50DurationMS float64 `json:"p50DurationMs"`
	P95DurationMS float64 `json:"p95DurationMs"`
	P99DurationMS float64 `json:"p99DurationMs"`
}

type EdgeMetrics struct {
	CallCount     int     `json:"callCount"`
	ErrorCount    int     `json:"errorCount"`
	AvgDurationMS float64 `json:"avgDurationMs"`
	P95DurationMS float64 `json:"p95DurationMs"`
}

type Node struct {
	ID        string      `json:"id"`
	Type      string      `json:"type"`
	Name      string      `json:"name"`
	Framework string      `json:"framework,omitempty"`
	Metrics   NodeMetrics `json:"metrics"`
}

type Edge struct {
	ID      string      `json:"id"`
	Source  string      `json:"source"`
	Target  string      `json:"target"`
	Type    string      `json:"type"`
	Metrics EdgeMetrics `json:"metrics"`
}

type Path struct {
	ID            string   `json:"id"`
	Entrypoint    string   `json:"entrypoint"`
	Nodes         []string `json:"nodes"`
	Calls         int      `json:"calls"`
	AvgDurationMS float64  `json:"avgDurationMs"`
	P95DurationMS float64  `json:"p95DurationMs"`
	Errors        int      `json:"errors"`
}

type Application struct {
	Name        string `json:"name,omitempty"`
	Runtime     string `json:"runtime"`
	NodeVersion string `json:"nodeVersion"`
}

// Snapshot mirrors the stable NodeFlow architecture snapshot. GeneratedAt is
// volatile and deliberately excluded by the differential canonicalizer.
type Snapshot struct {
	Version     string         `json:"version"`
	GeneratedAt string         `json:"generatedAt"`
	Application Application    `json:"application"`
	Nodes       []Node         `json:"nodes"`
	Edges       []Edge         `json:"edges"`
	Paths       []Path         `json:"paths"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}
