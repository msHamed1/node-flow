package metrics

import (
	"fmt"
	"io"
	"math"
	"net/http"
	"runtime"
	"strconv"
	"sync/atomic"
	"time"
)

type Collector struct {
	received           atomic.Uint64
	processed          atomic.Uint64
	rejectedFull       atomic.Uint64
	rejectedSpool      atomic.Uint64
	rejectedClosed     atomic.Uint64
	rejectedInvalid    atomic.Uint64
	errors             atomic.Uint64
	queueDepth         atomic.Int64
	activeWorkers      atomic.Int64
	topologyNodes      atomic.Int64
	topologyEdges      atomic.Int64
	topologyUpdates    atomic.Uint64
	topologyBytes      atomic.Int64
	spoolBytes         atomic.Int64
	spoolActive        atomic.Int64
	spoolQuarantine    atomic.Int64
	spoolRetries       atomic.Uint64
	spoolReplayed      atomic.Uint64
	spoolPermanent     atomic.Uint64
	spoolCorrupt       atomic.Uint64
	spoolDropped       atomic.Uint64
	walBytes           atomic.Int64
	walSegments        atomic.Int64
	walPending         atomic.Int64
	walQuarantine      atomic.Int64
	walReplayed        atomic.Uint64
	walCompactions     atomic.Uint64
	walCompacted       atomic.Uint64
	walCorrupt         atomic.Uint64
	walDiskReject      atomic.Uint64
	processing         *histogram
	batchSize          *histogram
	walAppend          *histogram
	walSync            *histogram
	walGroupRecords    *histogram
	walCompaction      *histogram
	topologyCheckpoint *histogram
}

func New() *Collector {
	return &Collector{
		processing:         newHistogram([]float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}),
		batchSize:          newHistogram([]float64{1, 10, 25, 50, 100, 250, 500, 1_000, 5_000}),
		walAppend:          newHistogram([]float64{0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1}),
		walSync:            newHistogram([]float64{0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1}),
		walGroupRecords:    newHistogram([]float64{1, 2, 4, 8, 16, 32, 64, 128, 256, 512}),
		walCompaction:      newHistogram([]float64{0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1}),
		topologyCheckpoint: newHistogram([]float64{0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5}),
	}
}

func (c *Collector) SetWALUsage(bytes int64, segments int64, pendingRecords int64, quarantinedRecords int64) {
	c.walBytes.Store(bytes)
	c.walSegments.Store(segments)
	c.walPending.Store(pendingRecords)
	c.walQuarantine.Store(quarantinedRecords)
	// Keep the V2.1 generic spool series stable for existing dashboards.
	c.SetSpoolUsage(bytes, pendingRecords, quarantinedRecords)
}

func (c *Collector) ObserveWALAppend(elapsed time.Duration) { c.walAppend.observe(elapsed.Seconds()) }
func (c *Collector) ObserveWALSync(elapsed time.Duration)   { c.walSync.observe(elapsed.Seconds()) }
func (c *Collector) ObserveWALGroupCommit(records int)      { c.walGroupRecords.observe(float64(records)) }
func (c *Collector) ObserveWALCompaction(elapsed time.Duration, segments int) {
	c.walCompactions.Add(1)
	c.walCompacted.Add(uint64(segments))
	c.walCompaction.observe(elapsed.Seconds())
}
func (c *Collector) RecordWALCorruption()                      { c.walCorrupt.Add(1) }
func (c *Collector) RecordWALReplay(records uint64)            { c.walReplayed.Add(records) }
func (c *Collector) RecordWALDiskFullRejection(records uint64) { c.walDiskReject.Add(records) }

func (c *Collector) RecordReceived(count uint64)  { c.received.Add(count) }
func (c *Collector) RecordProcessed(count uint64) { c.processed.Add(count) }
func (c *Collector) RecordError()                 { c.errors.Add(1) }
func (c *Collector) SetQueueDepth(depth int)      { c.queueDepth.Store(int64(depth)) }
func (c *Collector) WorkerStarted()               { c.activeWorkers.Add(1) }
func (c *Collector) WorkerStopped()               { c.activeWorkers.Add(-1) }
func (c *Collector) ObserveProcessing(elapsed time.Duration) {
	c.processing.observe(elapsed.Seconds())
}
func (c *Collector) ObserveBatchSize(size uint64) { c.batchSize.observe(float64(size)) }
func (c *Collector) SetTopology(nodes, edges int) {
	c.topologyNodes.Store(int64(nodes))
	c.topologyEdges.Store(int64(edges))
}

func (c *Collector) RecordTopologyUpdate() { c.topologyUpdates.Add(1) }
func (c *Collector) ObserveTopologyCheckpoint(elapsed time.Duration, bytes int64) {
	c.topologyCheckpoint.observe(elapsed.Seconds())
	c.topologyBytes.Store(bytes)
}

func (c *Collector) SetSpoolUsage(bytes int64, activeRecords int64, quarantinedRecords int64) {
	c.spoolBytes.Store(bytes)
	c.spoolActive.Store(activeRecords)
	c.spoolQuarantine.Store(quarantinedRecords)
}

func (c *Collector) RecordSpoolRetry(records uint64)  { c.spoolRetries.Add(records) }
func (c *Collector) RecordSpoolReplay(records uint64) { c.spoolReplayed.Add(records) }
func (c *Collector) RecordSpoolCorruption()           { c.spoolCorrupt.Add(1); c.spoolDropped.Add(1) }
func (c *Collector) RecordSpoolPermanent(records uint64) {
	c.spoolPermanent.Add(records)
	c.spoolDropped.Add(records)
}

func (c *Collector) RecordRejected(reason string, count uint64) {
	switch reason {
	case "queue_full":
		c.rejectedFull.Add(count)
	case "spool_full":
		c.rejectedSpool.Add(count)
	case "closed":
		c.rejectedClosed.Add(count)
	default:
		c.rejectedInvalid.Add(count)
	}
}

func (c *Collector) Handler() http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		c.writePrometheus(response)
	})
}

func (c *Collector) writePrometheus(writer io.Writer) {
	writeCounter(writer, "nodeflow_collector_telemetry_received_total", "Telemetry events admitted or rejected after validation.", c.received.Load())
	writeCounter(writer, "nodeflow_collector_telemetry_processed_total", "Telemetry events acknowledged by the configured sink.", c.processed.Load())
	fmt.Fprintln(writer, "# HELP nodeflow_collector_telemetry_rejected_total Telemetry events rejected before processing.")
	fmt.Fprintln(writer, "# TYPE nodeflow_collector_telemetry_rejected_total counter")
	fmt.Fprintf(writer, "nodeflow_collector_telemetry_rejected_total{reason=\"queue_full\"} %d\n", c.rejectedFull.Load())
	fmt.Fprintf(writer, "nodeflow_collector_telemetry_rejected_total{reason=\"spool_full\"} %d\n", c.rejectedSpool.Load())
	fmt.Fprintf(writer, "nodeflow_collector_telemetry_rejected_total{reason=\"closed\"} %d\n", c.rejectedClosed.Load())
	fmt.Fprintf(writer, "nodeflow_collector_telemetry_rejected_total{reason=\"invalid\"} %d\n", c.rejectedInvalid.Load())
	writeCounter(writer, "nodeflow_collector_processing_errors_total", "Worker batches that the configured sink failed to process.", c.errors.Load())
	writeGauge(writer, "nodeflow_collector_queue_depth", "Telemetry envelopes currently waiting for batching.", c.queueDepth.Load())
	writeGauge(writer, "nodeflow_collector_active_workers", "Workers currently calling the configured sink.", c.activeWorkers.Load())
	writeGauge(writer, "nodeflow_collector_topology_nodes", "Nodes reported by the downstream topology projection.", c.topologyNodes.Load())
	writeGauge(writer, "nodeflow_collector_topology_edges", "Edges reported by the downstream topology projection.", c.topologyEdges.Load())
	writeCounter(writer, "nodeflow_collector_topology_updates_total", "Topology batches committed by the configured topology authority.", c.topologyUpdates.Load())
	writeGauge(writer, "nodeflow_collector_topology_state_bytes", "Bytes in the latest durable Go topology checkpoint.", c.topologyBytes.Load())
	writeGauge(writer, "nodeflow_collector_spool_bytes", "Filesystem-allocated bytes retained by active and quarantined spool records.", c.spoolBytes.Load())
	writeGauge(writer, "nodeflow_collector_spool_active_records", "Durable records awaiting successful delivery.", c.spoolActive.Load())
	writeGauge(writer, "nodeflow_collector_spool_quarantined_records", "Corrupt or permanently failed records retained for inspection.", c.spoolQuarantine.Load())
	writeCounter(writer, "nodeflow_collector_spool_retries_total", "Durable records checkpointed for another delivery attempt.", c.spoolRetries.Load())
	writeCounter(writer, "nodeflow_collector_spool_replayed_total", "Durable records recovered when the collector started.", c.spoolReplayed.Load())
	writeCounter(writer, "nodeflow_collector_spool_permanent_failures_total", "Durable records removed from active delivery after a permanent failure.", c.spoolPermanent.Load())
	writeCounter(writer, "nodeflow_collector_spool_corruptions_total", "Unreadable durable records quarantined by recovery or dispatch.", c.spoolCorrupt.Load())
	writeCounter(writer, "nodeflow_collector_spool_dropped_total", "Durable records removed from active delivery and quarantined.", c.spoolDropped.Load())
	writeGauge(writer, "nodeflow_collector_wal_bytes", "Logical bytes retained by WAL segment and checkpoint files.", c.walBytes.Load())
	writeGauge(writer, "nodeflow_collector_wal_segments", "WAL segments currently retained.", c.walSegments.Load())
	writeGauge(writer, "nodeflow_collector_wal_pending_records", "Committed WAL records awaiting successful delivery.", c.walPending.Load())
	writeGauge(writer, "nodeflow_collector_wal_quarantined_records", "Permanently failed WAL records retained for inspection.", c.walQuarantine.Load())
	writeCounter(writer, "nodeflow_collector_wal_replayed_total", "Committed WAL records recovered when the collector started.", c.walReplayed.Load())
	writeCounter(writer, "nodeflow_collector_wal_compactions_total", "Successful WAL compaction passes that removed segments.", c.walCompactions.Load())
	writeCounter(writer, "nodeflow_collector_wal_segments_compacted_total", "Fully acknowledged WAL segments removed by compaction.", c.walCompacted.Load())
	writeCounter(writer, "nodeflow_collector_wal_corruptions_total", "WAL checksum, framing, or committed-record corruption detections.", c.walCorrupt.Load())
	writeCounter(writer, "nodeflow_collector_wal_disk_full_rejections_total", "WAL records rejected to preserve the configured disk bound.", c.walDiskReject.Load())
	c.walAppend.write(writer, "nodeflow_collector_wal_append_duration_seconds", "Request admission latency through durable WAL group commit.")
	c.walSync.write(writer, "nodeflow_collector_wal_fsync_duration_seconds", "Latency of WAL data and checkpoint fsync operations.")
	c.walGroupRecords.write(writer, "nodeflow_collector_wal_records_per_group_commit", "Records made durable by each WAL fsync group.")
	c.walCompaction.write(writer, "nodeflow_collector_wal_compaction_duration_seconds", "Latency of WAL segment compaction passes that removed data.")
	c.topologyCheckpoint.write(writer, "nodeflow_collector_topology_checkpoint_duration_seconds", "Latency of durable Go topology state checkpoints.")
	c.processing.write(writer, "nodeflow_collector_processing_duration_seconds", "End-to-end queue and sink latency for an admitted envelope.")
	c.batchSize.write(writer, "nodeflow_collector_batch_size", "Telemetry events delivered in one worker batch.")

	var memory runtime.MemStats
	runtime.ReadMemStats(&memory)
	writeGauge(writer, "nodeflow_collector_process_heap_bytes", "Go heap bytes currently allocated.", int64(memory.HeapAlloc))
	writeCounter(writer, "nodeflow_collector_process_allocated_bytes_total", "Cumulative bytes allocated by the Go process.", memory.TotalAlloc)
	writeCounter(writer, "nodeflow_collector_process_allocations_total", "Cumulative heap allocations by the Go process.", memory.Mallocs)
	writeGauge(writer, "nodeflow_collector_process_goroutines", "Current Go goroutine count.", int64(runtime.NumGoroutine()))
	fmt.Fprintln(writer, "# HELP nodeflow_collector_process_cpu_seconds_total User and system CPU seconds consumed by the Go process.")
	fmt.Fprintln(writer, "# TYPE nodeflow_collector_process_cpu_seconds_total counter")
	fmt.Fprintf(writer, "nodeflow_collector_process_cpu_seconds_total %s\n", formatFloat(processCPUSeconds()))
}

type histogram struct {
	bounds []float64
	counts []atomic.Uint64
	count  atomic.Uint64
	sum    atomic.Uint64
}

func newHistogram(bounds []float64) *histogram {
	return &histogram{bounds: bounds, counts: make([]atomic.Uint64, len(bounds))}
}

func (h *histogram) observe(value float64) {
	h.count.Add(1)
	addFloat(&h.sum, value)
	for index, bound := range h.bounds {
		if value <= bound {
			h.counts[index].Add(1)
		}
	}
}

func (h *histogram) write(writer io.Writer, name, help string) {
	fmt.Fprintf(writer, "# HELP %s %s\n", name, help)
	fmt.Fprintf(writer, "# TYPE %s histogram\n", name)
	for index, bound := range h.bounds {
		fmt.Fprintf(writer, "%s_bucket{le=\"%s\"} %d\n", name, formatFloat(bound), h.counts[index].Load())
	}
	count := h.count.Load()
	fmt.Fprintf(writer, "%s_bucket{le=\"+Inf\"} %d\n", name, count)
	fmt.Fprintf(writer, "%s_sum %s\n", name, formatFloat(math.Float64frombits(h.sum.Load())))
	fmt.Fprintf(writer, "%s_count %d\n", name, count)
}

func addFloat(target *atomic.Uint64, value float64) {
	for {
		oldBits := target.Load()
		next := math.Float64bits(math.Float64frombits(oldBits) + value)
		if target.CompareAndSwap(oldBits, next) {
			return
		}
	}
}

func writeCounter(writer io.Writer, name, help string, value uint64) {
	fmt.Fprintf(writer, "# HELP %s %s\n", name, help)
	fmt.Fprintf(writer, "# TYPE %s counter\n", name)
	fmt.Fprintf(writer, "%s %d\n", name, value)
}

func writeGauge(writer io.Writer, name, help string, value int64) {
	fmt.Fprintf(writer, "# HELP %s %s\n", name, help)
	fmt.Fprintf(writer, "# TYPE %s gauge\n", name)
	fmt.Fprintf(writer, "%s %d\n", name, value)
}

func formatFloat(value float64) string {
	return strconv.FormatFloat(value, 'g', -1, 64)
}
