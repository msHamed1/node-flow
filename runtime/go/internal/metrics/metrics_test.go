package metrics

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCollectorExposesDurableSpoolMetrics(t *testing.T) {
	collector := New()
	collector.SetSpoolUsage(8_192, 2, 1)
	collector.RecordSpoolRetry(2)
	collector.RecordSpoolReplay(3)
	collector.RecordSpoolPermanent(1)
	collector.RecordSpoolCorruption()
	collector.RecordRejected("spool_full", 4)
	collector.SetWALUsage(4_096, 3, 7, 2)
	collector.ObserveWALAppend(time.Millisecond)
	collector.ObserveWALSync(500 * time.Microsecond)
	collector.ObserveWALGroupCommit(8)
	collector.ObserveWALCompaction(time.Millisecond, 2)
	collector.RecordWALReplay(5)
	collector.RecordWALCorruption()
	collector.RecordWALDiskFullRejection(4)

	response := httptest.NewRecorder()
	collector.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/metrics", nil))
	body := response.Body.String()
	for _, expected := range []string{
		"nodeflow_collector_spool_bytes 4096",
		"nodeflow_collector_spool_active_records 7",
		"nodeflow_collector_spool_quarantined_records 2",
		"nodeflow_collector_spool_retries_total 2",
		"nodeflow_collector_spool_replayed_total 3",
		"nodeflow_collector_spool_permanent_failures_total 1",
		"nodeflow_collector_spool_corruptions_total 1",
		"nodeflow_collector_spool_dropped_total 2",
		"nodeflow_collector_telemetry_rejected_total{reason=\"spool_full\"} 4",
		"nodeflow_collector_wal_bytes 4096",
		"nodeflow_collector_wal_segments 3",
		"nodeflow_collector_wal_pending_records 7",
		"nodeflow_collector_wal_replayed_total 5",
		"nodeflow_collector_wal_compactions_total 1",
		"nodeflow_collector_wal_segments_compacted_total 2",
		"nodeflow_collector_wal_corruptions_total 1",
		"nodeflow_collector_wal_disk_full_rejections_total 4",
		"nodeflow_collector_wal_records_per_group_commit_count 1",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("missing %q:\n%s", expected, body)
		}
	}
}
