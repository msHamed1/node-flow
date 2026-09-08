package topology

import (
	"fmt"
	"testing"
)

func BenchmarkTopologyReconstruction(b *testing.B) {
	for _, workload := range topologyBenchmarkWorkloads() {
		b.Run(workload.name, func(b *testing.B) {
			b.ReportAllocs()
			b.ResetTimer()
			for iteration := 0; iteration < b.N; iteration++ {
				engine := New(Options{})
				engine.RegisterApplication("benchmark-api", "v22.0.0")
				for _, batch := range workload.batches {
					engine.Ingest(batch)
				}
				_ = engine.CreateSnapshot()
			}
			elapsed := b.Elapsed().Seconds()
			b.ReportMetric(float64(b.N*workload.spanCount)/elapsed, "spans/s")
			b.ReportMetric(float64(b.N*len(workload.batches))/elapsed, "updates/s")
		})
	}
}

func BenchmarkTopologySnapshot(b *testing.B) {
	for _, workload := range topologyBenchmarkWorkloads() {
		b.Run(workload.name, func(b *testing.B) {
			engine := New(Options{})
			engine.RegisterApplication("benchmark-api", "v22.0.0")
			for _, batch := range workload.batches {
				engine.Ingest(batch)
			}
			topologySize := engine.CreateSnapshot()
			b.ReportMetric(float64(len(topologySize.Nodes)), "nodes/snapshot")
			b.ReportMetric(float64(len(topologySize.Edges)), "edges/snapshot")
			b.ReportMetric(float64(len(topologySize.Paths)), "paths/snapshot")
			b.ReportAllocs()
			b.ResetTimer()
			for iteration := 0; iteration < b.N; iteration++ {
				_ = engine.CreateSnapshot()
			}
			b.ReportMetric(float64(b.N)/b.Elapsed().Seconds(), "snapshots/s")
		})
	}
}

type benchmarkWorkload struct {
	name      string
	spanCount int
	batches   [][]Span
}

func topologyBenchmarkWorkloads() []benchmarkWorkload {
	return []benchmarkWorkload{
		makeTopologyBenchmarkWorkload("small-300-spans", 100, 5, 5, 5),
		makeTopologyBenchmarkWorkload("medium-3000-spans", 1000, 20, 20, 20),
		makeTopologyBenchmarkWorkload("large-30000-spans", 10000, 100, 50, 50),
	}
}

func makeTopologyBenchmarkWorkload(name string, traces, routes, services, databases int) benchmarkWorkload {
	spans := make([]Span, 0, traces*3)
	for trace := 0; trace < traces; trace++ {
		traceID := fmt.Sprintf("benchmark-%d", trace)
		route := trace % routes
		service := (trace*17 + trace/routes) % services
		database := (trace*31 + trace/(routes*services)) % databases
		start := float64(1_700_000_000_000 + trace*10)
		spans = append(spans,
			Span{
				TraceID: traceID, SpanID: traceID + "-route", Name: fmt.Sprintf("GET /resource/%d", route),
				Kind: "http-route", StartTimeUnixMS: start, DurationMS: 10, Status: "ok",
			},
			Span{
				TraceID: traceID, SpanID: traceID + "-service", ParentSpanID: traceID + "-route",
				Name: fmt.Sprintf("Service%d.call", service), Kind: "service", StartTimeUnixMS: start + 1,
				DurationMS: 7, Status: "ok", Attributes: map[string]any{
					"nodeflow.identity":  fmt.Sprintf("service:Service%d", service),
					"nodeflow.class":     fmt.Sprintf("Service%d", service),
					"nodeflow.framework": "nestjs",
				},
			},
			Span{
				TraceID: traceID, SpanID: traceID + "-database", ParentSpanID: traceID + "-service",
				Name: fmt.Sprintf("Database%d", database), Kind: "database", StartTimeUnixMS: start + 2,
				DurationMS: 3, Status: "ok", Attributes: map[string]any{
					"nodeflow.identity": fmt.Sprintf("database:Database%d", database),
				},
			},
		)
	}
	const batchSize = 100
	batches := make([][]Span, 0, (len(spans)+batchSize-1)/batchSize)
	for start := 0; start < len(spans); start += batchSize {
		end := start + batchSize
		if end > len(spans) {
			end = len(spans)
		}
		batches = append(batches, spans[start:end])
	}
	return benchmarkWorkload{name: name, spanCount: len(spans), batches: batches}
}
