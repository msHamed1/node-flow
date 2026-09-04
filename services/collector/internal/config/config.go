package config

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddress     string
	TopologyURL       string
	TopologyEngine    string
	TopologyStatePath string
	DashboardDir      string
	Sink              string
	Workers           int
	QueueSize         int
	BatchSize         int
	FlushInterval     time.Duration
	MaxBodyBytes      int64
	SinkTimeout       time.Duration
	ShutdownTimeout   time.Duration
	LogLevel          string
	SpoolMode         string
	SpoolDirectory    string
	SpoolMaxBytes     int64
	WALSegmentBytes   int64
	WALBatchRecords   int
	WALFlushInterval  time.Duration
	WALAppendQueue    int
	RetryInitial      time.Duration
	RetryMax          time.Duration
	RetryAttempts     int
	RetryJitter       float64
}

func Load() (Config, error) {
	workers := runtime.GOMAXPROCS(0)
	if workers > 32 {
		workers = 32
	}
	spoolDirectory := env("NODEFLOW_SPOOL_DIR", ".nodeflow/spool")
	config := Config{
		ListenAddress:     env("NODEFLOW_GO_LISTEN_ADDR", ":7331"),
		TopologyURL:       env("NODEFLOW_TOPOLOGY_URL", "http://127.0.0.1:7331"),
		TopologyEngine:    strings.ToLower(env("NODEFLOW_TOPOLOGY_ENGINE", "go")),
		TopologyStatePath: env("NODEFLOW_TOPOLOGY_STATE_PATH", filepath.Join(spoolDirectory, "topology-state.json")),
		DashboardDir:      env("NODEFLOW_DASHBOARD_DIR", ""),
		Sink:              strings.ToLower(env("NODEFLOW_SINK", "topology")),
		Workers:           workers,
		QueueSize:         10_000,
		BatchSize:         250,
		FlushInterval:     500 * time.Millisecond,
		MaxBodyBytes:      2 * 1_024 * 1_024,
		SinkTimeout:       5 * time.Second,
		ShutdownTimeout:   15 * time.Second,
		LogLevel:          strings.ToLower(env("NODEFLOW_LOG_LEVEL", "info")),
		SpoolMode:         strings.ToLower(env("NODEFLOW_SPOOL_MODE", "group-commit")),
		SpoolDirectory:    spoolDirectory,
		SpoolMaxBytes:     512 * 1_024 * 1_024,
		WALSegmentBytes:   16 * 1_024 * 1_024,
		WALBatchRecords:   64,
		WALFlushInterval:  2 * time.Millisecond,
		WALAppendQueue:    2_048,
		RetryInitial:      100 * time.Millisecond,
		RetryMax:          30 * time.Second,
		RetryAttempts:     10,
		RetryJitter:       0.2,
	}
	var err error
	if config.Workers, err = integer("NODEFLOW_WORKERS", config.Workers); err != nil {
		return Config{}, err
	}
	if config.QueueSize, err = integer("NODEFLOW_QUEUE_SIZE", config.QueueSize); err != nil {
		return Config{}, err
	}
	if config.BatchSize, err = integer("NODEFLOW_BATCH_SIZE", config.BatchSize); err != nil {
		return Config{}, err
	}
	if config.MaxBodyBytes, err = integer64("NODEFLOW_MAX_BODY_BYTES", config.MaxBodyBytes); err != nil {
		return Config{}, err
	}
	if config.FlushInterval, err = duration("NODEFLOW_FLUSH_INTERVAL", config.FlushInterval); err != nil {
		return Config{}, err
	}
	if config.SinkTimeout, err = duration("NODEFLOW_SINK_TIMEOUT", config.SinkTimeout); err != nil {
		return Config{}, err
	}
	if config.ShutdownTimeout, err = duration("NODEFLOW_SHUTDOWN_TIMEOUT", config.ShutdownTimeout); err != nil {
		return Config{}, err
	}
	if config.SpoolMaxBytes, err = integer64("NODEFLOW_SPOOL_MAX_BYTES", config.SpoolMaxBytes); err != nil {
		return Config{}, err
	}
	if config.WALSegmentBytes, err = integer64("NODEFLOW_WAL_SEGMENT_BYTES", config.WALSegmentBytes); err != nil {
		return Config{}, err
	}
	if config.WALBatchRecords, err = integer("NODEFLOW_WAL_GROUP_MAX_RECORDS", config.WALBatchRecords); err != nil {
		return Config{}, err
	}
	if config.WALFlushInterval, err = duration("NODEFLOW_WAL_GROUP_MAX_DELAY", config.WALFlushInterval); err != nil {
		return Config{}, err
	}
	if config.WALAppendQueue, err = integer("NODEFLOW_WAL_APPEND_QUEUE_SIZE", config.WALAppendQueue); err != nil {
		return Config{}, err
	}
	if config.RetryInitial, err = duration("NODEFLOW_RETRY_INITIAL_BACKOFF", config.RetryInitial); err != nil {
		return Config{}, err
	}
	if config.RetryMax, err = duration("NODEFLOW_RETRY_MAX_BACKOFF", config.RetryMax); err != nil {
		return Config{}, err
	}
	if config.RetryAttempts, err = integer("NODEFLOW_RETRY_MAX_ATTEMPTS", config.RetryAttempts); err != nil {
		return Config{}, err
	}
	if config.RetryJitter, err = decimal("NODEFLOW_RETRY_JITTER", config.RetryJitter); err != nil {
		return Config{}, err
	}
	if config.Workers < 1 || config.QueueSize < 1 || config.BatchSize < 1 || config.BatchSize > config.QueueSize || config.MaxBodyBytes < 1 {
		return Config{}, fmt.Errorf("collector limits must be positive and batch size cannot exceed queue size")
	}
	if config.TopologyEngine != "go" && config.TopologyEngine != "typescript" {
		return Config{}, fmt.Errorf("NODEFLOW_TOPOLOGY_ENGINE must be go or typescript")
	}
	if config.Sink != "topology" && config.Sink != "http" && config.Sink != "discard" {
		return Config{}, fmt.Errorf("NODEFLOW_SINK must be topology, http, or discard")
	}
	if config.LogLevel != "debug" && config.LogLevel != "info" && config.LogLevel != "warn" && config.LogLevel != "error" {
		return Config{}, fmt.Errorf("NODEFLOW_LOG_LEVEL must be debug, info, warn, or error")
	}
	if config.SpoolMode == "durable" {
		config.SpoolMode = "group-commit"
	}
	if config.SpoolMode != "group-commit" && config.SpoolMode != "sync" &&
		config.SpoolMode != "legacy" && config.SpoolMode != "memory" {
		return Config{}, fmt.Errorf("NODEFLOW_SPOOL_MODE must be group-commit, sync, legacy, durable, or memory")
	}
	if config.SpoolMaxBytes < 1 || config.RetryAttempts < 1 || config.RetryAttempts > 99_999 ||
		config.RetryMax < config.RetryInitial || config.RetryJitter < 0 || config.RetryJitter > 1 {
		return Config{}, fmt.Errorf("durable spool and retry settings are invalid")
	}
	if (config.SpoolMode == "group-commit" || config.SpoolMode == "sync") &&
		(config.WALSegmentBytes < config.MaxBodyBytes+4_096 || config.WALSegmentBytes > int64(^uint32(0)) ||
			config.WALBatchRecords < 1 || config.WALAppendQueue < 1) {
		return Config{}, fmt.Errorf("WAL segment and group commit settings are invalid")
	}
	return config, nil
}

func decimal(name string, fallback float64) (float64, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be a decimal number: %w", name, err)
	}
	return value, nil
}

func env(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func integer(name string, fallback int) (int, error) {
	value, err := integer64(name, int64(fallback))
	return int(value), err
}

func integer64(name string, fallback int64) (int64, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer: %w", name, err)
	}
	return value, nil
}

func duration(name string, fallback time.Duration) (time.Duration, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive Go duration", name)
	}
	return value, nil
}
