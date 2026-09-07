package sink

import (
	"context"

	"github.com/msHamed1/node-flow/services/collector/internal/pipeline"
	"github.com/msHamed1/node-flow/services/collector/internal/telemetry"
)

// Discard is only for isolated collector benchmarks. Production and integration
// environments use the HTTP topology sink.
type Discard struct{}

func (Discard) ConsumeBatch(_ context.Context, envelopes []telemetry.Envelope) ([]pipeline.Outcome, error) {
	return make([]pipeline.Outcome, len(envelopes)), nil
}

func (Discard) Ready(context.Context) error { return nil }
func (Discard) Close() error                { return nil }
