package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/msHamed1/node-flow/services/collector/internal/topology"
)

type request struct {
	Fixtures []fixture `json:"fixtures"`
}

type fixture struct {
	Name    string  `json:"name"`
	Batches []batch `json:"batches"`
}

type batch struct {
	ServiceName string          `json:"serviceName"`
	NodeVersion string          `json:"nodeVersion,omitempty"`
	Spans       []topology.Span `json:"spans"`
}

type response struct {
	Fixtures []fixtureResult `json:"fixtures"`
}

type fixtureResult struct {
	Name     string            `json:"name"`
	Snapshot topology.Snapshot `json:"snapshot"`
}

func main() {
	var input request
	decoder := json.NewDecoder(os.Stdin)
	if err := decoder.Decode(&input); err != nil {
		fail("decode request: %v", err)
	}
	output := response{Fixtures: make([]fixtureResult, 0, len(input.Fixtures))}
	for _, candidate := range input.Fixtures {
		engine := topology.New(topology.Options{NodeVersion: "v22.0.0"})
		for _, telemetryBatch := range candidate.Batches {
			nodeVersion := telemetryBatch.NodeVersion
			if nodeVersion == "" {
				nodeVersion = "v22.0.0"
			}
			engine.RegisterApplication(telemetryBatch.ServiceName, nodeVersion)
			engine.Ingest(telemetryBatch.Spans)
		}
		output.Fixtures = append(output.Fixtures, fixtureResult{Name: candidate.Name, Snapshot: engine.CreateSnapshot()})
	}
	if err := json.NewEncoder(os.Stdout).Encode(output); err != nil {
		fail("encode response: %v", err)
	}
}

func fail(format string, args ...any) {
	_, _ = fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
