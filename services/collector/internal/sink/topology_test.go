package sink

import (
	"context"
	"errors"
	"testing"

	collectormetrics "github.com/msHamed1/node-flow/services/collector/internal/metrics"
	"github.com/msHamed1/node-flow/services/collector/internal/telemetry"
	"github.com/msHamed1/node-flow/services/collector/internal/topology"
)

type failingTopologyCheckpointer struct{}

func (failingTopologyCheckpointer) Save(*topology.Engine) (int64, error) {
	return 0, errors.New("checkpoint failed")
}

func TestTopologySinkAggregatesBatchesAndNewestRuntime(t *testing.T) {
	engine := topology.New(topology.Options{})
	publisher := &recordingPublisher{}
	sink := NewTopology(engine, collectormetrics.New(), publisher, nil)
	envelopes := []telemetry.Envelope{
		{SpanBatch: &telemetry.SpanBatch{ServiceName: "payments-api", NodeVersion: "v22", Spans: []telemetry.Span{
			{TraceID: "trace", SpanID: "route", Name: "GET /payments", Kind: "http-route", StartTimeUnixMS: 1, DurationMS: 10, Status: "ok"},
		}}},
		{SpanBatch: &telemetry.SpanBatch{ServiceName: "payments-api", NodeVersion: "v22", Spans: []telemetry.Span{
			{TraceID: "trace", SpanID: "database", ParentSpanID: "route", Name: "PostgreSQL", Kind: "database", StartTimeUnixMS: 2, DurationMS: 3, Status: "ok"},
		}}},
		{RuntimeMetrics: &telemetry.RuntimeMetrics{ServiceName: "payments-api", Timestamp: 10, HeapUsedBytes: 100}},
		{RuntimeMetrics: &telemetry.RuntimeMetrics{ServiceName: "payments-api", Timestamp: 20, HeapUsedBytes: 200}},
	}
	outcomes, err := sink.ConsumeBatch(context.Background(), envelopes)
	if err != nil {
		t.Fatal(err)
	}
	if outcomes[0].Revision == nil || outcomes[1].Revision == nil || *outcomes[0].Revision != *outcomes[1].Revision {
		t.Fatalf("span batch outcomes did not share a revision: %#v", outcomes)
	}
	snapshot := engine.LiveSnapshot()
	if snapshot.Revision != 2 || len(snapshot.Nodes) != 2 || len(snapshot.Edges) != 1 {
		t.Fatalf("unexpected live topology: %#v", snapshot)
	}
	if snapshot.Runtime == nil || snapshot.Runtime.Timestamp != 20 || snapshot.Runtime.HeapUsedBytes != 200 {
		t.Fatalf("newest runtime sample was not retained: %#v", snapshot.Runtime)
	}
	if len(publisher.snapshots) != 2 {
		t.Fatalf("published snapshots = %d, want span and runtime updates", len(publisher.snapshots))
	}
}

func TestTopologySinkDoesNotAcknowledgeCheckpointFailure(t *testing.T) {
	engine := topology.New(topology.Options{})
	sink := NewTopology(engine, collectormetrics.New(), nil, failingTopologyCheckpointer{})
	_, err := sink.ConsumeBatch(context.Background(), []telemetry.Envelope{{SpanBatch: &telemetry.SpanBatch{
		ServiceName: "orders", NodeVersion: "v22", Spans: []telemetry.Span{{
			TraceID: "trace", SpanID: "span", Name: "GET /orders", Kind: "http-route", Status: "ok",
		}},
	}}})
	if err == nil || err.Error() != "checkpoint failed" {
		t.Fatalf("expected checkpoint failure, got %v", err)
	}
}

type recordingPublisher struct {
	snapshots []topology.LiveSnapshot
}

func (publisher *recordingPublisher) Publish(snapshot topology.LiveSnapshot) {
	publisher.snapshots = append(publisher.snapshots, snapshot)
}
