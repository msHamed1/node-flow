package spool

import (
	"bytes"
	"errors"
	"fmt"
	"sort"
	"time"
)

type segmentStateBatch struct {
	segment *walSegment
	entries []walStateEntry
	encoded []byte
}

func (wal *WAL) writeRecordStates(
	records []Record,
	kind walStateKind,
	reason walStateReason,
	incrementAttempt bool,
) error {
	if len(records) == 0 {
		return nil
	}
	wal.checkpointMutex.Lock()
	defer wal.checkpointMutex.Unlock()

	wal.mutex.Lock()
	if wal.fault != nil {
		err := wal.fault
		wal.mutex.Unlock()
		return err
	}
	bySegment := make(map[uint64]*segmentStateBatch)
	for index := range records {
		metadata, exists := wal.active[records[index].ID]
		if !exists {
			continue
		}
		attempts := metadata.attempts
		if incrementAttempt {
			attempts++
			if attempts > 99_999 {
				wal.mutex.Unlock()
				return fmt.Errorf("WAL retry count exceeded for record %d", records[index].ID)
			}
		}
		batch := bySegment[metadata.segmentID]
		if batch == nil {
			batch = &segmentStateBatch{segment: wal.segments[metadata.segmentID]}
			bySegment[metadata.segmentID] = batch
		}
		batch.entries = append(batch.entries, walStateEntry{
			kind: kind, reason: reason, id: records[index].ID, attempts: uint32(attempts),
		})
	}
	segmentIDs := make([]uint64, 0, len(bySegment))
	for id, batch := range bySegment {
		segmentIDs = append(segmentIDs, id)
		buffer := bytes.Buffer{}
		for _, entry := range batch.entries {
			buffer.Write(encodeWALStateEntry(entry))
		}
		batch.encoded = buffer.Bytes()
	}
	sort.Slice(segmentIDs, func(left, right int) bool { return segmentIDs[left] < segmentIDs[right] })
	wal.mutex.Unlock()

	for _, segmentID := range segmentIDs {
		batch := bySegment[segmentID]
		if batch.segment == nil || batch.segment.stateFile == nil {
			return errors.New("WAL checkpoint references an unavailable segment")
		}
		written, err := batch.segment.stateFile.Write(batch.encoded)
		if err != nil || written != len(batch.encoded) {
			if err == nil {
				err = errors.New("short checkpoint write")
			}
			wal.reconcileStateSize(batch.segment)
			return fmt.Errorf("append WAL checkpoint: wrote %d of %d bytes: %w", written, len(batch.encoded), err)
		}
		startedSync := time.Now()
		if err := batch.segment.stateFile.Sync(); err != nil {
			wal.reconcileStateSize(batch.segment)
			return fmt.Errorf("sync WAL checkpoint: %w", err)
		}
		if wal.observer != nil {
			wal.observer.ObserveWALSync(time.Since(startedSync))
		}
	}

	wal.mutex.Lock()
	for _, segmentID := range segmentIDs {
		batch := bySegment[segmentID]
		batch.segment.stateSize += int64(len(batch.encoded))
		wal.usedBytes += int64(len(batch.encoded))
		for _, entry := range batch.entries {
			metadata, exists := wal.active[entry.id]
			if !exists {
				continue
			}
			switch entry.kind {
			case walStateRetry:
				wal.consumeReserveLocked(walStateEntrySize)
				metadata.attempts = int(entry.attempts)
				wal.active[entry.id] = metadata
			case walStateAck:
				wal.releaseRecordReserveLocked(metadata.attempts)
				delete(wal.active, entry.id)
				batch.segment.activeRecords--
			case walStateQuarantine:
				wal.releaseRecordReserveLocked(metadata.attempts)
				delete(wal.active, entry.id)
				batch.segment.activeRecords--
				batch.segment.quarantinedRecords++
				wal.quarantined++
			}
		}
	}
	wal.compactRecordIndexLocked()
	wal.observeUsageLocked()
	wal.mutex.Unlock()

	if incrementAttempt {
		attemptsByID := make(map[uint64]int)
		for _, batch := range bySegment {
			for _, entry := range batch.entries {
				attemptsByID[entry.id] = int(entry.attempts)
			}
		}
		for index := range records {
			if attempts, exists := attemptsByID[records[index].ID]; exists {
				records[index].Attempts = attempts
			}
		}
	}
	wal.signalCompaction()
	return nil
}

func (wal *WAL) consumeReserveLocked(bytes int) {
	wal.reservedBytes -= int64(bytes)
	if wal.reservedBytes < 0 {
		wal.reservedBytes = 0
	}
}

func (wal *WAL) releaseRecordReserveLocked(attempts int) {
	remaining := wal.config.MaxRecordAttempts - attempts
	if remaining < 1 {
		remaining = 1
	}
	wal.consumeReserveLocked(remaining * walStateEntrySize)
}

func (wal *WAL) reconcileStateSize(segment *walSegment) {
	info, statErr := segment.stateFile.Stat()
	if statErr != nil {
		return
	}
	wal.mutex.Lock()
	delta := info.Size() - segment.stateSize
	segment.stateSize = info.Size()
	wal.usedBytes += delta
	wal.observeUsageLocked()
	wal.mutex.Unlock()
}

func (wal *WAL) compactRecordIndexLocked() {
	if len(wal.ids) < 1_024 || len(wal.ids) <= len(wal.active)*2 {
		return
	}
	ids := make([]uint64, 0, len(wal.active))
	for _, id := range wal.ids {
		if _, exists := wal.active[id]; exists {
			ids = append(ids, id)
		}
	}
	wal.ids = ids
}

func (wal *WAL) signalCompaction() {
	select {
	case wal.compact <- struct{}{}:
	default:
	}
}
