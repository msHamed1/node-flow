package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/msHamed1/node-flow/services/collector/internal/config"
	collectormetrics "github.com/msHamed1/node-flow/services/collector/internal/metrics"
	"github.com/msHamed1/node-flow/services/collector/internal/pipeline"
	collectorserver "github.com/msHamed1/node-flow/services/collector/internal/server"
	"github.com/msHamed1/node-flow/services/collector/internal/sink"
	"github.com/msHamed1/node-flow/services/collector/internal/spool"
)

var version = "dev"

func main() {
	config, err := config.Load()
	if err != nil {
		fatal("invalid collector configuration", err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel(config.LogLevel)}))
	metrics := collectormetrics.New()
	var durableSpool *spool.Store
	if config.SpoolMode == "durable" {
		var recovery spool.Recovery
		durableSpool, recovery, err = spool.Open(spool.Config{
			Directory: config.SpoolDirectory, MaxBytes: config.SpoolMaxBytes,
		}, metrics)
		if err != nil {
			fatal("open durable collector spool", err)
		}
		metrics.RecordSpoolReplay(uint64(recovery.Records))
		logger.Info("durable collector spool ready", "directory", config.SpoolDirectory,
			"max_bytes", config.SpoolMaxBytes, "recovered_records", recovery.Records,
			"recovered_bytes", recovery.Bytes, "corruptions", recovery.Corruptions)
	}

	var telemetrySink pipeline.Sink
	if config.Sink == "discard" {
		logger.Warn("discard sink enabled; telemetry will not reach the topology engine")
		telemetrySink = sink.Discard{}
	} else {
		telemetrySink, err = sink.NewHTTP(config.TopologyURL, config.SinkTimeout, metrics, logger)
		if err != nil {
			fatal("configure topology sink", err)
		}
	}

	processor, err := pipeline.New(pipeline.Config{
		Workers: config.Workers, QueueSize: config.QueueSize, BatchSize: config.BatchSize,
		FlushInterval: config.FlushInterval, Spool: durableSpool,
		Retry: pipeline.RetryConfig{
			InitialBackoff: config.RetryInitial, MaxBackoff: config.RetryMax,
			MaxAttempts: config.RetryAttempts, Jitter: config.RetryJitter,
		},
	}, telemetrySink, metrics, logger)
	if err != nil {
		fatal("configure collector pipeline", err)
	}
	api := collectorserver.New(processor, metrics, logger, config.MaxBodyBytes, version)
	server := api.HTTPServer(config.ListenAddress)

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("NodeFlow Go collector started",
			"address", config.ListenAddress, "workers", config.Workers, "queue_size", config.QueueSize,
			"batch_size", config.BatchSize, "flush_interval", config.FlushInterval.String(),
			"sink", config.Sink, "spool_mode", config.SpoolMode)
		serverErrors <- server.ListenAndServe()
	}()

	signalContext, stopSignals := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stopSignals()
	var serveError error
	select {
	case <-signalContext.Done():
		logger.Info("collector shutdown requested", "signal", signalContext.Err())
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			serveError = err
			logger.Error("collector HTTP server stopped", "error", err)
		}
	}

	processor.CloseAdmission()
	shutdownContext, cancel := context.WithTimeout(context.Background(), config.ShutdownTimeout)
	defer cancel()
	if err := server.Shutdown(shutdownContext); err != nil {
		logger.Error("collector HTTP shutdown failed", "error", err)
	}
	if err := processor.Wait(shutdownContext); err != nil {
		logger.Error("collector drain failed", "error", err)
		os.Exit(1)
	}
	if serveError != nil {
		os.Exit(1)
	}
	logger.Info("NodeFlow Go collector stopped")
}

func logLevel(level string) slog.Level {
	return map[string]slog.Level{
		"debug": slog.LevelDebug,
		"info":  slog.LevelInfo,
		"warn":  slog.LevelWarn,
		"error": slog.LevelError,
	}[level]
}

func fatal(message string, err error) {
	slog.Error(message, "error", err)
	os.Exit(1)
}
