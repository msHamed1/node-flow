package config

import (
	"testing"
	"time"
)

func TestLoadOverridesCollectorLimits(t *testing.T) {
	t.Setenv("NODEFLOW_GO_LISTEN_ADDR", "127.0.0.1:9000")
	t.Setenv("NODEFLOW_TOPOLOGY_URL", "http://topology:7331")
	t.Setenv("NODEFLOW_WORKERS", "8")
	t.Setenv("NODEFLOW_QUEUE_SIZE", "1000")
	t.Setenv("NODEFLOW_BATCH_SIZE", "100")
	t.Setenv("NODEFLOW_FLUSH_INTERVAL", "250ms")
	t.Setenv("NODEFLOW_SHUTDOWN_TIMEOUT", "20s")
	t.Setenv("NODEFLOW_SPOOL_MODE", "durable")
	t.Setenv("NODEFLOW_SPOOL_DIR", "/tmp/nodeflow-test-spool")
	t.Setenv("NODEFLOW_SPOOL_MAX_BYTES", "1048576")
	t.Setenv("NODEFLOW_RETRY_INITIAL_BACKOFF", "10ms")
	t.Setenv("NODEFLOW_RETRY_MAX_BACKOFF", "2s")
	t.Setenv("NODEFLOW_RETRY_MAX_ATTEMPTS", "7")
	t.Setenv("NODEFLOW_RETRY_JITTER", "0.1")

	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if config.ListenAddress != "127.0.0.1:9000" || config.TopologyURL != "http://topology:7331" {
		t.Fatalf("endpoint overrides were not loaded: %#v", config)
	}
	if config.Workers != 8 || config.QueueSize != 1000 || config.BatchSize != 100 {
		t.Fatalf("limit overrides were not loaded: %#v", config)
	}
	if config.FlushInterval != 250*time.Millisecond || config.ShutdownTimeout != 20*time.Second {
		t.Fatalf("duration overrides were not loaded: %#v", config)
	}
	if config.SpoolDirectory != "/tmp/nodeflow-test-spool" || config.SpoolMaxBytes != 1_048_576 ||
		config.RetryInitial != 10*time.Millisecond || config.RetryMax != 2*time.Second ||
		config.RetryAttempts != 7 || config.RetryJitter != 0.1 {
		t.Fatalf("durable overrides were not loaded: %#v", config)
	}
}

func TestLoadRejectsInvalidDurableConfiguration(t *testing.T) {
	t.Setenv("NODEFLOW_RETRY_INITIAL_BACKOFF", "2s")
	t.Setenv("NODEFLOW_RETRY_MAX_BACKOFF", "1s")
	if _, err := Load(); err == nil {
		t.Fatal("expected invalid retry limits to fail")
	}
}

func TestLoadRejectsInvalidConfiguration(t *testing.T) {
	t.Setenv("NODEFLOW_QUEUE_SIZE", "10")
	t.Setenv("NODEFLOW_BATCH_SIZE", "20")
	if _, err := Load(); err == nil {
		t.Fatal("expected invalid limits to fail")
	}
}
