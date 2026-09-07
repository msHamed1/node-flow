package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"time"

	collectormetrics "github.com/msHamed1/node-flow/services/collector/internal/metrics"
	"github.com/msHamed1/node-flow/services/collector/internal/pipeline"
	"github.com/msHamed1/node-flow/services/collector/internal/telemetry"
)

type API struct {
	pipeline     *pipeline.Pipeline
	metrics      *collectormetrics.Collector
	logger       *slog.Logger
	limits       telemetry.Limits
	maxBodyBytes int64
	version      string
}

func New(pipeline *pipeline.Pipeline, metrics *collectormetrics.Collector, logger *slog.Logger, maxBodyBytes int64, version string) *API {
	return &API{
		pipeline: pipeline, metrics: metrics, logger: logger, limits: telemetry.DefaultLimits(),
		maxBodyBytes: maxBodyBytes, version: version,
	}
}

func (api *API) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/telemetry", api.protobufTelemetry)
	mux.HandleFunc("POST /api/spans", api.legacySpans)
	mux.HandleFunc("POST /api/runtime", api.legacyRuntime)
	mux.HandleFunc("GET /healthz", api.health)
	mux.HandleFunc("GET /api/health", api.health)
	mux.HandleFunc("GET /readyz", api.ready)
	mux.Handle("GET /metrics", api.metrics.Handler())
	return recoverMiddleware(api.logger, securityHeaders(mux))
}

func (api *API) HTTPServer(address string) *http.Server {
	return &http.Server{
		Addr:              address,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 * 1_024,
	}
}

func (api *API) protobufTelemetry(response http.ResponseWriter, request *http.Request) {
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || (mediaType != "application/x-protobuf" && mediaType != "application/octet-stream") {
		api.metrics.RecordRejected("invalid", 1)
		writeError(response, http.StatusUnsupportedMediaType, "expected application/x-protobuf")
		return
	}
	data, err := api.readBody(response, request)
	if err != nil {
		api.rejectInvalid(response, err)
		return
	}
	envelope, err := telemetry.DecodeProtobuf(data)
	if err != nil {
		api.rejectInvalid(response, err)
		return
	}
	api.accept(response, request, &envelope)
}

func (api *API) legacySpans(response http.ResponseWriter, request *http.Request) {
	var batch telemetry.SpanBatch
	if err := api.decodeJSON(response, request, &batch); err != nil {
		api.rejectInvalid(response, err)
		return
	}
	api.accept(response, request, &telemetry.Envelope{ProtocolVersion: telemetry.ProtocolVersion, SpanBatch: &batch})
}

func (api *API) legacyRuntime(response http.ResponseWriter, request *http.Request) {
	var runtime telemetry.RuntimeMetrics
	if err := api.decodeJSON(response, request, &runtime); err != nil {
		api.rejectInvalid(response, err)
		return
	}
	api.accept(response, request, &telemetry.Envelope{ProtocolVersion: telemetry.ProtocolVersion, RuntimeMetrics: &runtime})
}

func (api *API) accept(response http.ResponseWriter, request *http.Request, envelope *telemetry.Envelope) {
	if err := telemetry.ValidateAndSanitize(envelope, api.limits); err != nil {
		api.rejectInvalid(response, err)
		return
	}
	err := api.pipeline.Enqueue(request.Context(), *envelope)
	if err != nil {
		switch {
		case errors.Is(err, pipeline.ErrQueueFull):
			response.Header().Set("Retry-After", "1")
			writeError(response, http.StatusTooManyRequests, err.Error())
		case errors.Is(err, pipeline.ErrSpoolFull):
			response.Header().Set("Retry-After", "5")
			writeError(response, http.StatusInsufficientStorage, err.Error())
		case errors.Is(err, pipeline.ErrClosed):
			writeError(response, http.StatusServiceUnavailable, err.Error())
		case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
			return
		default:
			writeError(response, http.StatusServiceUnavailable, "collector admission failed")
		}
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(http.StatusAccepted)
	if envelope.SpanBatch != nil {
		_ = json.NewEncoder(response).Encode(map[string]int{"accepted": len(envelope.SpanBatch.Spans)})
	}
}

func (api *API) health(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]any{
		"ok": true, "component": "collector", "language": "go", "version": api.version,
	})
}

func (api *API) ready(response http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), time.Second)
	defer cancel()
	if err := api.pipeline.Ready(ctx); err != nil {
		writeError(response, http.StatusServiceUnavailable, "collector is not ready")
		return
	}
	writeJSON(response, http.StatusOK, map[string]bool{"ready": true})
}

func (api *API) decodeJSON(response http.ResponseWriter, request *http.Request, target any) error {
	data, err := api.readBody(response, request)
	if err != nil {
		return err
	}
	return telemetry.DecodeJSON(bytes.NewReader(data), target)
}

func (api *API) readBody(response http.ResponseWriter, request *http.Request) ([]byte, error) {
	request.Body = http.MaxBytesReader(response, request.Body, api.maxBodyBytes)
	data, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, fmt.Errorf("read request body: %w", err)
	}
	if len(data) == 0 {
		return nil, errors.New("request body is required")
	}
	return data, nil
}

func (api *API) rejectInvalid(response http.ResponseWriter, err error) {
	api.metrics.RecordRejected("invalid", 1)
	status := http.StatusBadRequest
	var maxBytesError *http.MaxBytesError
	if errors.As(err, &maxBytesError) {
		status = http.StatusRequestEntityTooLarge
	}
	writeError(response, status, err.Error())
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(response, request)
	})
}

func recoverMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				logger.Error("collector handler panic", "error", recovered)
				writeError(response, http.StatusInternalServerError, "internal collector error")
			}
		}()
		next.ServeHTTP(response, request)
	})
}

func writeError(response http.ResponseWriter, status int, message string) {
	writeJSON(response, status, map[string]string{"error": message})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}
