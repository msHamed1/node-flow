package topology

import (
	"fmt"
	"sync"
	"testing"
)

func TestStableIdentitiesMatchTypeScriptContract(t *testing.T) {
	t.Parallel()
	tests := []struct {
		kind      string
		identity  string
		framework string
		want      string
	}{
		{kind: "service", identity: "service:PaymentsService", framework: "NestJS", want: "nestjs:service:paymentsservice"},
		{kind: "service", identity: " service:PAYMENTS service ", framework: "nestjs", want: "nestjs:service:payments-service"},
		{kind: "external-http", identity: "HTTPS://API.Stripe.com", want: "external-http:https://api.stripe.com"},
	}
	for _, test := range tests {
		if got := StableNodeID(test.kind, test.identity, test.framework); got != test.want {
			t.Errorf("StableNodeID(%q, %q, %q) = %q, want %q", test.kind, test.identity, test.framework, got, test.want)
		}
	}
	if got := StableEdgeID("service:a", "database:b"); got != "dependency:service:a->database:b" {
		t.Fatalf("StableEdgeID() = %q", got)
	}
}

func TestLateParentReplacesProvisionalPath(t *testing.T) {
	t.Parallel()
	engine := New(Options{})
	spans := testTrace("late", 0, 12)
	controller := Span{
		TraceID: "late", SpanID: "late-controller", ParentSpanID: "late-route",
		Name: "PaymentsController.create", Kind: "controller", StartTimeUnixMS: 1_700_000_000_001,
		DurationMS: 20, Status: "ok", Attributes: map[string]any{
			"nodeflow.identity": "controller:PaymentsController", "nodeflow.framework": "nestjs",
		},
	}
	spans[1].ParentSpanID = controller.SpanID
	engine.Ingest([]Span{controller, spans[1]})
	provisional := engine.CreateSnapshot()
	if len(provisional.Paths) != 1 || provisional.Paths[0].Entrypoint != "PaymentsController.create" {
		t.Fatalf("provisional paths = %#v", provisional.Paths)
	}

	engine.Ingest([]Span{spans[0]})
	got := engine.CreateSnapshot()
	if len(got.Paths) != 1 {
		t.Fatalf("paths = %#v, want one reconciled path", got.Paths)
	}
	wantNodes := []string{
		"http-route:post-/payments",
		"nestjs:controller:paymentscontroller",
		"database:postgresql",
	}
	if fmt.Sprint(got.Paths[0].Nodes) != fmt.Sprint(wantNodes) || got.Paths[0].Calls != 1 {
		t.Fatalf("path = %#v, want nodes %v and one contribution", got.Paths[0], wantNodes)
	}
}

func TestDuplicateReplayIsIdempotent(t *testing.T) {
	t.Parallel()
	engine := New(Options{})
	spans := testTrace("duplicate", 0, 8)
	engine.Ingest(spans)
	engine.Ingest(spans)
	snapshot := engine.CreateSnapshot()
	for _, node := range snapshot.Nodes {
		if node.Metrics.CallCount != 1 {
			t.Fatalf("node %s call count = %d, want 1", node.ID, node.Metrics.CallCount)
		}
	}
	if len(snapshot.Edges) != 1 || snapshot.Edges[0].Metrics.CallCount != 1 {
		t.Fatalf("edges = %#v", snapshot.Edges)
	}
	if len(snapshot.Paths) != 1 || snapshot.Paths[0].Calls != 1 {
		t.Fatalf("paths = %#v", snapshot.Paths)
	}
}

func TestConcurrentIngestAndSnapshotUsesAtomicBatchOwnership(t *testing.T) {
	engine := New(Options{})
	engine.RegisterApplication("payments-api", "v22.0.0")
	const writers = 8
	const tracesPerWriter = 100

	start := make(chan struct{})
	done := make(chan struct{})
	var writerGroup sync.WaitGroup
	for writer := 0; writer < writers; writer++ {
		writerGroup.Add(1)
		go func(writer int) {
			defer writerGroup.Done()
			<-start
			for trace := 0; trace < tracesPerWriter; trace++ {
				id := fmt.Sprintf("concurrent-%d-%d", writer, trace)
				engine.Ingest(testTrace(id, float64(trace), float64(trace%17+1)))
			}
		}(writer)
	}

	var readerGroup sync.WaitGroup
	for reader := 0; reader < 4; reader++ {
		readerGroup.Add(1)
		go func() {
			defer readerGroup.Done()
			<-start
			for {
				select {
				case <-done:
					return
				default:
					snapshot := engine.CreateSnapshot()
					if len(snapshot.Nodes) == 2 && snapshot.Nodes[0].Metrics.CallCount != snapshot.Nodes[1].Metrics.CallCount {
						t.Errorf("snapshot observed a partial batch: %#v", snapshot.Nodes)
						return
					}
				}
			}
		}()
	}

	close(start)
	writerGroup.Wait()
	close(done)
	readerGroup.Wait()

	snapshot := engine.CreateSnapshot()
	want := writers * tracesPerWriter
	if len(snapshot.Nodes) != 2 {
		t.Fatalf("node count = %d, want 2", len(snapshot.Nodes))
	}
	for _, node := range snapshot.Nodes {
		if node.Metrics.CallCount != want {
			t.Fatalf("node %s call count = %d, want %d", node.ID, node.Metrics.CallCount, want)
		}
	}
}

func TestSnapshotOwnsDefensiveCopies(t *testing.T) {
	t.Parallel()
	engine := New(Options{})
	engine.Ingest(testTrace("copy", 0, 8))
	first := engine.CreateSnapshot()
	first.Nodes[0].Name = "mutated"
	first.Paths[0].Nodes[0] = "mutated"
	second := engine.CreateSnapshot()
	if second.Nodes[0].Name == "mutated" || second.Paths[0].Nodes[0] == "mutated" {
		t.Fatal("snapshot mutation escaped into engine-owned state")
	}
}

func testTrace(traceID string, offsetMS, databaseDurationMS float64) []Span {
	start := 1_700_000_000_000 + offsetMS
	return []Span{
		{
			TraceID: traceID, SpanID: traceID + "-route", Name: "POST /payments", Kind: "http-route",
			StartTimeUnixMS: start, DurationMS: databaseDurationMS + 5, Status: "ok",
		},
		{
			TraceID: traceID, SpanID: traceID + "-db", ParentSpanID: traceID + "-route",
			Name: "PostgreSQL", Kind: "database", StartTimeUnixMS: start + 2,
			DurationMS: databaseDurationMS, Status: "ok",
		},
	}
}
