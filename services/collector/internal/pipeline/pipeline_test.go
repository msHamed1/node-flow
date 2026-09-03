package pipeline

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	collectormetrics "github.com/msHamed1/node-flow/services/collector/internal/metrics"
	"github.com/msHamed1/node-flow/services/collector/internal/telemetry"
)

func TestPipelineBatchesConcurrentSubmissions(t *testing.T) {
	t.Parallel()
	sink := &recordingSink{}
	pipeline := newTestPipeline(t, Config{Workers: 2, QueueSize: 10, BatchSize: 3, FlushInterval: time.Second}, sink)

	results := make(chan error, 3)
	for index := 0; index < 3; index++ {
		go func(index int) {
			_, err := pipeline.Submit(context.Background(), spanEnvelope(index))
			results <- err
		}(index)
	}
	for range 3 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	pipeline.CloseAdmission()
	if err := pipeline.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}

	sink.mutex.Lock()
	defer sink.mutex.Unlock()
	if len(sink.batches) != 1 || len(sink.batches[0]) != 3 {
		t.Fatalf("expected one batch of three, got %#v", sink.batches)
	}
}

func TestPipelineRejectsWhenQueueIsFull(t *testing.T) {
	t.Parallel()
	sink := &recordingSink{block: make(chan struct{}), entered: make(chan struct{}, 1)}
	pipeline := newTestPipeline(t, Config{Workers: 1, QueueSize: 1, BatchSize: 1, FlushInterval: time.Second}, sink)

	backgroundResults := make(chan error, 4)
	go submit(pipeline, spanEnvelope(1), backgroundResults)
	select {
	case <-sink.entered:
	case <-time.After(time.Second):
		t.Fatal("worker did not enter the sink")
	}
	pipeline.jobs[workerIndex(spanEnvelope(2), len(pipeline.jobs))] <- []*item{testItem(spanEnvelope(2))}
	pipeline.queue <- testItem(spanEnvelope(3))
	waitFor(t, func() bool { return len(pipeline.queue) == 0 }, "dispatcher did not take the third item")
	pipeline.queue <- testItem(spanEnvelope(4))
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := pipeline.Submit(ctx, spanEnvelope(5))
	if !errors.Is(err, ErrQueueFull) {
		t.Fatalf("expected queue-full error, got %v", err)
	}

	close(sink.block)
	pipeline.CloseAdmission()
	if err := pipeline.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestPipelineDrainsAcceptedWorkDuringShutdown(t *testing.T) {
	t.Parallel()
	sink := &recordingSink{block: make(chan struct{}), entered: make(chan struct{}, 1)}
	pipeline := newTestPipeline(t, Config{Workers: 1, QueueSize: 4, BatchSize: 1, FlushInterval: time.Second}, sink)
	result := make(chan error, 1)
	go submit(pipeline, spanEnvelope(1), result)
	<-sink.entered
	pipeline.CloseAdmission()
	if _, err := pipeline.Submit(context.Background(), spanEnvelope(2)); !errors.Is(err, ErrClosed) {
		t.Fatalf("expected closed admission, got %v", err)
	}
	close(sink.block)
	if err := pipeline.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := <-result; err != nil {
		t.Fatalf("accepted work was not drained: %v", err)
	}
}

func TestPipelineReportsSinkErrors(t *testing.T) {
	t.Parallel()
	expected := errors.New("sink unavailable")
	sink := &recordingSink{err: expected}
	pipeline := newTestPipeline(t, Config{Workers: 1, QueueSize: 2, BatchSize: 1, FlushInterval: time.Second}, sink)
	_, err := pipeline.Submit(context.Background(), spanEnvelope(1))
	if !errors.Is(err, expected) {
		t.Fatalf("expected sink error, got %v", err)
	}
	pipeline.CloseAdmission()
	if err := pipeline.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestPipelinePreservesPerServiceDeliveryOrderAcrossWorkers(t *testing.T) {
	t.Parallel()
	sink := &orderedSink{received: make(chan int, 3)}
	pipeline := newTestPipeline(t, Config{Workers: 4, QueueSize: 10, BatchSize: 1, FlushInterval: time.Second}, sink)
	results := make(chan error, 3)
	for index := 1; index <= 3; index++ {
		go submit(pipeline, spanEnvelope(index), results)
		waitFor(t, func() bool { return len(sink.received) == index }, "service delivery did not advance")
	}
	for expected := 1; expected <= 3; expected++ {
		if got := <-sink.received; got != expected {
			t.Fatalf("service delivery reordered: got %d, expected %d", got, expected)
		}
	}
	pipeline.CloseAdmission()
	if err := pipeline.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
}

type recordingSink struct {
	mutex   sync.Mutex
	batches [][]telemetry.Envelope
	block   chan struct{}
	entered chan struct{}
	err     error
}

type orderedSink struct {
	received chan int
}

func (sink *orderedSink) ConsumeBatch(_ context.Context, envelopes []telemetry.Envelope) ([]Outcome, error) {
	for _, envelope := range envelopes {
		var index int
		for candidate := 1; candidate <= 3; candidate++ {
			if envelope.SpanBatch.Spans[0].SpanID == time.Unix(int64(candidate), 0).String() {
				index = candidate
			}
		}
		sink.received <- index
	}
	return make([]Outcome, len(envelopes)), nil
}

func (*orderedSink) Ready(context.Context) error { return nil }
func (*orderedSink) Close() error                { return nil }

func (sink *recordingSink) ConsumeBatch(_ context.Context, envelopes []telemetry.Envelope) ([]Outcome, error) {
	if sink.entered != nil {
		select {
		case sink.entered <- struct{}{}:
		default:
		}
	}
	if sink.block != nil {
		<-sink.block
	}
	sink.mutex.Lock()
	sink.batches = append(sink.batches, envelopes)
	sink.mutex.Unlock()
	return make([]Outcome, len(envelopes)), sink.err
}

func (*recordingSink) Ready(context.Context) error { return nil }
func (*recordingSink) Close() error                { return nil }

func newTestPipeline(t *testing.T, config Config, sink Sink) *Pipeline {
	t.Helper()
	pipeline, err := New(config, sink, collectormetrics.New(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return pipeline
}

func spanEnvelope(index int) telemetry.Envelope {
	return telemetry.Envelope{
		ProtocolVersion: telemetry.ProtocolVersion,
		SpanBatch: &telemetry.SpanBatch{ServiceName: "test", Spans: []telemetry.Span{{
			TraceID: "trace", SpanID: time.Unix(int64(index), 0).String(), Name: "test",
			Kind: "custom", Status: "ok",
		}}},
	}
}

func submit(pipeline *Pipeline, envelope telemetry.Envelope, result chan<- error) {
	_, err := pipeline.Submit(context.Background(), envelope)
	result <- err
}

func testItem(envelope telemetry.Envelope) *item {
	return &item{envelope: envelope, received: time.Now(), result: make(chan result, 1)}
}

func waitFor(t *testing.T, condition func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal(message)
}
