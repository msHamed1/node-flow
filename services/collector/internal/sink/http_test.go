package sink

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	collectormetrics "github.com/msHamed1/node-flow/services/collector/internal/metrics"
	"github.com/msHamed1/node-flow/services/collector/internal/telemetry"
)

func TestHTTPSinkGroupsSpansAndKeepsNewestRuntimeSample(t *testing.T) {
	t.Parallel()
	var mutex sync.Mutex
	spanRequests := 0
	runtimeTimestamps := []float64{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		defer mutex.Unlock()
		switch request.URL.Path {
		case "/api/health":
			response.WriteHeader(http.StatusOK)
		case "/api/spans":
			spanRequests++
			var batch telemetry.SpanBatch
			_ = json.NewDecoder(request.Body).Decode(&batch)
			if len(batch.Spans) != 2 {
				t.Errorf("expected two grouped spans, got %d", len(batch.Spans))
			}
			_ = json.NewEncoder(response).Encode(map[string]uint64{"revision": 7})
		case "/api/runtime":
			var metrics telemetry.RuntimeMetrics
			_ = json.NewDecoder(request.Body).Decode(&metrics)
			runtimeTimestamps = append(runtimeTimestamps, metrics.Timestamp)
			response.WriteHeader(http.StatusAccepted)
		case "/api/snapshot":
			_ = json.NewEncoder(response).Encode(map[string]any{
				"nodes": []any{map[string]any{}, map[string]any{}}, "edges": []any{map[string]any{}},
			})
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	metrics := collectormetrics.New()
	httpSink, err := NewHTTP(server.URL, time.Second, metrics, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	envelopes := []telemetry.Envelope{
		spanEnvelope("one"), spanEnvelope("two"), runtimeEnvelope(1), runtimeEnvelope(2),
	}
	outcomes, err := httpSink.ConsumeBatch(context.Background(), envelopes)
	if err != nil {
		t.Fatal(err)
	}
	if spanRequests != 1 || len(runtimeTimestamps) != 1 || runtimeTimestamps[0] != 2 {
		t.Fatalf("unexpected forwarding: span requests=%d runtime=%v", spanRequests, runtimeTimestamps)
	}
	if outcomes[0].Revision == nil || *outcomes[0].Revision != 7 || outcomes[1].Revision == nil {
		t.Fatalf("revision was not propagated: %#v", outcomes)
	}

	recorder := httptest.NewRecorder()
	metrics.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if !strings.Contains(recorder.Body.String(), "nodeflow_collector_topology_nodes 2") ||
		!strings.Contains(recorder.Body.String(), "nodeflow_collector_topology_edges 1") {
		t.Fatalf("topology gauges were not observed:\n%s", recorder.Body.String())
	}
}

func spanEnvelope(id string) telemetry.Envelope {
	return telemetry.Envelope{ProtocolVersion: telemetry.ProtocolVersion, SpanBatch: &telemetry.SpanBatch{
		ServiceName: "payments-api", NodeVersion: "v22",
		Spans: []telemetry.Span{{TraceID: "trace-" + id, SpanID: "span-" + id, Name: id, Kind: "custom", Status: "ok"}},
	}}
}

func runtimeEnvelope(timestamp float64) telemetry.Envelope {
	return telemetry.Envelope{ProtocolVersion: telemetry.ProtocolVersion, RuntimeMetrics: &telemetry.RuntimeMetrics{
		Timestamp: timestamp, ServiceName: "payments-api",
	}}
}
