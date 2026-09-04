package topology

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestStateStoreRoundTripPreservesSnapshotAndDeduplication(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state", "topology-state.json")
	engine, store, err := OpenStateStore(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	engine.RegisterApplication("checkout", "v22.1.0")
	spans := []Span{
		{TraceID: "trace-1", SpanID: "root", Name: "GET /orders", Kind: "http-route", StartTimeUnixMS: 10, DurationMS: 12, Status: "ok"},
		{TraceID: "trace-1", SpanID: "db", ParentSpanID: "root", Name: "orders.find", Kind: "database", StartTimeUnixMS: 11, DurationMS: 3, Status: "error"},
	}
	engine.Ingest(spans)
	engine.UpdateRuntime(RuntimeMetrics{Timestamp: 20, ServiceName: "checkout", RSSBytes: 42})
	if _, err := store.Save(engine); err != nil {
		t.Fatal(err)
	}
	wantLive := engine.LiveSnapshot()
	wantArchitecture := engine.CreateSnapshot()

	restored, _, err := OpenStateStore(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	gotLive := restored.LiveSnapshot()
	gotArchitecture := restored.CreateSnapshot()
	wantLive.GeneratedAt, gotLive.GeneratedAt = 0, 0
	wantArchitecture.GeneratedAt, gotArchitecture.GeneratedAt = "", ""
	if !reflect.DeepEqual(gotLive, wantLive) {
		t.Fatalf("restored live snapshot differs\nwant: %#v\n got: %#v", wantLive, gotLive)
	}
	if !reflect.DeepEqual(gotArchitecture, wantArchitecture) {
		t.Fatalf("restored architecture differs\nwant: %#v\n got: %#v", wantArchitecture, gotArchitecture)
	}

	beforeCalls := restored.CreateSnapshot().Nodes[0].Metrics.CallCount
	restored.Ingest(spans)
	afterCalls := restored.CreateSnapshot().Nodes[0].Metrics.CallCount
	if afterCalls != beforeCalls {
		t.Fatalf("replayed spans changed call count: before=%d after=%d", beforeCalls, afterCalls)
	}
}

func TestOpenStateStoreRejectsCorruption(t *testing.T) {
	path := filepath.Join(t.TempDir(), "topology-state.json")
	if err := os.WriteFile(path, []byte("{not-json"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := OpenStateStore(path, Options{})
	if err == nil || !strings.Contains(err.Error(), "decode topology state") {
		t.Fatalf("expected explicit corruption error, got %v", err)
	}
}

func TestOpenStateStoreRemovesIncompleteCheckpoint(t *testing.T) {
	directory := t.TempDir()
	temporary := filepath.Join(directory, ".topology-state-interrupted")
	if err := os.WriteFile(temporary, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := OpenStateStore(filepath.Join(directory, "topology-state.json"), Options{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(temporary); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("incomplete checkpoint was not removed: %v", err)
	}
}

func TestOpenStateStoreRejectsUnsupportedVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "topology-state.json")
	if err := os.WriteFile(path, []byte(`{"version":999}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := OpenStateStore(path, Options{})
	if err == nil || !strings.Contains(err.Error(), "unsupported topology state version") {
		t.Fatalf("expected version error, got %v", err)
	}
}

func TestOpenStateStoreRejectsChecksumMismatch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "topology-state.json")
	engine, store, err := OpenStateStore(path, Options{})
	if err != nil {
		t.Fatal(err)
	}
	engine.Ingest([]Span{{TraceID: "trace", SpanID: "span", Name: "Service.call", Kind: "service", Status: "ok"}})
	if _, err := store.Save(engine); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = []byte(strings.Replace(string(data), "Service.call", "Service.fail", 1))
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err = OpenStateStore(path, Options{})
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("expected checksum error, got %v", err)
	}
}
