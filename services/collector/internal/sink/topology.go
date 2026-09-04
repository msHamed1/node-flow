package sink

import (
	"context"
	"time"

	collectormetrics "github.com/msHamed1/node-flow/services/collector/internal/metrics"
	"github.com/msHamed1/node-flow/services/collector/internal/pipeline"
	"github.com/msHamed1/node-flow/services/collector/internal/telemetry"
	"github.com/msHamed1/node-flow/services/collector/internal/topology"
)

type SnapshotPublisher interface {
	Publish(topology.LiveSnapshot)
}

type TopologyCheckpointer interface {
	Save(*topology.Engine) (int64, error)
}

// Topology is the production adapter between normalized collector envelopes
// and the transport-independent topology engine.
type Topology struct {
	engine    *topology.Engine
	metrics   *collectormetrics.Collector
	publisher SnapshotPublisher
	state     TopologyCheckpointer
}

func NewTopology(engine *topology.Engine, metrics *collectormetrics.Collector, publisher SnapshotPublisher, state TopologyCheckpointer) *Topology {
	return &Topology{engine: engine, metrics: metrics, publisher: publisher, state: state}
}

func (sink *Topology) ConsumeBatch(ctx context.Context, envelopes []telemetry.Envelope) ([]pipeline.Outcome, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	outcomes := make([]pipeline.Outcome, len(envelopes))
	groups := make(map[string]*topologySpanGroup)
	runtimes := make(map[string]*telemetry.RuntimeMetrics)
	for index, envelope := range envelopes {
		if envelope.SpanBatch != nil {
			key := envelope.SpanBatch.ServiceName + "\x00" + envelope.SpanBatch.NodeVersion
			group := groups[key]
			if group == nil {
				group = &topologySpanGroup{
					serviceName: envelope.SpanBatch.ServiceName,
					nodeVersion: envelope.SpanBatch.NodeVersion,
				}
				groups[key] = group
			}
			group.spans = append(group.spans, envelope.SpanBatch.Spans...)
			group.indexes = append(group.indexes, index)
		}
		if envelope.RuntimeMetrics != nil {
			current := runtimes[envelope.RuntimeMetrics.ServiceName]
			if current == nil || current.Timestamp <= envelope.RuntimeMetrics.Timestamp {
				runtimes[envelope.RuntimeMetrics.ServiceName] = envelope.RuntimeMetrics
			}
		}
	}

	for _, key := range sortedKeys(groups) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		group := groups[key]
		sink.engine.RegisterApplication(group.serviceName, group.nodeVersion)
		spans := make([]topology.Span, len(group.spans))
		for index, span := range group.spans {
			spans[index] = topology.Span{
				TraceID: span.TraceID, SpanID: span.SpanID, ParentSpanID: span.ParentSpanID,
				Name: span.Name, Kind: span.Kind, StartTimeUnixMS: span.StartTimeUnixMS,
				DurationMS: span.DurationMS, Status: span.Status, Attributes: span.Attributes,
			}
		}
		snapshot := sink.engine.Ingest(spans)
		if err := sink.checkpoint(); err != nil {
			return nil, err
		}
		sink.metrics.SetTopology(len(snapshot.Nodes), len(snapshot.Edges))
		sink.metrics.RecordTopologyUpdate()
		sink.publish(snapshot)
		for _, index := range group.indexes {
			revision := snapshot.Revision
			outcomes[index].Revision = &revision
		}
	}

	for _, serviceName := range sortedKeys(runtimes) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		metrics := runtimes[serviceName]
		snapshot := sink.engine.UpdateRuntime(topology.RuntimeMetrics{
			Timestamp: metrics.Timestamp, ServiceName: metrics.ServiceName,
			RSSBytes: metrics.RSSBytes, HeapUsedBytes: metrics.HeapUsedBytes,
			HeapTotalBytes: metrics.HeapTotalBytes, CPUPercent: metrics.CPUPercent,
			EventLoopUtilization: metrics.EventLoopUtilization, UptimeSeconds: metrics.UptimeSeconds,
		})
		if err := sink.checkpoint(); err != nil {
			return nil, err
		}
		sink.publish(snapshot)
		sink.metrics.RecordTopologyUpdate()
	}
	return outcomes, nil
}

func (sink *Topology) checkpoint() error {
	if sink.state == nil {
		return nil
	}
	started := time.Now()
	bytes, err := sink.state.Save(sink.engine)
	if err == nil {
		sink.metrics.ObserveTopologyCheckpoint(time.Since(started), bytes)
	}
	return err
}

func (sink *Topology) Ready(context.Context) error { return nil }

func (sink *Topology) Close() error { return nil }

func (sink *Topology) publish(snapshot topology.LiveSnapshot) {
	if sink.publisher != nil {
		sink.publisher.Publish(snapshot)
	}
}

type topologySpanGroup struct {
	serviceName string
	nodeVersion string
	spans       []telemetry.Span
	indexes     []int
}
