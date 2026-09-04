package spool

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/msHamed1/node-flow/services/collector/internal/telemetry"
)

func TestStoreSurvivesRestartAndRemovesOnlyAcknowledgedRecords(t *testing.T) {
	directory := t.TempDir()
	store, recovery, err := Open(Config{Directory: directory, MaxBytes: 1024 * 1024}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if recovery.Records != 0 {
		t.Fatalf("unexpected initial recovery: %#v", recovery)
	}
	first, err := store.Append(context.Background(), envelope("payments-api", "one"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Append(context.Background(), envelope("payments-worker", "two"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Ack([]Record{first}); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, recovery, err := Open(Config{Directory: directory, MaxBytes: 1024 * 1024}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if recovery.Records != 1 {
		t.Fatalf("expected one recovered record, got %#v", recovery)
	}
	replayed, found, err := reopened.NextAfter(0)
	if err != nil || !found {
		t.Fatalf("replay record: found=%v err=%v", found, err)
	}
	if replayed.ID != second.ID || replayed.Envelope.SpanBatch.ServiceName != "payments-worker" {
		t.Fatalf("unexpected replay: %#v", replayed)
	}
}

func TestStorePersistsRetryAttemptAndQuarantinesPermanentFailure(t *testing.T) {
	directory := t.TempDir()
	store, _, err := Open(Config{Directory: directory, MaxBytes: 1024 * 1024}, nil)
	if err != nil {
		t.Fatal(err)
	}
	record, err := store.Append(context.Background(), envelope("payments-api", "retry"))
	if err != nil {
		t.Fatal(err)
	}
	records := []Record{record}
	if err := store.MarkRetry(records); err != nil {
		t.Fatal(err)
	}
	if records[0].Attempts != 1 {
		t.Fatalf("retry attempt not updated: %#v", records[0])
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, _, err := Open(Config{Directory: directory, MaxBytes: 1024 * 1024}, nil)
	if err != nil {
		t.Fatal(err)
	}
	replayed, found, err := reopened.NextAfter(0)
	if err != nil || !found || replayed.Attempts != 1 {
		t.Fatalf("retry checkpoint was not recovered: %#v found=%v err=%v", replayed, found, err)
	}
	if err := reopened.Quarantine([]Record{replayed}, "permanent"); err != nil {
		t.Fatal(err)
	}
	if stats := reopened.Stats(); stats.ActiveRecords != 0 || stats.QuarantinedRecords != 1 {
		t.Fatalf("unexpected quarantine stats: %#v", stats)
	}
}

func TestStoreRejectsWhenAllocatedDiskBudgetIsExhausted(t *testing.T) {
	store, _, err := Open(Config{Directory: t.TempDir(), MaxBytes: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Append(context.Background(), envelope("payments-api", "full")); err != ErrFull {
		t.Fatalf("expected ErrFull, got %v", err)
	}
	if stats := store.Stats(); stats.ActiveRecords != 0 || stats.Bytes != 0 {
		t.Fatalf("rejected record consumed budget: %#v", stats)
	}
}

func TestStoreQuarantinesCorruptRecordsDuringRecovery(t *testing.T) {
	directory := t.TempDir()
	if err := os.MkdirAll(filepath.Join(directory, "quarantine"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, activeFilename(7, 0)), []byte("corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	observer := &recordingObserver{}
	store, recovery, err := Open(Config{Directory: directory, MaxBytes: 1024 * 1024}, observer)
	if err != nil {
		t.Fatal(err)
	}
	if recovery.Corruptions != 1 || observer.corruptions != 1 {
		t.Fatalf("corruption was not reported: %#v observer=%#v", recovery, observer)
	}
	if stats := store.Stats(); stats.ActiveRecords != 0 || stats.QuarantinedRecords != 1 {
		t.Fatalf("corrupt record was not quarantined: %#v", stats)
	}
}

func TestStoreQuarantinesDuplicateRecordIDsDuringRecovery(t *testing.T) {
	directory := t.TempDir()
	store, _, err := Open(Config{Directory: directory, MaxBytes: 1024 * 1024}, nil)
	if err != nil {
		t.Fatal(err)
	}
	record, err := store.Append(context.Background(), envelope("payments-api", "duplicate"))
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(directory, activeFilename(record.ID, 0)))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, activeFilename(record.ID, 1)), data, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, recovery, err := Open(Config{Directory: directory, MaxBytes: 1024 * 1024}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if recovery.Records != 1 || recovery.Corruptions != 1 {
		t.Fatalf("unexpected duplicate recovery: %#v", recovery)
	}
	if stats := reopened.Stats(); stats.ActiveRecords != 1 || stats.QuarantinedRecords != 1 {
		t.Fatalf("duplicate ID was not quarantined: %#v", stats)
	}
}

func TestStoreRemovesIncompleteTemporaryRecordsDuringRecovery(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, ".00000000000000000001.tmp"), []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	store, recovery, err := Open(Config{Directory: directory, MaxBytes: 1024 * 1024}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if recovery.Records != 0 || recovery.Corruptions != 0 {
		t.Fatalf("temporary file affected recovery: %#v", recovery)
	}
	if _, err := os.Stat(filepath.Join(directory, ".00000000000000000001.tmp")); !os.IsNotExist(err) {
		t.Fatalf("incomplete temporary file remains: %v", err)
	}
	if stats := store.Stats(); stats.Bytes != 0 {
		t.Fatalf("temporary file consumed recovered budget: %#v", stats)
	}
}

type recordingObserver struct {
	corruptions int
}

func (*recordingObserver) SetSpoolUsage(int64, int64, int64) {}
func (observer *recordingObserver) RecordSpoolCorruption()   { observer.corruptions++ }

func envelope(serviceName, spanID string) telemetry.Envelope {
	return telemetry.Envelope{
		ProtocolVersion: telemetry.ProtocolVersion,
		SpanBatch: &telemetry.SpanBatch{ServiceName: serviceName, Spans: []telemetry.Span{{
			TraceID: "trace-" + spanID, SpanID: spanID, Name: "work", Kind: "service", Status: "ok",
		}}},
	}
}
