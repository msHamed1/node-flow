package metrics

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCollectorExposesDurableSpoolMetrics(t *testing.T) {
	collector := New()
	collector.SetSpoolUsage(8_192, 2, 1)
	collector.RecordSpoolRetry(2)
	collector.RecordSpoolReplay(3)
	collector.RecordSpoolPermanent(1)
	collector.RecordSpoolCorruption()
	collector.RecordRejected("spool_full", 4)

	response := httptest.NewRecorder()
	collector.Handler().ServeHTTP(response, httptest.NewRequest("GET", "/metrics", nil))
	body := response.Body.String()
	for _, expected := range []string{
		"nodeflow_collector_spool_bytes 8192",
		"nodeflow_collector_spool_active_records 2",
		"nodeflow_collector_spool_quarantined_records 1",
		"nodeflow_collector_spool_retries_total 2",
		"nodeflow_collector_spool_replayed_total 3",
		"nodeflow_collector_spool_permanent_failures_total 1",
		"nodeflow_collector_spool_corruptions_total 1",
		"nodeflow_collector_spool_dropped_total 2",
		"nodeflow_collector_telemetry_rejected_total{reason=\"spool_full\"} 4",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("missing %q:\n%s", expected, body)
		}
	}
}
