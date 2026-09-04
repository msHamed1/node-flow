package config

import (
	"testing"
	"time"
)

func TestLoadOverridesCollectorLimits(t *testing.T) {
	t.Setenv("NODEFLOW_GO_LISTEN_ADDR", "127.0.0.1:9000")
	t.Setenv("NODEFLOW_TOPOLOGY_URL", "http://topology:7331")
	t.Setenv("NODEFLOW_TOPOLOGY_ENGINE", "typescript")
	t.Setenv("NODEFLOW_TOPOLOGY_STATE_PATH", "/tmp/nodeflow-topology-state.json")
	t.Setenv("NODEFLOW_DASHBOARD_DIR", "/tmp/nodeflow-dashboard")
	t.Setenv("NODEFLOW_SINK", "http")
	t.Setenv("NODEFLOW_WORKERS", "8")
	t.Setenv("NODEFLOW_QUEUE_SIZE", "1000")
	t.Setenv("NODEFLOW_BATCH_SIZE", "100")
	t.Setenv("NODEFLOW_FLUSH_INTERVAL", "250ms")
	t.Setenv("NODEFLOW_SHUTDOWN_TIMEOUT", "20s")
	t.Setenv("NODEFLOW_SPOOL_MODE", "durable")
	t.Setenv("NODEFLOW_SPOOL_DIR", "/tmp/nodeflow-test-spool")
	t.Setenv("NODEFLOW_SPOOL_MAX_BYTES", "1048576")
	t.Setenv("NODEFLOW_WAL_SEGMENT_BYTES", "4194304")
	t.Setenv("NODEFLOW_WAL_GROUP_MAX_RECORDS", "32")
	t.Setenv("NODEFLOW_WAL_GROUP_MAX_DELAY", "3ms")
	t.Setenv("NODEFLOW_WAL_APPEND_QUEUE_SIZE", "128")
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
	if config.TopologyEngine != "typescript" || config.TopologyStatePath != "/tmp/nodeflow-topology-state.json" ||
		config.DashboardDir != "/tmp/nodeflow-dashboard" || config.Sink != "http" {
		t.Fatalf("topology overrides were not loaded: %#v", config)
	}
	if config.Workers != 8 || config.QueueSize != 1000 || config.BatchSize != 100 {
		t.Fatalf("limit overrides were not loaded: %#v", config)
	}
	if config.FlushInterval != 250*time.Millisecond || config.ShutdownTimeout != 20*time.Second {
		t.Fatalf("duration overrides were not loaded: %#v", config)
	}
	if config.SpoolMode != "group-commit" || config.SpoolDirectory != "/tmp/nodeflow-test-spool" ||
		config.SpoolMaxBytes != 1_048_576 || config.WALSegmentBytes != 4_194_304 ||
		config.WALBatchRecords != 32 || config.WALFlushInterval != 3*time.Millisecond ||
		config.WALAppendQueue != 128 ||
		config.RetryInitial != 10*time.Millisecond || config.RetryMax != 2*time.Second ||
		config.RetryAttempts != 7 || config.RetryJitter != 0.1 {
		t.Fatalf("durable overrides were not loaded: %#v", config)
	}
}

func TestLoadDefaultsToGoTopology(t *testing.T) {
	config, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if config.TopologyEngine != "go" || config.Sink != "topology" || config.ListenAddress != ":7331" {
		t.Fatalf("unexpected production defaults: %#v", config)
	}
}

func TestLoadRejectsInvalidTopologyEngine(t *testing.T) {
	t.Setenv("NODEFLOW_TOPOLOGY_ENGINE", "shadow")
	if _, err := Load(); err == nil {
		t.Fatal("expected invalid topology engine to fail")
	}
}

func TestLoadAcceptsExplicitAdmissionModes(t *testing.T) {
	for _, mode := range []string{"memory", "legacy", "sync", "group-commit"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("NODEFLOW_SPOOL_MODE", mode)
			config, err := Load()
			if err != nil || config.SpoolMode != mode {
				t.Fatalf("load mode %q: config=%#v err=%v", mode, config, err)
			}
		})
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
