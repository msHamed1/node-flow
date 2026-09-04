package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/msHamed1/node-flow/services/collector/internal/config"
	collectormetrics "github.com/msHamed1/node-flow/services/collector/internal/metrics"
	"github.com/msHamed1/node-flow/services/collector/internal/pipeline"
	collectorserver "github.com/msHamed1/node-flow/services/collector/internal/server"
	"github.com/msHamed1/node-flow/services/collector/internal/sink"
	"github.com/msHamed1/node-flow/services/collector/internal/spool"
	"github.com/msHamed1/node-flow/services/collector/internal/topology"
)

var version = "dev"

const publicAPIVersion = "0.1.0"

func main() {
	config, err := config.Load()
	if err != nil {
		fatal("invalid collector configuration", err)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel(config.LogLevel)}))
	metrics := collectormetrics.New()
	var durableSpool spool.Storage
	if config.SpoolMode == "legacy" {
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
	} else if config.SpoolMode == "group-commit" || config.SpoolMode == "sync" {
		groupRecords, groupDelay := config.WALBatchRecords, config.WALFlushInterval
		if config.SpoolMode == "sync" {
			groupRecords = 1
			groupDelay = time.Nanosecond
		}
		var recovery spool.Recovery
		durableSpool, recovery, err = spool.OpenWAL(spool.WALConfig{
			Directory: config.SpoolDirectory, MaxBytes: config.SpoolMaxBytes,
			SegmentBytes: config.WALSegmentBytes, MaxBatchRecords: groupRecords,
			MaxFlushInterval: groupDelay, AppendQueueSize: config.WALAppendQueue,
			MaxRecordAttempts: config.RetryAttempts,
		}, metrics)
		if err != nil {
			fatal("open collector WAL", err)
		}
		metrics.RecordSpoolReplay(uint64(recovery.Records))
		metrics.RecordWALReplay(uint64(recovery.Records))
		logger.Info("collector WAL ready", "directory", config.SpoolDirectory,
			"mode", config.SpoolMode, "max_bytes", config.SpoolMaxBytes,
			"segment_bytes", config.WALSegmentBytes, "group_max_records", groupRecords,
			"group_max_delay", groupDelay.String(), "recovered_records", recovery.Records,
			"recovered_bytes", recovery.Bytes, "segments", recovery.Segments,
			"truncated_bytes", recovery.Truncated, "corruptions", recovery.Corruptions)
	}

	var telemetrySink pipeline.Sink
	var topologyEngine *topology.Engine
	var topologyState *topology.StateStore
	var snapshotHub *collectorserver.SnapshotHub
	var topologyProxy http.Handler
	if config.Sink == "discard" {
		logger.Warn("discard sink enabled; telemetry will not reach the topology engine")
		telemetrySink = sink.Discard{}
	} else if config.TopologyEngine == "typescript" || config.Sink == "http" {
		telemetrySink, err = sink.NewHTTP(config.TopologyURL, config.SinkTimeout, metrics, logger)
		if err != nil {
			fatal("configure topology sink", err)
		}
		logger.Warn("TypeScript topology rollback mode enabled", "url", config.TopologyURL)
		topologyProxy, err = collectorserver.NewTopologyProxy(config.TopologyURL)
		if err != nil {
			fatal("configure topology proxy", err)
		}
	} else {
		topologyEngine, topologyState, err = topology.OpenStateStore(config.TopologyStatePath, topology.Options{})
		if err != nil {
			fatal("restore Go topology state", err)
		}
		snapshotHub = collectorserver.NewSnapshotHub(topologyEngine, publicAPIVersion)
		telemetrySink = sink.NewTopology(topologyEngine, metrics, snapshotHub, topologyState)
		restored := topologyEngine.LiveSnapshot()
		metrics.SetTopology(len(restored.Nodes), len(restored.Edges))
		logger.Info("Go topology state ready", "path", config.TopologyStatePath,
			"revision", restored.Revision, "nodes", len(restored.Nodes), "edges", len(restored.Edges))
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
	serverOptions := make([]collectorserver.Option, 0, 2)
	if topologyEngine != nil {
		serverOptions = append(serverOptions, collectorserver.WithTopology(topologyEngine, snapshotHub))
	} else if topologyProxy != nil {
		serverOptions = append(serverOptions, collectorserver.WithTopologyProxy(topologyProxy))
	}
	if config.DashboardDir != "" {
		serverOptions = append(serverOptions, collectorserver.WithDashboard(config.DashboardDir))
	}
	api := collectorserver.New(processor, metrics, logger, config.MaxBodyBytes, publicAPIVersion, serverOptions...)
	server := api.HTTPServer(config.ListenAddress)

	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("NodeFlow Go collector started",
			"address", config.ListenAddress, "workers", config.Workers, "queue_size", config.QueueSize,
			"batch_size", config.BatchSize, "flush_interval", config.FlushInterval.String(),
			"sink", config.Sink, "topology_engine", config.TopologyEngine, "spool_mode", config.SpoolMode,
			"binary_version", version)
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
	if snapshotHub != nil {
		snapshotHub.Close()
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
