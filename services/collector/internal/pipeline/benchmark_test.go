package pipeline

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	collectormetrics "github.com/msHamed1/node-flow/services/collector/internal/metrics"
	"github.com/msHamed1/node-flow/services/collector/internal/telemetry"
)

func BenchmarkPipeline(b *testing.B) {
	processor, err := New(
		Config{Workers: 8, QueueSize: 10_000, BatchSize: 250, FlushInterval: time.Millisecond},
		benchmarkSink{}, collectormetrics.New(), slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		b.Fatal(err)
	}
	envelope := telemetry.Envelope{ProtocolVersion: telemetry.ProtocolVersion, SpanBatch: &telemetry.SpanBatch{
		ServiceName: "benchmark", Spans: []telemetry.Span{{
			TraceID: "trace", SpanID: "span", Name: "GET /benchmark", Kind: "http-route", Status: "ok",
		}},
	}}
	b.ResetTimer()
	b.RunParallel(func(parallel *testing.PB) {
		for parallel.Next() {
			if _, err := processor.Submit(context.Background(), envelope); err != nil {
				b.Error(err)
			}
		}
	})
	b.StopTimer()
	processor.CloseAdmission()
	if err := processor.Wait(context.Background()); err != nil {
		b.Fatal(err)
	}
}

type benchmarkSink struct{}

func (benchmarkSink) ConsumeBatch(_ context.Context, envelopes []telemetry.Envelope) ([]Outcome, error) {
	return make([]Outcome, len(envelopes)), nil
}
func (benchmarkSink) Ready(context.Context) error { return nil }
func (benchmarkSink) Close() error                { return nil }
