package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	nodeflowv1 "github.com/msHamed1/node-flow/services/collector/gen/nodeflow/v1"
	"google.golang.org/protobuf/proto"
)

type config struct {
	target           string
	rate             int
	duration         time.Duration
	eventsPerRequest int
	concurrency      int
	service          string
}

type result struct {
	TargetEventsPerSecond int     `json:"targetEventsPerSecond"`
	DurationSeconds       float64 `json:"admissionDurationSeconds"`
	ProcessingCatchupMS   float64 `json:"processingCatchupMs"`
	DrainComplete         bool    `json:"drainComplete"`
	AttemptedEvents       uint64  `json:"attemptedEvents"`
	AcceptedEvents        uint64  `json:"acceptedEvents"`
	ProcessedEvents       uint64  `json:"processedEvents"`
	RejectedEvents        uint64  `json:"rejectedEvents"`
	FailedEvents          uint64  `json:"failedEvents"`
	ThroughputEventsSec   float64 `json:"throughputEventsPerSecond"`
	LatencyP50MS          float64 `json:"latencyP50Ms"`
	LatencyP95MS          float64 `json:"latencyP95Ms"`
	PeakHeapBytes         float64 `json:"peakCollectorHeapBytes"`
	PeakQueueDepth        float64 `json:"peakQueueDepth"`
	PeakSpoolBytes        float64 `json:"peakSpoolBytes"`
	PeakWALBytes          float64 `json:"peakWalBytes"`
	PeakWALSegments       float64 `json:"peakWalSegments"`
	AverageCPUPercent     float64 `json:"averageCollectorCpuPercent"`
	WALFsyncs             float64 `json:"walFsyncs"`
	WALFsyncsPerSecond    float64 `json:"walFsyncsPerSecond"`
	WALGroupCommits       float64 `json:"walGroupCommits"`
	AverageRecordsCommit  float64 `json:"averageRecordsPerGroupCommit"`
	DurableRetries        float64 `json:"durableRetries"`
	WALDiskRejections     float64 `json:"walDiskPressureRejections"`
	TopologyUpdates       float64 `json:"topologyUpdates"`
	TopologyUpdatesSec    float64 `json:"topologyUpdatesPerSecond"`
	SnapshotP95MS         float64 `json:"snapshotP95Ms"`
	EndToEndP95MS         float64 `json:"collectorToTopologyP95Ms"`
	CheckpointP95MS       float64 `json:"topologyCheckpointP95Ms"`
	TopologyStateBytes    float64 `json:"topologyStateBytes"`
	AllocatedBytes        float64 `json:"collectorAllocatedBytes"`
	Allocations           float64 `json:"collectorAllocations"`
}

type counters struct {
	attempted atomic.Uint64
	accepted  atomic.Uint64
	rejected  atomic.Uint64
	failed    atomic.Uint64
	mutex     sync.Mutex
	latencies []float64
}

type sample struct {
	heap     float64
	queue    float64
	spool    float64
	wal      float64
	segments float64
	cpu      float64
}

func main() {
	config := parseFlags()
	if config.rate <= 0 || config.duration <= 0 || config.eventsPerRequest <= 0 || config.concurrency <= 0 {
		fmt.Fprintln(os.Stderr, "rate, duration, events-per-request, and concurrency must be positive")
		os.Exit(2)
	}
	result, err := run(context.Background(), config)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(result)
}

func parseFlags() config {
	var config config
	flag.StringVar(&config.target, "target", "http://127.0.0.1:4318", "Go collector origin")
	flag.IntVar(&config.rate, "rate", 1_000, "target telemetry events per second")
	flag.DurationVar(&config.duration, "duration", 10*time.Second, "load duration")
	flag.IntVar(&config.eventsPerRequest, "events-per-request", 50, "spans in each envelope")
	flag.IntVar(&config.concurrency, "concurrency", 16, "HTTP workers")
	flag.StringVar(&config.service, "service", "nodeflow-loadgen", "reported service name")
	flag.Parse()
	config.target = strings.TrimRight(config.target, "/")
	return config
}

func run(ctx context.Context, config config) (result, error) {
	transport := &http.Transport{
		MaxIdleConns: config.concurrency * 2, MaxIdleConnsPerHost: config.concurrency,
		MaxConnsPerHost: config.concurrency, DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext,
	}
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	defer transport.CloseIdleConnections()
	if err := waitUntilReady(ctx, client, config.target); err != nil {
		return result{}, err
	}

	before, err := scrape(client, config.target)
	if err != nil {
		return result{}, fmt.Errorf("scrape initial collector metrics: %w", err)
	}
	state := &counters{latencies: make([]float64, 0, config.rate*int(config.duration.Seconds())/config.eventsPerRequest)}
	jobs := make(chan int, config.concurrency*4)
	var workers sync.WaitGroup
	for worker := 0; worker < config.concurrency; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for eventCount := range jobs {
				send(ctx, client, config, eventCount, state)
			}
		}()
	}

	sampleContext, stopSampling := context.WithCancel(ctx)
	defer stopSampling()
	samples := make(chan sample, 1)
	go sampleMetrics(sampleContext, client, config.target, samples)

	totalEvents := int(math.Round(float64(config.rate) * config.duration.Seconds()))
	totalRequests := int(math.Ceil(float64(totalEvents) / float64(config.eventsPerRequest)))
	interval := config.duration / time.Duration(totalRequests)
	ticker := time.NewTicker(interval)
	start := time.Now()
	remaining := totalEvents
	for request := 0; request < totalRequests; request++ {
		select {
		case <-ctx.Done():
			close(jobs)
			workers.Wait()
			return result{}, ctx.Err()
		case <-ticker.C:
		}
		count := min(config.eventsPerRequest, remaining)
		remaining -= count
		jobs <- count
	}
	ticker.Stop()
	close(jobs)
	workers.Wait()
	elapsed := time.Since(start)
	accepted := state.accepted.Load()
	catchupStarted := time.Now()
	drainComplete := waitUntilProcessed(ctx, client, config.target, before["nodeflow_collector_telemetry_processed_total"]+float64(accepted), 30*time.Second)
	catchup := time.Since(catchupStarted)
	snapshotP95, err := sampleSnapshotLatency(client, config.target, 200)
	if err != nil {
		return result{}, fmt.Errorf("sample topology snapshot: %w", err)
	}
	stopSampling()
	peak := <-samples
	after, err := scrape(client, config.target)
	if err != nil {
		return result{}, fmt.Errorf("scrape final collector metrics: %w", err)
	}

	state.mutex.Lock()
	latencies := append([]float64(nil), state.latencies...)
	state.mutex.Unlock()
	cpuDelta := after["nodeflow_collector_process_cpu_seconds_total"] - before["nodeflow_collector_process_cpu_seconds_total"]
	processed := uint64(max(0, after["nodeflow_collector_telemetry_processed_total"]-before["nodeflow_collector_telemetry_processed_total"]))
	fsyncs := after["nodeflow_collector_wal_fsync_duration_seconds_count"] - before["nodeflow_collector_wal_fsync_duration_seconds_count"]
	groupCommits := after["nodeflow_collector_wal_records_per_group_commit_count"] - before["nodeflow_collector_wal_records_per_group_commit_count"]
	groupRecords := after["nodeflow_collector_wal_records_per_group_commit_sum"] - before["nodeflow_collector_wal_records_per_group_commit_sum"]
	topologyUpdates := after["nodeflow_collector_topology_updates_total"] - before["nodeflow_collector_topology_updates_total"]
	averageRecords := float64(0)
	if groupCommits > 0 {
		averageRecords = groupRecords / groupCommits
	}
	return result{
		TargetEventsPerSecond: config.rate,
		DurationSeconds:       round(elapsed.Seconds()),
		ProcessingCatchupMS:   round(float64(catchup.Microseconds()) / 1_000),
		DrainComplete:         drainComplete,
		AttemptedEvents:       state.attempted.Load(),
		AcceptedEvents:        accepted,
		ProcessedEvents:       processed,
		RejectedEvents:        state.rejected.Load(),
		FailedEvents:          state.failed.Load(),
		ThroughputEventsSec:   round(float64(accepted) / elapsed.Seconds()),
		LatencyP50MS:          percentile(latencies, 0.50),
		LatencyP95MS:          percentile(latencies, 0.95),
		PeakHeapBytes:         peak.heap,
		PeakQueueDepth:        peak.queue,
		PeakSpoolBytes:        peak.spool,
		PeakWALBytes:          peak.wal,
		PeakWALSegments:       peak.segments,
		AverageCPUPercent:     round(cpuDelta / (elapsed + catchup).Seconds() * 100),
		WALFsyncs:             fsyncs,
		WALFsyncsPerSecond:    round(fsyncs / elapsed.Seconds()),
		WALGroupCommits:       groupCommits,
		AverageRecordsCommit:  round(averageRecords),
		DurableRetries:        after["nodeflow_collector_spool_retries_total"] - before["nodeflow_collector_spool_retries_total"],
		WALDiskRejections:     after["nodeflow_collector_wal_disk_full_rejections_total"] - before["nodeflow_collector_wal_disk_full_rejections_total"],
		TopologyUpdates:       topologyUpdates,
		TopologyUpdatesSec:    round(topologyUpdates / (elapsed + catchup).Seconds()),
		SnapshotP95MS:         snapshotP95,
		EndToEndP95MS:         round(histogramQuantileDelta(before, after, "nodeflow_collector_processing_duration_seconds", 0.95) * 1_000),
		CheckpointP95MS:       round(histogramQuantileDelta(before, after, "nodeflow_collector_topology_checkpoint_duration_seconds", 0.95) * 1_000),
		TopologyStateBytes:    after["nodeflow_collector_topology_state_bytes"],
		AllocatedBytes:        after["nodeflow_collector_process_allocated_bytes_total"] - before["nodeflow_collector_process_allocated_bytes_total"],
		Allocations:           after["nodeflow_collector_process_allocations_total"] - before["nodeflow_collector_process_allocations_total"],
	}, nil
}

func sampleSnapshotLatency(client *http.Client, target string, count int) (float64, error) {
	latencies := make([]float64, 0, count)
	for index := 0; index < count; index++ {
		started := time.Now()
		response, err := client.Get(target + "/api/snapshot")
		if err != nil {
			return 0, err
		}
		_, readErr := io.Copy(io.Discard, io.LimitReader(response.Body, 16*1_024*1_024))
		response.Body.Close()
		if readErr != nil {
			return 0, readErr
		}
		if response.StatusCode != http.StatusOK {
			return 0, fmt.Errorf("snapshot returned HTTP %d", response.StatusCode)
		}
		latencies = append(latencies, float64(time.Since(started).Microseconds())/1_000)
	}
	return percentile(latencies, .95), nil
}

var sequence atomic.Uint64

func send(ctx context.Context, client *http.Client, config config, count int, state *counters) {
	id := sequence.Add(1)
	spans := make([]*nodeflowv1.TelemetrySpan, count)
	now := float64(time.Now().UnixNano()) / 1_000_000
	for index := range spans {
		spanID := fmt.Sprintf("%016x", id*uint64(config.eventsPerRequest)+uint64(index))
		spans[index] = &nodeflowv1.TelemetrySpan{
			TraceId: fmt.Sprintf("%032x", id), SpanId: spanID, Name: "GET /load",
			Kind: nodeflowv1.SpanKind_SPAN_KIND_HTTP_ROUTE, StartTimeUnixMs: now,
			DurationMs: 1, Status: nodeflowv1.SpanStatus_SPAN_STATUS_OK,
			Attributes: map[string]*nodeflowv1.AttributeValue{
				"http.route": {Value: &nodeflowv1.AttributeValue_StringValue{StringValue: "/load"}},
			},
		}
	}
	payload, err := proto.Marshal(&nodeflowv1.TelemetryEnvelope{
		ProtocolVersion: "1.0",
		Payload: &nodeflowv1.TelemetryEnvelope_SpanBatch{SpanBatch: &nodeflowv1.SpanBatch{
			ServiceName: config.service, NodeVersion: "loadgen", Spans: spans,
		}},
	})
	state.attempted.Add(uint64(count))
	if err != nil {
		state.failed.Add(uint64(count))
		return
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, config.target+"/v1/telemetry", bytes.NewReader(payload))
	if err != nil {
		state.failed.Add(uint64(count))
		return
	}
	request.Header.Set("Content-Type", "application/x-protobuf")
	started := time.Now()
	response, err := client.Do(request)
	latency := float64(time.Since(started).Microseconds()) / 1_000
	state.mutex.Lock()
	state.latencies = append(state.latencies, latency)
	state.mutex.Unlock()
	if err != nil {
		state.failed.Add(uint64(count))
		return
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4_096))
	response.Body.Close()
	if response.StatusCode == http.StatusAccepted {
		state.accepted.Add(uint64(count))
	} else if response.StatusCode == http.StatusTooManyRequests || response.StatusCode == http.StatusInsufficientStorage {
		state.rejected.Add(uint64(count))
	} else {
		state.failed.Add(uint64(count))
	}
}

func waitUntilProcessed(ctx context.Context, client *http.Client, target string, expected float64, timeout time.Duration) bool {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		values, err := scrape(client, target)
		if err == nil && values["nodeflow_collector_telemetry_processed_total"] >= expected {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-deadline.C:
			return false
		case <-ticker.C:
		}
	}
}

func waitUntilReady(ctx context.Context, client *http.Client, target string) error {
	for attempt := 0; attempt < 30; attempt++ {
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, target+"/readyz", nil)
		response, err := client.Do(request)
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return fmt.Errorf("collector at %s did not become ready", target)
}

func sampleMetrics(ctx context.Context, client *http.Client, target string, result chan<- sample) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	peak := sample{}
	for {
		select {
		case <-ctx.Done():
			result <- peak
			return
		case <-ticker.C:
			values, err := scrape(client, target)
			if err == nil {
				peak.heap = max(peak.heap, values["nodeflow_collector_process_heap_bytes"])
				peak.queue = max(peak.queue, values["nodeflow_collector_queue_depth"])
				peak.spool = max(peak.spool, values["nodeflow_collector_spool_bytes"])
				peak.wal = max(peak.wal, values["nodeflow_collector_wal_bytes"])
				peak.segments = max(peak.segments, values["nodeflow_collector_wal_segments"])
			}
		}
	}
}

func scrape(client *http.Client, target string) (map[string]float64, error) {
	response, err := client.Get(target + "/metrics")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 2*1_024*1_024))
	if err != nil {
		return nil, err
	}
	values := make(map[string]float64)
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		if value, err := strconv.ParseFloat(fields[1], 64); err == nil {
			values[fields[0]] = value
		}
	}
	return values, nil
}

func histogramQuantileDelta(before, after map[string]float64, name string, quantile float64) float64 {
	total := after[name+"_count"] - before[name+"_count"]
	if total <= 0 {
		return 0
	}
	type bucket struct {
		upper float64
		count float64
	}
	buckets := make([]bucket, 0)
	prefix := name + `_bucket{le="`
	for key, current := range after {
		if !strings.HasPrefix(key, prefix) || !strings.HasSuffix(key, `"}`) {
			continue
		}
		raw := strings.TrimSuffix(strings.TrimPrefix(key, prefix), `"}`)
		upper, err := strconv.ParseFloat(raw, 64)
		if err != nil || math.IsInf(upper, 1) {
			continue
		}
		buckets = append(buckets, bucket{upper: upper, count: current - before[key]})
	}
	sort.Slice(buckets, func(i, j int) bool { return buckets[i].upper < buckets[j].upper })
	target := total * quantile
	for _, candidate := range buckets {
		if candidate.count >= target {
			return candidate.upper
		}
	}
	return 0
}

func percentile(values []float64, quantile float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sort.Float64s(values)
	index := max(0, int(math.Ceil(quantile*float64(len(values))))-1)
	return round(values[index])
}

func round(value float64) float64 { return math.Round(value*100) / 100 }
