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
