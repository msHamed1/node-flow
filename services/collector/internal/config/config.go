package config

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddress   string
	TopologyURL     string
	Sink            string
	Workers         int
	QueueSize       int
	BatchSize       int
	FlushInterval   time.Duration
	MaxBodyBytes    int64
	SinkTimeout     time.Duration
	ShutdownTimeout time.Duration
	LogLevel        string
}

func Load() (Config, error) {
	workers := runtime.GOMAXPROCS(0)
	if workers > 32 {
		workers = 32
	}
	config := Config{
		ListenAddress:   env("NODEFLOW_GO_LISTEN_ADDR", ":4318"),
		TopologyURL:     env("NODEFLOW_TOPOLOGY_URL", "http://127.0.0.1:7331"),
		Sink:            strings.ToLower(env("NODEFLOW_SINK", "http")),
		Workers:         workers,
		QueueSize:       10_000,
		BatchSize:       250,
		FlushInterval:   500 * time.Millisecond,
		MaxBodyBytes:    2 * 1_024 * 1_024,
		SinkTimeout:     5 * time.Second,
		ShutdownTimeout: 15 * time.Second,
		LogLevel:        strings.ToLower(env("NODEFLOW_LOG_LEVEL", "info")),
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
	if config.Workers < 1 || config.QueueSize < 1 || config.BatchSize < 1 || config.BatchSize > config.QueueSize || config.MaxBodyBytes < 1 {
		return Config{}, fmt.Errorf("collector limits must be positive and batch size cannot exceed queue size")
	}
	if config.Sink != "http" && config.Sink != "discard" {
		return Config{}, fmt.Errorf("NODEFLOW_SINK must be http or discard")
	}
	if config.LogLevel != "debug" && config.LogLevel != "info" && config.LogLevel != "warn" && config.LogLevel != "error" {
		return Config{}, fmt.Errorf("NODEFLOW_LOG_LEVEL must be debug, info, warn, or error")
	}
	return config, nil
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
