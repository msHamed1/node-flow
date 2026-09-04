package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	nodeflowv1 "github.com/msHamed1/node-flow/services/collector/gen/nodeflow/v1"
	collectormetrics "github.com/msHamed1/node-flow/services/collector/internal/metrics"
	"github.com/msHamed1/node-flow/services/collector/internal/pipeline"
	"github.com/msHamed1/node-flow/services/collector/internal/spool"
	"github.com/msHamed1/node-flow/services/collector/internal/telemetry"
	"google.golang.org/protobuf/proto"
)

func TestLegacyJSONCompatibilityAndRedaction(t *testing.T) {
	t.Parallel()
	api, processor, sink := newTestAPI(t)
	defer stopPipeline(t, processor)

	body := `{
		"serviceName":"payments-api",
		"nodeVersion":"v22",
		"spans":[{
			"traceId":"trace-1","spanId":"span-1","name":"POST /payments",
			"kind":"http-route","startTimeUnixMs":1700000000000,"durationMs":12,"status":"ok",
			"attributes":{"http.route":"/payments","http.request.header.authorization":"Bearer secret"}
		}]
	}`
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/spans", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	api.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d", response.Code)
	}
	var acknowledgement map[string]uint64
	if err := json.NewDecoder(response.Body).Decode(&acknowledgement); err != nil {
		t.Fatal(err)
	}
	if acknowledgement["accepted"] != 1 {
		t.Fatalf("unexpected acknowledgement: %#v", acknowledgement)
	}
	if _, exists := acknowledgement["revision"]; exists {
		t.Fatalf("admission acknowledgement must not imply downstream commit: %#v", acknowledgement)
	}

	waitForEnvelopeCount(t, sink, 1)
	sink.mutex.Lock()
	attributes := sink.envelopes[0].SpanBatch.Spans[0].Attributes
	sink.mutex.Unlock()
	if _, exists := attributes["http.request.header.authorization"]; exists {
		t.Fatal("Go ingestion boundary retained an authorization header")
	}
	if attributes["http.route"] != "/payments" {
		t.Fatalf("safe attribute changed: %#v", attributes)
	}
}

func TestProtobufIngestion(t *testing.T) {
	t.Parallel()
	api, processor, sink := newTestAPI(t)
	defer stopPipeline(t, processor)

	payload, err := proto.Marshal(&nodeflowv1.TelemetryEnvelope{
		ProtocolVersion: telemetry.ProtocolVersion,
		Payload: &nodeflowv1.TelemetryEnvelope_SpanBatch{SpanBatch: &nodeflowv1.SpanBatch{
			ServiceName: "payments-api",
			Spans: []*nodeflowv1.TelemetrySpan{{
				TraceId: "trace-1", SpanId: "span-1", Name: "PaymentsService.create",
				Kind: nodeflowv1.SpanKind_SPAN_KIND_SERVICE, Status: nodeflowv1.SpanStatus_SPAN_STATUS_OK,
				StartTimeUnixMs: 1_700_000_000_000, DurationMs: 5,
			}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/telemetry", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/x-protobuf")
	response := httptest.NewRecorder()
	api.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", response.Code, response.Body.String())
	}
	waitForEnvelopeCount(t, sink, 1)
	sink.mutex.Lock()
	defer sink.mutex.Unlock()
	if sink.envelopes[0].SpanBatch.Spans[0].Kind != "service" {
		t.Fatalf("protobuf kind did not cross the boundary: %#v", sink.envelopes)
	}
}

func TestAcceptanceDoesNotWaitForBlockedSink(t *testing.T) {
	t.Parallel()
	metrics := collectormetrics.New()
	sink := &blockingSink{started: make(chan struct{}), release: make(chan struct{})}
	processor, err := pipeline.New(
		pipeline.Config{Workers: 1, QueueSize: 16, BatchSize: 1, FlushInterval: time.Millisecond},
		sink,
		metrics,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		t.Fatal(err)
	}
	api := New(processor, metrics, slog.New(slog.NewTextHandler(io.Discard, nil)), 2*1_024*1_024, "test")
	done := make(chan int, 1)
	go func() {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPost, "/api/spans", bytes.NewBufferString(`{
			"serviceName":"payments-api",
			"spans":[{"traceId":"trace-1","spanId":"span-1","name":"work","kind":"service","startTimeUnixMs":1,"durationMs":1,"status":"ok"}]
		}`))
		request.Header.Set("Content-Type", "application/json")
		api.Handler().ServeHTTP(response, request)
		done <- response.Code
	}()

	select {
	case <-sink.started:
	case <-time.After(time.Second):
		close(sink.release)
		stopPipeline(t, processor)
		t.Fatal("sink did not begin processing")
	}
	select {
	case status := <-done:
		if status != http.StatusAccepted {
			t.Fatalf("expected admission acknowledgement, got %d", status)
		}
	case <-time.After(250 * time.Millisecond):
		close(sink.release)
		<-done
		stopPipeline(t, processor)
		t.Fatal("HTTP acknowledgement waited for the blocked sink")
	}
	close(sink.release)
	stopPipeline(t, processor)
}

func TestDurableSpoolExhaustionReturnsInsufficientStorage(t *testing.T) {
	t.Parallel()
	metrics := collectormetrics.New()
	store, _, err := spool.Open(
		spool.Config{Directory: t.TempDir(), MaxBytes: 1}, metrics,
	)
	if err != nil {
		t.Fatal(err)
	}
	processor, err := pipeline.New(pipeline.Config{
		Workers: 1, QueueSize: 2, BatchSize: 1, FlushInterval: time.Millisecond, Spool: store,
		Retry: pipeline.RetryConfig{
			InitialBackoff: time.Millisecond, MaxBackoff: time.Millisecond, MaxAttempts: 2,
		},
	}, &acknowledgementSink{}, metrics, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	api := New(processor, metrics, slog.New(slog.NewTextHandler(io.Discard, nil)), 2*1_024*1_024, "test")
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/spans", bytes.NewBufferString(`{
		"serviceName":"payments-api",
		"spans":[{"traceId":"trace-1","spanId":"span-1","name":"work","kind":"service","startTimeUnixMs":1,"durationMs":1,"status":"ok"}]
	}`))
	request.Header.Set("Content-Type", "application/json")
	api.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusInsufficientStorage || response.Header().Get("Retry-After") != "5" {
		t.Fatalf("expected durable capacity rejection, got %d headers=%v", response.Code, response.Header())
	}
	stopPipeline(t, processor)
}

func TestMalformedMessagesAreRejected(t *testing.T) {
	t.Parallel()
	api, processor, _ := newTestAPI(t)
	defer stopPipeline(t, processor)

	tests := []struct {
		name        string
		path        string
		contentType string
		body        string
		status      int
	}{
		{"invalid JSON", "/api/spans", "application/json", "{", http.StatusBadRequest},
		{"missing spans", "/api/spans", "application/json", `{"serviceName":"test"}`, http.StatusBadRequest},
		{"invalid runtime", "/api/runtime", "application/json", `{"timestamp":1}`, http.StatusBadRequest},
		{"invalid protobuf", "/v1/telemetry", "application/x-protobuf", "not-protobuf", http.StatusBadRequest},
		{"wrong media type", "/v1/telemetry", "application/json", "{}", http.StatusUnsupportedMediaType},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, test.path, bytes.NewBufferString(test.body))
			request.Header.Set("Content-Type", test.contentType)
			response := httptest.NewRecorder()
			api.Handler().ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("expected %d, got %d", test.status, response.Code)
			}
		})
	}
}

func TestHealthReadyAndMetrics(t *testing.T) {
	t.Parallel()
	api, processor, _ := newTestAPI(t)
	defer stopPipeline(t, processor)

	for _, path := range []string{"/healthz", "/readyz", "/metrics"} {
		response := httptest.NewRecorder()
		api.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s returned %d", path, response.Code)
		}
	}
}

type acknowledgementSink struct {
	mutex     sync.Mutex
	envelopes []telemetry.Envelope
}

type blockingSink struct {
	startOnce sync.Once
	started   chan struct{}
	release   chan struct{}
}

func (sink *blockingSink) ConsumeBatch(_ context.Context, envelopes []telemetry.Envelope) ([]pipeline.Outcome, error) {
	sink.startOnce.Do(func() { close(sink.started) })
	<-sink.release
	return make([]pipeline.Outcome, len(envelopes)), nil
}

func (*blockingSink) Ready(context.Context) error { return nil }
func (*blockingSink) Close() error                { return nil }

func (sink *acknowledgementSink) ConsumeBatch(_ context.Context, envelopes []telemetry.Envelope) ([]pipeline.Outcome, error) {
	sink.mutex.Lock()
	sink.envelopes = append(sink.envelopes, envelopes...)
	sink.mutex.Unlock()
	outcomes := make([]pipeline.Outcome, len(envelopes))
	for index := range outcomes {
		revision := uint64(9)
		outcomes[index].Revision = &revision
	}
	return outcomes, nil
}

func (*acknowledgementSink) Ready(context.Context) error { return nil }
func (*acknowledgementSink) Close() error                { return nil }

func newTestAPI(t *testing.T) (*API, *pipeline.Pipeline, *acknowledgementSink) {
	t.Helper()
	metrics := collectormetrics.New()
	sink := &acknowledgementSink{}
	processor, err := pipeline.New(
		pipeline.Config{Workers: 1, QueueSize: 16, BatchSize: 1, FlushInterval: time.Millisecond},
		sink,
		metrics,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		t.Fatal(err)
	}
	return New(processor, metrics, slog.New(slog.NewTextHandler(io.Discard, nil)), 2*1_024*1_024, "test"), processor, sink
}

func waitForEnvelopeCount(t *testing.T, sink *acknowledgementSink, expected int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		sink.mutex.Lock()
		actual := len(sink.envelopes)
		sink.mutex.Unlock()
		if actual >= expected {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d processed envelopes", expected)
}

func stopPipeline(t *testing.T, processor *pipeline.Pipeline) {
	t.Helper()
	processor.CloseAdmission()
	if err := processor.Wait(context.Background()); err != nil {
		t.Error(err)
	}
}
