package telemetry

const ProtocolVersion = "1.0"

type Envelope struct {
	ProtocolVersion string          `json:"protocolVersion"`
	SpanBatch       *SpanBatch      `json:"spanBatch,omitempty"`
	RuntimeMetrics  *RuntimeMetrics `json:"runtimeMetrics,omitempty"`
}

type SpanBatch struct {
	ServiceName string `json:"serviceName"`
	NodeVersion string `json:"nodeVersion,omitempty"`
	Spans       []Span `json:"spans"`
}

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

func (e Envelope) EventCount() uint64 {
	if e.SpanBatch != nil {
		return uint64(len(e.SpanBatch.Spans))
	}
	if e.RuntimeMetrics != nil {
		return 1
	}
	return 0
}
