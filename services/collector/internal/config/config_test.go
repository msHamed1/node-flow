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
}

func TestLoadRejectsInvalidConfiguration(t *testing.T) {
	t.Setenv("NODEFLOW_QUEUE_SIZE", "10")
	t.Setenv("NODEFLOW_BATCH_SIZE", "20")
	if _, err := Load(); err == nil {
		t.Fatal("expected invalid limits to fail")
	}
}
