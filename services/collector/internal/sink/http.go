package sink

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	collectormetrics "github.com/msHamed1/node-flow/services/collector/internal/metrics"
	"github.com/msHamed1/node-flow/services/collector/internal/pipeline"
	"github.com/msHamed1/node-flow/services/collector/internal/telemetry"
)

type HTTP struct {
	baseURL string
	client  *http.Client
	metrics *collectormetrics.Collector
	logger  *slog.Logger
}

func NewHTTP(rawURL string, timeout time.Duration, metrics *collectormetrics.Collector, logger *slog.Logger) (*HTTP, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("invalid topology URL %q", rawURL)
	}
	return &HTTP{
		baseURL: strings.TrimRight(parsed.String(), "/"),
		client:  &http.Client{Timeout: timeout},
		metrics: metrics,
		logger:  logger,
	}, nil
}

func (sink *HTTP) ConsumeBatch(ctx context.Context, envelopes []telemetry.Envelope) ([]pipeline.Outcome, error) {
	outcomes := make([]pipeline.Outcome, len(envelopes))
	groups := make(map[string]*spanGroup)
	runtimes := make(map[string]*telemetry.RuntimeMetrics)

	for index, envelope := range envelopes {
		if envelope.SpanBatch != nil {
			key := envelope.SpanBatch.ServiceName + "\x00" + envelope.SpanBatch.NodeVersion
			group := groups[key]
			if group == nil {
				group = &spanGroup{batch: telemetry.SpanBatch{
					ServiceName: envelope.SpanBatch.ServiceName,
					NodeVersion: envelope.SpanBatch.NodeVersion,
				}}
				groups[key] = group
			}
			group.batch.Spans = append(group.batch.Spans, envelope.SpanBatch.Spans...)
			group.indexes = append(group.indexes, index)
		}
		if envelope.RuntimeMetrics != nil {
			current := runtimes[envelope.RuntimeMetrics.ServiceName]
			if current == nil || current.Timestamp <= envelope.RuntimeMetrics.Timestamp {
				runtimes[envelope.RuntimeMetrics.ServiceName] = envelope.RuntimeMetrics
			}
		}
	}

	spanKeys := sortedKeys(groups)
	for _, key := range spanKeys {
		group := groups[key]
		var acknowledgement struct {
			Revision uint64 `json:"revision"`
		}
		if err := sink.postJSON(ctx, "/api/spans", group.batch, &acknowledgement); err != nil {
			return nil, err
		}
		for _, index := range group.indexes {
			revision := acknowledgement.Revision
			outcomes[index].Revision = &revision
		}
	}

	runtimeKeys := sortedKeys(runtimes)
	for _, serviceName := range runtimeKeys {
		if err := sink.postJSON(ctx, "/api/runtime", runtimes[serviceName], nil); err != nil {
			return nil, err
		}
	}

	if len(spanKeys) > 0 {
		sink.observeTopology(ctx)
	}
	return outcomes, nil
}

func (sink *HTTP) Ready(ctx context.Context) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, sink.baseURL+"/api/health", nil)
	if err != nil {
		return err
	}
	response, err := sink.client.Do(request)
	if err != nil {
		return fmt.Errorf("topology health request: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4_096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("topology health returned HTTP %d", response.StatusCode)
	}
	return nil
}

func (sink *HTTP) Close() error {
	sink.client.CloseIdleConnections()
	return nil
}

func (sink *HTTP) postJSON(ctx context.Context, path string, payload any, target any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode topology payload: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, sink.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "nodeflow-go-collector/2")
	response, err := sink.client.Do(request)
	if err != nil {
		return fmt.Errorf("deliver telemetry to topology service: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4_096))
		return fmt.Errorf("topology service returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(message)))
	}
	if target != nil {
		if err := json.NewDecoder(io.LimitReader(response.Body, 64*1_024)).Decode(target); err != nil && !errors.Is(err, io.EOF) {
			return fmt.Errorf("decode topology acknowledgement: %w", err)
		}
	} else {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4_096))
	}
	return nil
}

func (sink *HTTP) observeTopology(ctx context.Context) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, sink.baseURL+"/api/snapshot", nil)
	if err != nil {
		return
	}
	response, err := sink.client.Do(request)
	if err != nil {
		sink.logger.Debug("could not sample topology size", "error", err)
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return
	}
	var snapshot struct {
		Nodes []json.RawMessage `json:"nodes"`
		Edges []json.RawMessage `json:"edges"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 8*1_024*1_024)).Decode(&snapshot); err == nil {
		sink.metrics.SetTopology(len(snapshot.Nodes), len(snapshot.Edges))
	}
}

type spanGroup struct {
	batch   telemetry.SpanBatch
	indexes []int
}

func sortedKeys[T any](values map[string]T) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
