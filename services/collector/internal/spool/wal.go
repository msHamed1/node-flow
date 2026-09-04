package spool

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/msHamed1/node-flow/services/collector/internal/telemetry"
)

const (
	walSegmentPrefix = "segment-"
	walSegmentSuffix = ".wal"
	walStateSuffix   = ".state"
)

type WALObserver interface {
	SetWALUsage(bytes int64, segments int64, pendingRecords int64, quarantinedRecords int64)
	ObserveWALAppend(time.Duration)
	ObserveWALSync(time.Duration)
	ObserveWALGroupCommit(records int)
	ObserveWALCompaction(time.Duration, int)
	RecordWALCorruption()
	RecordWALDiskFullRejection(records uint64)
}

type WALConfig struct {
	Directory         string
	MaxBytes          int64
	SegmentBytes      int64
	MaxBatchRecords   int
	MaxFlushInterval  time.Duration
	AppendQueueSize   int
	MaxRecordAttempts int
}

type walRecordMetadata struct {
	segmentID uint64
	offset    int64
	frameSize int64
	attempts  int
}

type walSegment struct {
	id                 uint64
	path               string
	statePath          string
	file               *os.File
	stateFile          *os.File
	size               int64
	stateSize          int64
	recordIDs          []uint64
	activeRecords      int64
	quarantinedRecords int64
	closed             bool
}

type walAppendRequest struct {
	envelope telemetry.Envelope
	started  time.Time
	result   chan walAppendResult
}

type walAppendResult struct {
	record Record
	err    error
}

type preparedWALRecord struct {
	request *walAppendRequest
	record  Record
	frame   []byte
}

type WAL struct {
	gate            sync.RWMutex
	mutex           sync.Mutex
	checkpointMutex sync.Mutex
	config          WALConfig
	directory       string
	observer        WALObserver
	appendQueue     chan *walAppendRequest
	compact         chan struct{}
	closeSignal     chan struct{}
	done            chan struct{}
	closed          bool
	fault           error
	nextID          uint64
	nextSegmentID   uint64
	current         *walSegment
	segments        map[uint64]*walSegment
	segmentIDs      []uint64
	active          map[uint64]walRecordMetadata
	ids             []uint64
	usedBytes       int64
	reservedBytes   int64
	quarantined     int64
}

var _ Storage = (*WAL)(nil)

func OpenWAL(config WALConfig, observer WALObserver) (*WAL, Recovery, error) {
	if strings.TrimSpace(config.Directory) == "" {
		return nil, Recovery{}, errors.New("WAL directory is required")
	}
	if config.MaxBytes < 1 || config.SegmentBytes < walSegmentHeaderSize+walFrameHeaderSize*2 ||
		config.MaxBatchRecords < 1 || config.MaxFlushInterval <= 0 || config.AppendQueueSize < 1 ||
		config.MaxRecordAttempts < 1 || config.SegmentBytes > math.MaxUint32 {
		return nil, Recovery{}, errors.New("WAL limits must be positive")
	}
	directory, err := filepath.Abs(config.Directory)
	if err != nil {
		return nil, Recovery{}, fmt.Errorf("resolve WAL directory: %w", err)
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, Recovery{}, fmt.Errorf("create WAL directory: %w", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return nil, Recovery{}, fmt.Errorf("secure WAL directory: %w", err)
	}

	wal := &WAL{
		config: config, directory: directory, observer: observer,
		appendQueue: make(chan *walAppendRequest, config.AppendQueueSize), compact: make(chan struct{}, 1),
		closeSignal: make(chan struct{}), done: make(chan struct{}), nextID: 1, nextSegmentID: 1,
		segments: make(map[uint64]*walSegment), active: make(map[uint64]walRecordMetadata),
	}
	recovery, err := wal.recover()
	if err != nil {
		return nil, recovery, err
	}
	wal.compactSegments()
	if wal.fault != nil {
		wal.closeFiles()
		return nil, recovery, wal.fault
	}
	wal.observeUsageLocked()
	go wal.writeLoop()
	return wal, recovery, nil
}

func (wal *WAL) Append(ctx context.Context, envelope telemetry.Envelope) (Record, error) {
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	request := &walAppendRequest{
		envelope: envelope, started: time.Now(), result: make(chan walAppendResult, 1),
	}
	wal.gate.RLock()
	defer wal.gate.RUnlock()
	wal.mutex.Lock()
	closed, fault := wal.closed, wal.fault
	wal.mutex.Unlock()
	if fault != nil {
		return Record{}, fault
	}
	if closed {
		return Record{}, ErrClosedStorage
	}
	select {
	case wal.appendQueue <- request:
	case <-ctx.Done():
		return Record{}, ctx.Err()
	default:
		return Record{}, ErrBusy
	}
	result := <-request.result
	if wal.observer != nil {
		wal.observer.ObserveWALAppend(time.Since(request.started))
	}
	return result.record, result.err
}

var ErrClosedStorage = errors.New("collector durable storage is closed")

func (wal *WAL) NextAfter(after uint64) (Record, bool, error) {
	wal.mutex.Lock()
	defer wal.mutex.Unlock()
	if wal.fault != nil {
		return Record{}, false, wal.fault
	}
	index := sort.Search(len(wal.ids), func(index int) bool { return wal.ids[index] > after })
	for index < len(wal.ids) {
		id := wal.ids[index]
		index++
		metadata, exists := wal.active[id]
		if !exists {
			continue
		}
		record, err := wal.readRecordLocked(id, metadata)
		if err != nil {
			wal.fault = fmt.Errorf("%w: record %d: %v", ErrCorruptWAL, id, err)
			if wal.observer != nil {
				wal.observer.RecordWALCorruption()
			}
			return Record{ID: id}, true, wal.fault
		}
		return record, true, nil
	}
	return Record{}, false, nil
}

func (wal *WAL) Ack(records []Record) error {
	return wal.writeRecordStates(records, walStateAck, walReasonNone, false)
}

func (wal *WAL) MarkRetry(records []Record) error {
	return wal.writeRecordStates(records, walStateRetry, walReasonNone, true)
}

func (wal *WAL) Quarantine(records []Record, reason string) error {
	stateReason := walReasonAttemptsExhausted
	if reason == "permanent" {
		stateReason = walReasonPermanent
	}
	return wal.writeRecordStates(records, walStateQuarantine, stateReason, false)
}

func (wal *WAL) Stats() Stats {
	wal.mutex.Lock()
	defer wal.mutex.Unlock()
	return Stats{
		Bytes: wal.usedBytes, ReservedBytes: wal.reservedBytes, ActiveRecords: int64(len(wal.active)),
		QuarantinedRecords: wal.quarantined, Segments: int64(len(wal.segments)),
	}
}

func (wal *WAL) Ready() error {
	wal.mutex.Lock()
	defer wal.mutex.Unlock()
	if wal.fault != nil {
		return wal.fault
	}
	if wal.closed {
		return ErrClosedStorage
	}
	if wal.usedBytes+wal.reservedBytes >= wal.config.MaxBytes {
		return ErrFull
	}
	return nil
}

func (wal *WAL) Close() error {
	wal.gate.Lock()
	wal.mutex.Lock()
	if !wal.closed {
		wal.closed = true
		close(wal.closeSignal)
	}
	wal.mutex.Unlock()
	wal.gate.Unlock()
	<-wal.done
	wal.mutex.Lock()
	defer wal.mutex.Unlock()
	return wal.fault
}

func (wal *WAL) writeLoop() {
	defer close(wal.done)
	for {
		select {
		case first := <-wal.appendQueue:
			requests, closing := wal.collectAppendGroup(first)
			wal.processAppendRequests(requests)
			wal.compactSegments()
			if closing {
				wal.drainAndClose()
				return
			}
		case <-wal.compact:
			wal.compactSegments()
		case <-wal.closeSignal:
			wal.drainAndClose()
			return
		}
	}
}

func (wal *WAL) collectAppendGroup(first *walAppendRequest) ([]*walAppendRequest, bool) {
	requests := []*walAppendRequest{first}
	timer := time.NewTimer(wal.config.MaxFlushInterval)
	defer timer.Stop()
	for len(requests) < wal.config.MaxBatchRecords {
		select {
		case request := <-wal.appendQueue:
			requests = append(requests, request)
		case <-timer.C:
			return requests, false
		case <-wal.closeSignal:
			return requests, true
		}
	}
	return requests, false
}

func (wal *WAL) processAppendRequests(requests []*walAppendRequest) {
	prepared := make([]preparedWALRecord, 0, len(requests))
	var preparedBytes int64
	flush := func() error {
		if len(prepared) == 0 {
			return nil
		}
		err := wal.commitGroup(prepared)
		for index := range prepared {
			result := walAppendResult{record: prepared[index].record, err: err}
			prepared[index].request.result <- result
		}
		prepared = prepared[:0]
		preparedBytes = 0
		return err
	}

	for requestIndex, request := range requests {
		wal.mutex.Lock()
		id := wal.nextID
		wal.nextID++
		wal.mutex.Unlock()
		record := Record{ID: id, EnqueuedAt: time.Now().UTC(), Envelope: request.envelope}
		frame, err := encodeWALDataFrame(record)
		if err != nil {
			request.result <- walAppendResult{err: err}
			continue
		}
		commitOverhead := int64(walFrameHeaderSize + walCommitPayloadSize)
		if len(prepared) > 0 && preparedBytes+int64(len(frame))+commitOverhead > wal.config.SegmentBytes {
			if err := flush(); err != nil {
				for _, remaining := range requests[requestIndex:] {
					remaining.result <- walAppendResult{err: err}
				}
				return
			}
		}
		prepared = append(prepared, preparedWALRecord{request: request, record: record, frame: frame})
		preparedBytes += int64(len(frame))
	}
	_ = flush()
}

func (wal *WAL) commitGroup(records []preparedWALRecord) error {
	data := bytes.Buffer{}
	for _, record := range records {
		data.Write(record.frame)
	}
	commit := walCommit{
		firstID: records[0].record.ID, lastID: records[len(records)-1].record.ID,
		count: uint32(len(records)), dataBytes: uint32(data.Len()), checksum: crc32.ChecksumIEEE(data.Bytes()),
	}
	encoded := append(data.Bytes(), encodeWALCommitFrame(commit)...)

	wal.checkpointMutex.Lock()
	defer wal.checkpointMutex.Unlock()
	wal.mutex.Lock()
	defer wal.mutex.Unlock()
	if wal.fault != nil {
		return wal.fault
	}
	needsRotation := wal.current.size > walSegmentHeaderSize &&
		wal.current.size+int64(len(encoded)) > wal.config.SegmentBytes
	newReserve := int64(len(records) * wal.config.MaxRecordAttempts * walStateEntrySize)
	projected := wal.usedBytes + wal.reservedBytes + int64(len(encoded)) + newReserve
	if needsRotation {
		projected += walSegmentHeaderSize + walStateHeaderSize
		if wal.current.activeRecords == 0 && wal.current.quarantinedRecords == 0 {
			projected -= wal.current.size + wal.current.stateSize
		}
	}
	if projected > wal.config.MaxBytes {
		if wal.observer != nil {
			wal.observer.RecordWALDiskFullRejection(uint64(len(records)))
		}
		return ErrFull
	}
	if needsRotation {
		if err := wal.rotateLocked(); err != nil {
			wal.fault = err
			return err
		}
		wal.compactSegmentsLocked()
	}
	offset := wal.current.size
	written, err := wal.current.file.Write(encoded)
	wal.current.size += int64(written)
	wal.usedBytes += int64(written)
	if err != nil || written != len(encoded) {
		if err == nil {
			err = io.ErrShortWrite
		}
		wal.fault = fmt.Errorf("append WAL group: wrote %d of %d bytes: %w", written, len(encoded), err)
		wal.observeUsageLocked()
		return wal.fault
	}
	startedSync := time.Now()
	if err := wal.current.file.Sync(); err != nil {
		wal.fault = fmt.Errorf("sync WAL group: %w", err)
		wal.observeUsageLocked()
		return wal.fault
	}
	if wal.observer != nil {
		wal.observer.ObserveWALSync(time.Since(startedSync))
		wal.observer.ObserveWALGroupCommit(len(records))
	}
	for _, prepared := range records {
		metadata := walRecordMetadata{
			segmentID: wal.current.id, offset: offset, frameSize: int64(len(prepared.frame)),
		}
		wal.active[prepared.record.ID] = metadata
		wal.ids = append(wal.ids, prepared.record.ID)
		wal.current.recordIDs = append(wal.current.recordIDs, prepared.record.ID)
		wal.current.activeRecords++
		wal.reservedBytes += int64(wal.config.MaxRecordAttempts * walStateEntrySize)
		offset += int64(len(prepared.frame))
	}
	wal.observeUsageLocked()
	return nil
}

func (wal *WAL) drainAndClose() {
	for {
		requests := make([]*walAppendRequest, 0, wal.config.MaxBatchRecords)
		for len(requests) < wal.config.MaxBatchRecords {
			select {
			case request := <-wal.appendQueue:
				requests = append(requests, request)
			default:
				if len(requests) > 0 {
					wal.processAppendRequests(requests)
				}
				wal.compactSegments()
				wal.closeFiles()
				return
			}
		}
		wal.processAppendRequests(requests)
	}
}

func (wal *WAL) closeFiles() {
	wal.checkpointMutex.Lock()
	defer wal.checkpointMutex.Unlock()
	wal.mutex.Lock()
	defer wal.mutex.Unlock()
	for _, segment := range wal.segments {
		if segment.file != nil {
			if err := segment.file.Close(); err != nil && wal.fault == nil {
				wal.fault = err
			}
			segment.file = nil
		}
		if segment.stateFile != nil {
			if err := segment.stateFile.Close(); err != nil && wal.fault == nil {
				wal.fault = err
			}
			segment.stateFile = nil
		}
	}
}

func (wal *WAL) observeUsageLocked() {
	if wal.observer != nil {
		wal.observer.SetWALUsage(wal.usedBytes, int64(len(wal.segments)), int64(len(wal.active)), wal.quarantined)
	}
}

func segmentFilename(id uint64) string {
	return fmt.Sprintf("%s%020d%s", walSegmentPrefix, id, walSegmentSuffix)
}

func stateFilename(id uint64) string {
	return fmt.Sprintf("%s%020d%s", walSegmentPrefix, id, walStateSuffix)
}

func parseSegmentFilename(filename, suffix string) (uint64, bool) {
	if !strings.HasPrefix(filename, walSegmentPrefix) || !strings.HasSuffix(filename, suffix) {
		return 0, false
	}
	raw := strings.TrimSuffix(strings.TrimPrefix(filename, walSegmentPrefix), suffix)
	if len(raw) != filenameWidth {
		return 0, false
	}
	id, err := strconv.ParseUint(raw, 10, 64)
	return id, err == nil && id > 0
}
