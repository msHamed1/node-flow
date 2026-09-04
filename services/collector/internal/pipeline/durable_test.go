package pipeline

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	collectormetrics "github.com/msHamed1/node-flow/services/collector/internal/metrics"
	"github.com/msHamed1/node-flow/services/collector/internal/spool"
	"github.com/msHamed1/node-flow/services/collector/internal/telemetry"
)

func TestDurablePipelineRetriesOutageAndPreservesServiceOrder(t *testing.T) {
	t.Parallel()
	metrics := collectormetrics.New()
	store := openTestSpool(t, metrics)
	sink := &recoveringSink{failures: 1, delivered: make(chan struct{}, 2)}
	processor := newDurablePipeline(t, store, sink, metrics, 5)

	if err := processor.Enqueue(context.Background(), namedEnvelope("one")); err != nil {
		t.Fatal(err)
	}
	if err := processor.Enqueue(context.Background(), namedEnvelope("two")); err != nil {
		t.Fatal(err)
	}
	processor.CloseAdmission()
	if err := processor.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}

	sink.mutex.Lock()
	calls := append([]string(nil), sink.calls...)
	sink.mutex.Unlock()
	if strings.Join(calls, ",") != "one,one,two" {
		t.Fatalf("retry reordered service records: %v", calls)
	}
	if stats := store.Stats(); stats.ActiveRecords != 0 {
		t.Fatalf("successful records remain active: %#v", stats)
	}
	metricsText := scrapeMetrics(metrics)
	if !strings.Contains(metricsText, "nodeflow_collector_spool_retries_total 1") {
		t.Fatalf("retry metric not recorded:\n%s", metricsText)
	}
}

func TestDurablePipelineReplaysUnacknowledgedRecordsAfterCrashRestart(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	first, _, err := spool.Open(spool.Config{Directory: directory, MaxBytes: 1024 * 1024}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.Append(context.Background(), namedEnvelope("before-crash")); err != nil {
		t.Fatal(err)
	}
	// Closing without acknowledging models the durable state left by an abrupt
	// process exit after the client received 202.
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}

	metrics := collectormetrics.New()
	restarted, recovery, err := spool.Open(
		spool.Config{Directory: directory, MaxBytes: 1024 * 1024}, metrics,
	)
	if err != nil {
		t.Fatal(err)
	}
	if recovery.Records != 1 {
		t.Fatalf("expected one replay record, got %#v", recovery)
	}
	metrics.RecordSpoolReplay(uint64(recovery.Records))
	sink := &recoveringSink{delivered: make(chan struct{}, 1)}
	processor := newDurablePipeline(t, restarted, sink, metrics, 5)
	processor.CloseAdmission()
	if err := processor.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}

	sink.mutex.Lock()
	calls := append([]string(nil), sink.calls...)
	sink.mutex.Unlock()
	if strings.Join(calls, ",") != "before-crash" {
		t.Fatalf("unexpected replay calls: %v", calls)
	}
	if !strings.Contains(scrapeMetrics(metrics), "nodeflow_collector_spool_replayed_total 1") {
		t.Fatal("replay metric was not recorded")
	}
}

func TestDurablePipelineQuarantinesPermanentSinkFailure(t *testing.T) {
	t.Parallel()
	metrics := collectormetrics.New()
	store := openTestSpool(t, metrics)
	sink := &recoveringSink{permanent: true, delivered: make(chan struct{}, 1)}
	processor := newDurablePipeline(t, store, sink, metrics, 5)
	if err := processor.Enqueue(context.Background(), namedEnvelope("poison")); err != nil {
		t.Fatal(err)
	}
	processor.CloseAdmission()
	if err := processor.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	if stats := store.Stats(); stats.ActiveRecords != 0 || stats.QuarantinedRecords != 1 {
		t.Fatalf("permanent failure was not quarantined: %#v", stats)
	}
	metricsText := scrapeMetrics(metrics)
	for _, expected := range []string{
		"nodeflow_collector_spool_permanent_failures_total 1",
		"nodeflow_collector_spool_dropped_total 1",
	} {
		if !strings.Contains(metricsText, expected) {
			t.Fatalf("missing %q:\n%s", expected, metricsText)
		}
	}
}

func TestDurablePipelineQuarantinesAfterRetryBudget(t *testing.T) {
	t.Parallel()
	metrics := collectormetrics.New()
	store := openTestSpool(t, metrics)
	sink := &recoveringSink{failures: 10, delivered: make(chan struct{}, 1)}
	processor := newDurablePipeline(t, store, sink, metrics, 3)
	if err := processor.Enqueue(context.Background(), namedEnvelope("exhausted")); err != nil {
		t.Fatal(err)
	}
	processor.CloseAdmission()
	if err := processor.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	sink.mutex.Lock()
	callCount := len(sink.calls)
	sink.mutex.Unlock()
	if callCount != 3 {
		t.Fatalf("expected three delivery attempts, got %d", callCount)
	}
	if stats := store.Stats(); stats.QuarantinedRecords != 1 {
		t.Fatalf("exhausted record was not quarantined: %#v", stats)
	}
}

func TestDurablePipelineLeavesActiveRecordWhenShutdownDeadlineExpires(t *testing.T) {
	t.Parallel()
	metrics := collectormetrics.New()
	store := openTestSpool(t, metrics)
	sink := &cancellationSink{entered: make(chan struct{})}
	processor := newDurablePipeline(t, store, sink, metrics, 5)
	if err := processor.Enqueue(context.Background(), namedEnvelope("shutdown")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-sink.entered:
	case <-time.After(time.Second):
		t.Fatal("worker did not start delivery")
	}
	processor.CloseAdmission()
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	if err := processor.Wait(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected shutdown deadline, got %v", err)
	}
	if stats := store.Stats(); stats.ActiveRecords != 1 {
		t.Fatalf("shutdown deadline lost durable record: %#v", stats)
	}
}

type recoveringSink struct {
	mutex     sync.Mutex
	failures  int
	permanent bool
	calls     []string
	delivered chan struct{}
}

func (sink *recoveringSink) ConsumeBatch(_ context.Context, envelopes []telemetry.Envelope) ([]Outcome, error) {
	sink.mutex.Lock()
	name := envelopes[0].SpanBatch.Spans[0].Name
	sink.calls = append(sink.calls, name)
	if sink.permanent {
		sink.mutex.Unlock()
		return nil, permanentTestError{}
	}
	if sink.failures > 0 {
		sink.failures--
		sink.mutex.Unlock()
		return nil, errors.New("sink unavailable")
	}
	sink.mutex.Unlock()
	select {
	case sink.delivered <- struct{}{}:
	default:
	}
	return make([]Outcome, len(envelopes)), nil
}

func (*recoveringSink) Ready(context.Context) error { return nil }
func (*recoveringSink) Close() error                { return nil }

type permanentTestError struct{}

func (permanentTestError) Error() string   { return "invalid downstream record" }
func (permanentTestError) Permanent() bool { return true }

type cancellationSink struct {
	entered chan struct{}
}

func (sink *cancellationSink) ConsumeBatch(ctx context.Context, _ []telemetry.Envelope) ([]Outcome, error) {
	close(sink.entered)
	<-ctx.Done()
	return nil, ctx.Err()
}

func (*cancellationSink) Ready(context.Context) error { return nil }
func (*cancellationSink) Close() error                { return nil }

func openTestSpool(t *testing.T, metrics *collectormetrics.Collector) *spool.Store {
	t.Helper()
	store, _, err := spool.Open(
		spool.Config{Directory: t.TempDir(), MaxBytes: 1024 * 1024}, metrics,
	)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func newDurablePipeline(
	t *testing.T,
	store *spool.Store,
	sink Sink,
	metrics *collectormetrics.Collector,
	maxAttempts int,
) *Pipeline {
	t.Helper()
	processor, err := New(Config{
		Workers: 2, QueueSize: 8, BatchSize: 1, FlushInterval: time.Millisecond, Spool: store,
		Retry: RetryConfig{
			InitialBackoff: time.Millisecond, MaxBackoff: 5 * time.Millisecond,
			MaxAttempts: maxAttempts, Jitter: 0,
		},
	}, sink, metrics, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return processor
}

func namedEnvelope(name string) telemetry.Envelope {
	return telemetry.Envelope{
		ProtocolVersion: telemetry.ProtocolVersion,
		SpanBatch: &telemetry.SpanBatch{ServiceName: "payments-api", Spans: []telemetry.Span{{
			TraceID: "trace-" + name, SpanID: "span-" + name, Name: name,
			Kind: "service", Status: "ok", DurationMS: 1,
		}}},
	}
}

func scrapeMetrics(metrics *collectormetrics.Collector) string {
	response := httptest.NewRecorder()
	metrics.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/metrics", nil))
	return response.Body.String()
}
