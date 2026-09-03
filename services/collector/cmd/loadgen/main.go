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
	DurationSeconds       float64 `json:"durationSeconds"`
	AttemptedEvents       uint64  `json:"attemptedEvents"`
	AcceptedEvents        uint64  `json:"acceptedEvents"`
	RejectedEvents        uint64  `json:"rejectedEvents"`
	FailedEvents          uint64  `json:"failedEvents"`
	ThroughputEventsSec   float64 `json:"throughputEventsPerSecond"`
	LatencyP50MS          float64 `json:"latencyP50Ms"`
	LatencyP95MS          float64 `json:"latencyP95Ms"`
	PeakHeapBytes         float64 `json:"peakCollectorHeapBytes"`
	PeakQueueDepth        float64 `json:"peakQueueDepth"`
	AverageCPUPercent     float64 `json:"averageCollectorCpuPercent"`
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
	heap  float64
	queue float64
	cpu   float64
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

	before, _ := scrape(client, config.target)
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
	stopSampling()
	peak := <-samples
	after, _ := scrape(client, config.target)

	state.mutex.Lock()
	latencies := append([]float64(nil), state.latencies...)
	state.mutex.Unlock()
	accepted := state.accepted.Load()
	cpuDelta := after["nodeflow_collector_process_cpu_seconds_total"] - before["nodeflow_collector_process_cpu_seconds_total"]
	return result{
		TargetEventsPerSecond: config.rate,
		DurationSeconds:       round(elapsed.Seconds()),
		AttemptedEvents:       state.attempted.Load(),
		AcceptedEvents:        accepted,
		RejectedEvents:        state.rejected.Load(),
		FailedEvents:          state.failed.Load(),
		ThroughputEventsSec:   round(float64(accepted) / elapsed.Seconds()),
		LatencyP50MS:          percentile(latencies, 0.50),
		LatencyP95MS:          percentile(latencies, 0.95),
		PeakHeapBytes:         peak.heap,
		PeakQueueDepth:        peak.queue,
		AverageCPUPercent:     round(cpuDelta / elapsed.Seconds() * 100),
	}, nil
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
	} else if response.StatusCode == http.StatusTooManyRequests {
		state.rejected.Add(uint64(count))
	} else {
		state.failed.Add(uint64(count))
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
		if line == "" || strings.HasPrefix(line, "#") || strings.Contains(line, "{") {
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

func percentile(values []float64, quantile float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sort.Float64s(values)
	index := max(0, int(math.Ceil(quantile*float64(len(values))))-1)
	return round(values[index])
}

func round(value float64) float64 { return math.Round(value*100) / 100 }
