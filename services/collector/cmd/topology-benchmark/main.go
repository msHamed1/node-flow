package main

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"sort"
	"time"

	"github.com/msHamed1/node-flow/services/collector/internal/topology"
)

type request struct {
	SnapshotIterations int        `json:"snapshotIterations"`
	Workloads          []workload `json:"workloads"`
}

type workload struct {
	Name    string  `json:"name"`
	Batches []batch `json:"batches"`
}

type batch struct {
	ServiceName string          `json:"serviceName"`
	NodeVersion string          `json:"nodeVersion,omitempty"`
	Spans       []topology.Span `json:"spans"`
}

type response struct {
	GoVersion string   `json:"goVersion"`
	Results   []result `json:"results"`
}

type result struct {
	Name      string          `json:"name"`
	Spans     int             `json:"spans"`
	Updates   int             `json:"updates"`
	Ingestion ingestionResult `json:"ingestion"`
	Snapshot  snapshotResult  `json:"snapshot"`
	Memory    memoryResult    `json:"memory"`
	Topology  topologyResult  `json:"topology"`
}

type ingestionResult struct {
	ElapsedMS        float64 `json:"elapsedMs"`
	SpansPerSecond   float64 `json:"spansPerSecond"`
	UpdatesPerSecond float64 `json:"updatesPerSecond"`
}

type snapshotResult struct {
	Iterations     int     `json:"iterations"`
	P50MS          float64 `json:"p50Ms"`
	P95MS          float64 `json:"p95Ms"`
	AllocatedBytes uint64  `json:"allocatedBytes"`
	Allocations    uint64  `json:"allocations"`
}

type memoryResult struct {
	RetainedHeapBytes int64  `json:"retainedHeapBytes"`
	AllocatedBytes    uint64 `json:"allocatedBytes"`
	Allocations       uint64 `json:"allocations"`
}

type topologyResult struct {
	Nodes int `json:"nodes"`
	Edges int `json:"edges"`
	Paths int `json:"paths"`
}

func main() {
	var input request
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		fail("decode request: %v", err)
	}
	if input.SnapshotIterations <= 0 {
		input.SnapshotIterations = 1000
	}
	output := response{GoVersion: runtime.Version(), Results: make([]result, 0, len(input.Workloads))}
	for _, candidate := range input.Workloads {
		output.Results = append(output.Results, run(candidate, input.SnapshotIterations))
	}
	if err := json.NewEncoder(os.Stdout).Encode(output); err != nil {
		fail("encode response: %v", err)
	}
}

func run(candidate workload, snapshotIterations int) result {
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)

	engine := topology.New(topology.Options{NodeVersion: "v22.0.0"})
	spanCount := 0
	started := time.Now()
	for _, telemetryBatch := range candidate.Batches {
		nodeVersion := telemetryBatch.NodeVersion
		if nodeVersion == "" {
			nodeVersion = "v22.0.0"
		}
		engine.RegisterApplication(telemetryBatch.ServiceName, nodeVersion)
		engine.Ingest(telemetryBatch.Spans)
		spanCount += len(telemetryBatch.Spans)
	}
	ingestionElapsed := time.Since(started)
	runtime.GC()
	var afterIngestion runtime.MemStats
	runtime.ReadMemStats(&afterIngestion)

	latencies := make([]float64, 0, snapshotIterations)
	var beforeSnapshots runtime.MemStats
	runtime.ReadMemStats(&beforeSnapshots)
	for iteration := 0; iteration < snapshotIterations; iteration++ {
		started = time.Now()
		_ = engine.CreateSnapshot()
		latencies = append(latencies, float64(time.Since(started))/float64(time.Millisecond))
	}
	var afterSnapshots runtime.MemStats
	runtime.ReadMemStats(&afterSnapshots)
	topologySnapshot := engine.CreateSnapshot()
	runtime.KeepAlive(engine)

	elapsedSeconds := ingestionElapsed.Seconds()
	return result{
		Name: candidate.Name, Spans: spanCount, Updates: len(candidate.Batches),
		Ingestion: ingestionResult{
			ElapsedMS:        float64(ingestionElapsed) / float64(time.Millisecond),
			SpansPerSecond:   float64(spanCount) / elapsedSeconds,
			UpdatesPerSecond: float64(len(candidate.Batches)) / elapsedSeconds,
		},
		Snapshot: snapshotResult{
			Iterations: snapshotIterations, P50MS: percentile(latencies, .50), P95MS: percentile(latencies, .95),
			AllocatedBytes: afterSnapshots.TotalAlloc - beforeSnapshots.TotalAlloc,
			Allocations:    afterSnapshots.Mallocs - beforeSnapshots.Mallocs,
		},
		Memory: memoryResult{
			RetainedHeapBytes: int64(afterIngestion.HeapAlloc) - int64(before.HeapAlloc),
			AllocatedBytes:    afterIngestion.TotalAlloc - before.TotalAlloc,
			Allocations:       afterIngestion.Mallocs - before.Mallocs,
		},
		Topology: topologyResult{Nodes: len(topologySnapshot.Nodes), Edges: len(topologySnapshot.Edges), Paths: len(topologySnapshot.Paths)},
	}
}

func percentile(values []float64, fraction float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sort.Float64s(values)
	index := int(float64(len(values)-1) * fraction)
	return values[index]
}

func fail(format string, args ...any) {
	_, _ = fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
