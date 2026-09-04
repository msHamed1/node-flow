package spool

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestWALGroupCommitRestartRetryAckAndOrdering(t *testing.T) {
	directory := t.TempDir()
	observer := &walRecordingObserver{}
	wal, recovery, err := OpenWAL(testWALConfig(directory), observer)
	if err != nil {
		t.Fatal(err)
	}
	if recovery.Records != 0 || recovery.Segments != 1 {
		t.Fatalf("unexpected initial recovery: %#v", recovery)
	}

	const count = 12
	records := make([]Record, count)
	errorsByIndex := make([]error, count)
	start := make(chan struct{})
	var group sync.WaitGroup
	for index := range count {
		group.Add(1)
		go func(index int) {
			defer group.Done()
			<-start
			records[index], errorsByIndex[index] = wal.Append(
				context.Background(), envelope("payments-api", fmt.Sprintf("%02d", index)),
			)
		}(index)
	}
	close(start)
	group.Wait()
	for _, appendErr := range errorsByIndex {
		if appendErr != nil {
			t.Fatal(appendErr)
		}
	}
	if observer.largestGroup < 2 {
		t.Fatalf("concurrent admissions were not group committed: %#v", observer)
	}

	first, found, err := wal.NextAfter(0)
	if err != nil || !found {
		t.Fatalf("read first record: found=%v err=%v", found, err)
	}
	retry := []Record{first}
	if err := wal.MarkRetry(retry); err != nil {
		t.Fatal(err)
	}
	if retry[0].Attempts != 1 {
		t.Fatalf("retry count was not returned: %#v", retry[0])
	}
	if err := wal.Ack([]Record{records[0]}); err != nil {
		t.Fatal(err)
	}
	if err := wal.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, recovered, err := OpenWAL(testWALConfig(directory), observer)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if recovered.Records != count-1 {
		t.Fatalf("expected %d replay records, got %#v", count-1, recovered)
	}
	var previous uint64
	var sawRetry bool
	for {
		record, ok, readErr := reopened.NextAfter(previous)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if !ok {
			break
		}
		if record.ID <= previous {
			t.Fatalf("WAL replay is not sequence ordered: %d after %d", record.ID, previous)
		}
		if record.ID == first.ID && record.Attempts == 1 {
			sawRetry = true
		}
		previous = record.ID
	}
	if !sawRetry && records[0].ID != first.ID {
		t.Fatal("retry checkpoint was not recovered")
	}
}

func TestWALTruncatesPartialUncommittedFinalRecord(t *testing.T) {
	directory := t.TempDir()
	wal, _, err := OpenWAL(testWALConfig(directory), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wal.Append(context.Background(), envelope("api", "one")); err != nil {
		t.Fatal(err)
	}
	if err := wal.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, segmentFilename(1))
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	partial := encodeWALFrame(walFrameData, 2, []byte(`{"partial":true}`))[:11]
	if _, err := file.Write(partial); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, recovery, err := OpenWAL(testWALConfig(directory), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if recovery.Records != 1 || recovery.Truncated != int64(len(partial)) {
		t.Fatalf("partial tail was not recovered deterministically: %#v", recovery)
	}
}

func TestWALRefusesCorruptCommittedRecord(t *testing.T) {
	directory := t.TempDir()
	wal, _, err := OpenWAL(testWALConfig(directory), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wal.Append(context.Background(), envelope("api", "one")); err != nil {
		t.Fatal(err)
	}
	if _, err := wal.Append(context.Background(), envelope("api", "two")); err != nil {
		t.Fatal(err)
	}
	if err := wal.Close(); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(directory, segmentFilename(1))
	file, err := os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteAt([]byte{0xff}, walSegmentHeaderSize+walFrameHeaderSize+2); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	observer := &walRecordingObserver{}
	if _, _, err := OpenWAL(testWALConfig(directory), observer); !errors.Is(err, ErrCorruptWAL) {
		t.Fatalf("committed corruption must stop recovery, got %v", err)
	}
	if observer.corruptions != 1 {
		t.Fatalf("corruption metric not recorded: %#v", observer)
	}
}

func TestWALRefusesCorruptCommittedTail(t *testing.T) {
	directory := t.TempDir()
	wal, _, err := OpenWAL(testWALConfig(directory), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wal.Append(context.Background(), envelope("api", "tail")); err != nil {
		t.Fatal(err)
	}
	if err := wal.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, segmentFilename(1))
	file, err := os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	info, err := file.Stat()
	if err != nil {
		t.Fatal(err)
	}
	last := make([]byte, 1)
	if _, err := file.ReadAt(last, info.Size()-1); err != nil {
		t.Fatal(err)
	}
	last[0] ^= 0xff
	if _, err := file.WriteAt(last, info.Size()-1); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := OpenWAL(testWALConfig(directory), nil); !errors.Is(err, ErrCorruptWAL) {
		t.Fatalf("committed tail corruption must not be truncated, got %v", err)
	}
}

func TestWALRemovesRotationTemporaryFilesAndCompactsAcknowledgedSegments(t *testing.T) {
	directory := t.TempDir()
	config := testWALConfig(directory)
	config.SegmentBytes = 600
	wal, _, err := OpenWAL(config, nil)
	if err != nil {
		t.Fatal(err)
	}
	first, err := wal.Append(context.Background(), envelope("api", "one"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wal.Append(context.Background(), envelope("api", "two")); err != nil {
		t.Fatal(err)
	}
	if wal.Stats().Segments < 2 {
		t.Fatalf("test did not rotate the WAL: %#v", wal.Stats())
	}
	if err := wal.Ack([]Record{first}); err != nil {
		t.Fatal(err)
	}
	waitForWAL(t, func() bool { return wal.Stats().Segments == 1 }, "acknowledged segment was not compacted")
	if err := wal.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "segment-00000000000000000003.wal.tmp"), []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	reopened, recovery, err := OpenWAL(config, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if recovery.Records != 1 {
		t.Fatalf("unexpected recovery after rotation cleanup: %#v", recovery)
	}
	if _, err := os.Stat(filepath.Join(directory, "segment-00000000000000000003.wal.tmp")); !os.IsNotExist(err) {
		t.Fatalf("rotation temporary file remains: %v", err)
	}
}

func TestWALDiskBoundIncludesFutureCheckpointSpace(t *testing.T) {
	directory := t.TempDir()
	config := testWALConfig(directory)
	config.MaxBytes = 1_024
	config.MaxRecordAttempts = 3
	wal, _, err := OpenWAL(config, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer wal.Close()
	accepted := 0
	for {
		_, appendErr := wal.Append(context.Background(), envelope("api", fmt.Sprintf("record-%d", accepted)))
		if errors.Is(appendErr, ErrFull) {
			break
		}
		if appendErr != nil {
			t.Fatal(appendErr)
		}
		accepted++
		if accepted > 10 {
			t.Fatal("expected the small WAL budget to reject admission")
		}
	}
	stats := wal.Stats()
	if accepted == 0 || stats.Bytes+stats.ReservedBytes > config.MaxBytes {
		t.Fatalf("WAL exceeded its bounded accounting: accepted=%d stats=%#v", accepted, stats)
	}
}

func TestWALRefusesToIgnoreLegacySpoolRecords(t *testing.T) {
	directory := t.TempDir()
	legacy, _, err := Open(Config{Directory: directory, MaxBytes: 1 << 20}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := legacy.Append(context.Background(), envelope("api", "legacy")); err != nil {
		t.Fatal(err)
	}
	if err := legacy.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := OpenWAL(testWALConfig(directory), nil); !errors.Is(err, ErrLegacySpool) {
		t.Fatalf("expected explicit legacy migration refusal, got %v", err)
	}
}

func TestWALReplaysRecordAfterAbruptProcessExit(t *testing.T) {
	if os.Getenv("NODEFLOW_WAL_CRASH_HELPER") == "1" {
		directory := os.Getenv("NODEFLOW_WAL_CRASH_DIR")
		wal, _, err := OpenWAL(testWALConfig(directory), nil)
		if err != nil {
			panic(err)
		}
		if _, err := wal.Append(context.Background(), envelope("worker", "kill-safe")); err != nil {
			panic(err)
		}
		fmt.Println("durable")
		select {}
	}

	directory := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=TestWALReplaysRecordAfterAbruptProcessExit")
	command.Env = append(os.Environ(), "NODEFLOW_WAL_CRASH_HELPER=1", "NODEFLOW_WAL_CRASH_DIR="+directory)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() || scanner.Text() != "durable" {
		_ = command.Process.Kill()
		t.Fatalf("crash helper did not cross durability boundary: %v", scanner.Err())
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = command.Wait()

	reopened, recovery, err := OpenWAL(testWALConfig(directory), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if recovery.Records != 1 {
		t.Fatalf("SIGKILL-safe record was not replayed: %#v", recovery)
	}
	record, found, err := reopened.NextAfter(0)
	if err != nil || !found || record.Envelope.SpanBatch.Spans[0].SpanID != "kill-safe" {
		t.Fatalf("unexpected crash replay: %#v found=%v err=%v", record, found, err)
	}
}

func TestWALClosesCleanlyOnSIGTERM(t *testing.T) {
	if os.Getenv("NODEFLOW_WAL_TERM_HELPER") == "1" {
		directory := os.Getenv("NODEFLOW_WAL_CRASH_DIR")
		wal, _, err := OpenWAL(testWALConfig(directory), nil)
		if err != nil {
			panic(err)
		}
		if _, err := wal.Append(context.Background(), envelope("worker", "term-safe")); err != nil {
			panic(err)
		}
		fmt.Println("durable")
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, syscall.SIGTERM)
		<-signals
		if err := wal.Close(); err != nil {
			panic(err)
		}
		fmt.Println("closed")
		return
	}

	directory := t.TempDir()
	command := exec.Command(os.Args[0], "-test.run=TestWALClosesCleanlyOnSIGTERM")
	command.Env = append(os.Environ(), "NODEFLOW_WAL_TERM_HELPER=1", "NODEFLOW_WAL_CRASH_DIR="+directory)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() || scanner.Text() != "durable" {
		_ = command.Process.Kill()
		t.Fatalf("SIGTERM helper was not ready: %v", scanner.Err())
	}
	if err := command.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if !scanner.Scan() || scanner.Text() != "closed" {
		_ = command.Process.Kill()
		t.Fatalf("SIGTERM helper did not close cleanly: %v", scanner.Err())
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	reopened, recovery, err := OpenWAL(testWALConfig(directory), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if recovery.Records != 1 {
		t.Fatalf("SIGTERM-safe record was not recovered: %#v", recovery)
	}
}

type walRecordingObserver struct {
	mutex        sync.Mutex
	largestGroup int
	corruptions  int
}

func (*walRecordingObserver) SetWALUsage(int64, int64, int64, int64) {}
func (*walRecordingObserver) ObserveWALAppend(time.Duration)         {}
func (*walRecordingObserver) ObserveWALSync(time.Duration)           {}
func (observer *walRecordingObserver) ObserveWALGroupCommit(records int) {
	observer.mutex.Lock()
	defer observer.mutex.Unlock()
	if records > observer.largestGroup {
		observer.largestGroup = records
	}
}
func (*walRecordingObserver) ObserveWALCompaction(time.Duration, int) {}
func (observer *walRecordingObserver) RecordWALCorruption()           { observer.corruptions++ }
func (*walRecordingObserver) RecordWALDiskFullRejection(uint64)       {}

func testWALConfig(directory string) WALConfig {
	return WALConfig{
		Directory: directory, MaxBytes: 1 << 20, SegmentBytes: 4 << 10,
		MaxBatchRecords: 16, MaxFlushInterval: 10 * time.Millisecond,
		AppendQueueSize: 64, MaxRecordAttempts: 10,
	}
}

func waitForWAL(t *testing.T, condition func() bool, message string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal(message)
}
