package spool

import (
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type recoveredWALFrame struct {
	id        uint64
	offset    int64
	frameSize int64
	encoded   []byte
}

func (wal *WAL) recover() (Recovery, error) {
	recovery := Recovery{}
	entries, err := os.ReadDir(wal.directory)
	if err != nil {
		return recovery, fmt.Errorf("read WAL directory: %w", err)
	}
	if err := rejectLegacySpool(entries, wal.directory); err != nil {
		return recovery, err
	}
	removedTemporary := false
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".tmp") {
			continue
		}
		if err := os.Remove(filepath.Join(wal.directory, entry.Name())); err != nil {
			return recovery, fmt.Errorf("remove incomplete WAL metadata: %w", err)
		}
		removedTemporary = true
	}
	if removedTemporary {
		if err := syncDirectory(wal.directory); err != nil {
			return recovery, err
		}
	}

	entries, err = os.ReadDir(wal.directory)
	if err != nil {
		return recovery, fmt.Errorf("read WAL directory: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		id, valid := parseSegmentFilename(entry.Name(), walSegmentSuffix)
		if !valid {
			continue
		}
		if _, duplicate := wal.segments[id]; duplicate {
			return recovery, fmt.Errorf("%w: duplicate WAL segment %d", ErrCorruptWAL, id)
		}
		wal.segments[id] = &walSegment{
			id: id, path: filepath.Join(wal.directory, entry.Name()),
			statePath: filepath.Join(wal.directory, stateFilename(id)), closed: true,
		}
		wal.segmentIDs = append(wal.segmentIDs, id)
		if id >= wal.nextSegmentID {
			wal.nextSegmentID = id + 1
		}
	}
	sort.Slice(wal.segmentIDs, func(left, right int) bool { return wal.segmentIDs[left] < wal.segmentIDs[right] })

	if len(wal.segmentIDs) == 0 {
		segment, err := wal.createSegment(wal.nextSegmentID)
		if err != nil {
			return recovery, err
		}
		wal.installSegment(segment)
		wal.current = segment
		recovery.Bytes = wal.usedBytes
		recovery.Segments = 1
		return recovery, nil
	}

	seenIDs := make(map[uint64]struct{})
	for index, id := range wal.segmentIDs {
		segment := wal.segments[id]
		states, stateSize, truncated, err := wal.recoverState(segment)
		if err != nil {
			wal.recordRecoveryCorruption()
			recovery.Corruptions++
			return recovery, err
		}
		segment.stateSize = stateSize
		recovery.Truncated += truncated
		isLast := index == len(wal.segmentIDs)-1
		truncatedData, err := wal.recoverSegment(segment, states, seenIDs, isLast)
		if err != nil {
			wal.recordRecoveryCorruption()
			recovery.Corruptions++
			return recovery, err
		}
		recovery.Truncated += truncatedData
		wal.usedBytes += segment.size + segment.stateSize
	}

	last := wal.segments[wal.segmentIDs[len(wal.segmentIDs)-1]]
	last.closed = false
	last.file, err = os.OpenFile(last.path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return recovery, fmt.Errorf("open active WAL segment: %w", err)
	}
	wal.current = last
	for _, id := range wal.segmentIDs {
		segment := wal.segments[id]
		segment.stateFile, err = os.OpenFile(segment.statePath, os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			wal.closeRecoveredFiles()
			return recovery, fmt.Errorf("open WAL checkpoint %d: %w", id, err)
		}
	}
	for _, metadata := range wal.active {
		remainingAttempts := wal.config.MaxRecordAttempts - metadata.attempts
		if remainingAttempts < 1 {
			remainingAttempts = 1
		}
		wal.reservedBytes += int64(remainingAttempts * walStateEntrySize)
	}
	wal.ids = make([]uint64, 0, len(wal.active))
	for id := range wal.active {
		wal.ids = append(wal.ids, id)
	}
	sort.Slice(wal.ids, func(left, right int) bool { return wal.ids[left] < wal.ids[right] })
	recovery.Records = int64(len(wal.active))
	recovery.Bytes = wal.usedBytes
	recovery.Segments = int64(len(wal.segments))
	return recovery, nil
}

func (wal *WAL) closeRecoveredFiles() {
	for _, segment := range wal.segments {
		if segment.file != nil {
			_ = segment.file.Close()
			segment.file = nil
		}
		if segment.stateFile != nil {
			_ = segment.stateFile.Close()
			segment.stateFile = nil
		}
	}
}

func rejectLegacySpool(entries []os.DirEntry, directory string) error {
	for _, entry := range entries {
		if entry.IsDir() {
			if entry.Name() != "quarantine" {
				continue
			}
			quarantined, err := os.ReadDir(filepath.Join(directory, entry.Name()))
			if err != nil {
				return fmt.Errorf("inspect legacy quarantine: %w", err)
			}
			if len(quarantined) > 0 {
				return fmt.Errorf("%w in %s; drain or archive them with NODEFLOW_SPOOL_MODE=legacy before enabling the WAL", ErrLegacySpool, directory)
			}
			continue
		}
		if _, _, valid := parseActiveFilename(entry.Name()); valid {
			return fmt.Errorf("%w in %s; drain them with NODEFLOW_SPOOL_MODE=legacy before enabling the WAL", ErrLegacySpool, directory)
		}
	}
	return nil
}

func (wal *WAL) recoverSegment(
	segment *walSegment,
	states map[uint64]walStateEntry,
	seenIDs map[uint64]struct{},
	isLast bool,
) (int64, error) {
	data, err := os.ReadFile(segment.path)
	if err != nil {
		return 0, fmt.Errorf("read WAL segment %d: %w", segment.id, err)
	}
	if len(data) < walSegmentHeaderSize {
		return 0, fmt.Errorf("%w: segment %d has a partial header", ErrCorruptWAL, segment.id)
	}
	if err := decodeWALSegmentHeader(data[:walSegmentHeaderSize], segment.id); err != nil {
		return 0, fmt.Errorf("%w: segment %d: %v", ErrCorruptWAL, segment.id, err)
	}
	offset := walSegmentHeaderSize
	committedOffset := offset
	pending := make([]recoveredWALFrame, 0, wal.config.MaxBatchRecords)
	pendingIDs := make(map[uint64]struct{})
	pendingBytes := make([]byte, 0)
	for offset < len(data) {
		remaining := len(data) - offset
		if remaining < walFrameHeaderSize {
			return wal.truncateUncommittedTail(segment, data, committedOffset, isLast)
		}
		header := data[offset : offset+walFrameHeaderSize]
		kind, sequence, payloadSize, payloadChecksum, err := decodeWALFrameHeader(header)
		if err != nil {
			return 0, fmt.Errorf("%w: segment %d offset %d: %v", ErrCorruptWAL, segment.id, offset, err)
		}
		frameSize := walFrameHeaderSize + int(payloadSize)
		if payloadSize > uint32(wal.config.SegmentBytes) || remaining < frameSize {
			return wal.truncateUncommittedTail(segment, data, committedOffset, isLast)
		}
		payload := data[offset+walFrameHeaderSize : offset+frameSize]
		if crc32.ChecksumIEEE(payload) != payloadChecksum {
			return 0, fmt.Errorf("%w: segment %d record %d payload checksum mismatch", ErrCorruptWAL, segment.id, sequence)
		}
		switch kind {
		case walFrameData:
			if _, duplicate := seenIDs[sequence]; duplicate {
				return 0, fmt.Errorf("%w: duplicate WAL sequence %d", ErrCorruptWAL, sequence)
			}
			if _, duplicate := pendingIDs[sequence]; duplicate {
				return 0, fmt.Errorf("%w: duplicate WAL sequence %d", ErrCorruptWAL, sequence)
			}
			if _, err := decodeWALRecord(payload, sequence); err != nil {
				return 0, fmt.Errorf("%w: segment %d record %d: %v", ErrCorruptWAL, segment.id, sequence, err)
			}
			pending = append(pending, recoveredWALFrame{
				id: sequence, offset: int64(offset), frameSize: int64(frameSize),
				encoded: append([]byte(nil), data[offset:offset+frameSize]...),
			})
			pendingIDs[sequence] = struct{}{}
			pendingBytes = append(pendingBytes, data[offset:offset+frameSize]...)
		case walFrameCommit:
			commit, err := decodeWALCommit(payload)
			if err != nil || !validRecoveredCommit(commit, pending, pendingBytes, sequence) {
				return 0, fmt.Errorf("%w: segment %d has an invalid commit marker at offset %d", ErrCorruptWAL, segment.id, offset)
			}
			for _, frame := range pending {
				seenIDs[frame.id] = struct{}{}
				segment.recordIDs = append(segment.recordIDs, frame.id)
				if frame.id >= wal.nextID {
					wal.nextID = frame.id + 1
				}
				state := states[frame.id]
				switch state.kind {
				case walStateAck:
				case walStateQuarantine:
					segment.quarantinedRecords++
					wal.quarantined++
				default:
					wal.active[frame.id] = walRecordMetadata{
						segmentID: segment.id, offset: frame.offset, frameSize: frame.frameSize,
						attempts: int(state.attempts),
					}
					segment.activeRecords++
				}
			}
			pending = pending[:0]
			pendingBytes = pendingBytes[:0]
			clear(pendingIDs)
			committedOffset = offset + frameSize
		}
		offset += frameSize
	}
	if len(pending) > 0 {
		return wal.truncateUncommittedTail(segment, data, committedOffset, isLast)
	}
	segment.size = int64(len(data))
	return 0, nil
}

func validRecoveredCommit(commit walCommit, pending []recoveredWALFrame, encoded []byte, sequence uint64) bool {
	if len(pending) == 0 || int(commit.count) != len(pending) || sequence != commit.lastID {
		return false
	}
	return commit.firstID == pending[0].id && commit.lastID == pending[len(pending)-1].id &&
		int(commit.dataBytes) == len(encoded) && crc32.ChecksumIEEE(encoded) == commit.checksum
}

func (wal *WAL) truncateUncommittedTail(
	segment *walSegment,
	data []byte,
	committedOffset int,
	isLast bool,
) (int64, error) {
	if !isLast {
		return 0, fmt.Errorf("%w: non-final segment %d has an incomplete tail", ErrCorruptWAL, segment.id)
	}
	truncated := int64(len(data) - committedOffset)
	if truncated == 0 {
		segment.size = int64(len(data))
		return 0, nil
	}
	file, err := os.OpenFile(segment.path, os.O_WRONLY, 0o600)
	if err != nil {
		return 0, fmt.Errorf("open WAL tail for repair: %w", err)
	}
	defer file.Close()
	if err := file.Truncate(int64(committedOffset)); err != nil {
		return 0, fmt.Errorf("truncate incomplete WAL tail: %w", err)
	}
	if err := file.Sync(); err != nil {
		return 0, fmt.Errorf("sync repaired WAL tail: %w", err)
	}
	segment.size = int64(committedOffset)
	return truncated, nil
}

func (wal *WAL) recoverState(segment *walSegment) (map[uint64]walStateEntry, int64, int64, error) {
	data, err := os.ReadFile(segment.statePath)
	if errors.Is(err, os.ErrNotExist) {
		if err := wal.createStateFile(segment.id, segment.statePath); err != nil {
			return nil, 0, 0, err
		}
		data = encodeWALStateHeader(segment.id)
	} else if err != nil {
		return nil, 0, 0, fmt.Errorf("read WAL checkpoint %d: %w", segment.id, err)
	}
	if len(data) < walStateHeaderSize {
		return nil, 0, 0, fmt.Errorf("%w: checkpoint %d has a partial header", ErrCorruptWAL, segment.id)
	}
	if err := decodeWALStateHeader(data[:walStateHeaderSize], segment.id); err != nil {
		return nil, 0, 0, fmt.Errorf("%w: checkpoint %d: %v", ErrCorruptWAL, segment.id, err)
	}
	states := make(map[uint64]walStateEntry)
	completeSize := walStateHeaderSize + ((len(data)-walStateHeaderSize)/walStateEntrySize)*walStateEntrySize
	for offset := walStateHeaderSize; offset < completeSize; offset += walStateEntrySize {
		state, err := decodeWALStateEntry(data[offset : offset+walStateEntrySize])
		if err != nil {
			return nil, 0, 0, fmt.Errorf("%w: checkpoint %d offset %d: %v", ErrCorruptWAL, segment.id, offset, err)
		}
		states[state.id] = state
	}
	truncated := int64(len(data) - completeSize)
	if truncated > 0 {
		file, err := os.OpenFile(segment.statePath, os.O_WRONLY, 0o600)
		if err != nil {
			return nil, 0, 0, err
		}
		if err := file.Truncate(int64(completeSize)); err != nil {
			file.Close()
			return nil, 0, 0, err
		}
		if err := file.Sync(); err != nil {
			file.Close()
			return nil, 0, 0, err
		}
		if err := file.Close(); err != nil {
			return nil, 0, 0, err
		}
	}
	return states, int64(completeSize), truncated, nil
}

func (wal *WAL) readRecordLocked(id uint64, metadata walRecordMetadata) (Record, error) {
	segment := wal.segments[metadata.segmentID]
	if segment == nil {
		return Record{}, errors.New("WAL record references a missing segment")
	}
	file, err := os.Open(segment.path)
	if err != nil {
		return Record{}, err
	}
	defer file.Close()
	encoded := make([]byte, metadata.frameSize)
	if _, err := file.ReadAt(encoded, metadata.offset); err != nil && !errors.Is(err, io.EOF) {
		return Record{}, err
	}
	kind, sequence, payloadSize, payloadChecksum, err := decodeWALFrameHeader(encoded[:walFrameHeaderSize])
	if err != nil || kind != walFrameData || sequence != id || int64(walFrameHeaderSize)+int64(payloadSize) != metadata.frameSize {
		return Record{}, errors.New("WAL record frame metadata is invalid")
	}
	payload := encoded[walFrameHeaderSize:]
	if crc32.ChecksumIEEE(payload) != payloadChecksum {
		return Record{}, errors.New("WAL record payload checksum mismatch")
	}
	record, err := decodeWALRecord(payload, id)
	if err != nil {
		return Record{}, err
	}
	record.Attempts = metadata.attempts
	return record, nil
}

func (wal *WAL) createSegment(id uint64) (*walSegment, error) {
	path := filepath.Join(wal.directory, segmentFilename(id))
	statePath := filepath.Join(wal.directory, stateFilename(id))
	temporaryPath := path + ".tmp"
	temporaryStatePath := statePath + ".tmp"
	dataFile, err := os.OpenFile(temporaryPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create WAL segment %d: %w", id, err)
	}
	cleanup := func() {
		dataFile.Close()
		os.Remove(temporaryPath)
		os.Remove(temporaryStatePath)
	}
	if _, err := dataFile.Write(encodeWALSegmentHeader(id, time.Now().UTC())); err != nil {
		cleanup()
		return nil, err
	}
	if err := dataFile.Sync(); err != nil {
		cleanup()
		return nil, err
	}
	if err := dataFile.Close(); err != nil {
		cleanup()
		return nil, err
	}
	stateFile, err := os.OpenFile(temporaryStatePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		cleanup()
		return nil, err
	}
	if _, err := stateFile.Write(encodeWALStateHeader(id)); err != nil {
		stateFile.Close()
		cleanup()
		return nil, err
	}
	if err := stateFile.Sync(); err != nil {
		stateFile.Close()
		cleanup()
		return nil, err
	}
	if err := stateFile.Close(); err != nil {
		cleanup()
		return nil, err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		cleanup()
		return nil, err
	}
	if err := os.Rename(temporaryStatePath, statePath); err != nil {
		return nil, err
	}
	if err := syncDirectory(wal.directory); err != nil {
		return nil, err
	}
	dataFile, err = os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	stateFile, err = os.OpenFile(statePath, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		dataFile.Close()
		return nil, err
	}
	return &walSegment{
		id: id, path: path, statePath: statePath, file: dataFile, stateFile: stateFile,
		size: walSegmentHeaderSize, stateSize: walStateHeaderSize,
	}, nil
}

func (wal *WAL) createStateFile(id uint64, path string) error {
	temporary := path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	remove := true
	defer func() {
		file.Close()
		if remove {
			os.Remove(temporary)
		}
	}()
	if _, err := file.Write(encodeWALStateHeader(id)); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		return err
	}
	remove = false
	return syncDirectory(wal.directory)
}

func (wal *WAL) installSegment(segment *walSegment) {
	wal.segments[segment.id] = segment
	wal.segmentIDs = append(wal.segmentIDs, segment.id)
	wal.usedBytes += segment.size + segment.stateSize
	if segment.id >= wal.nextSegmentID {
		wal.nextSegmentID = segment.id + 1
	}
}

func (wal *WAL) rotateLocked() error {
	segment, err := wal.createSegment(wal.nextSegmentID)
	if err != nil {
		return fmt.Errorf("rotate WAL segment: %w", err)
	}
	if wal.current.file != nil {
		if err := wal.current.file.Close(); err != nil {
			segment.file.Close()
			segment.stateFile.Close()
			return err
		}
		wal.current.file = nil
	}
	wal.current.closed = true
	wal.installSegment(segment)
	wal.current = segment
	return nil
}

func (wal *WAL) compactSegments() {
	started := time.Now()
	wal.checkpointMutex.Lock()
	wal.mutex.Lock()
	removed := wal.compactSegmentsLocked()
	wal.mutex.Unlock()
	wal.checkpointMutex.Unlock()
	if removed > 0 && wal.observer != nil {
		wal.observer.ObserveWALCompaction(time.Since(started), removed)
	}
}

func (wal *WAL) compactSegmentsLocked() int {
	removed := 0
	remaining := wal.segmentIDs[:0]
	for _, id := range wal.segmentIDs {
		segment := wal.segments[id]
		if segment == wal.current || !segment.closed || segment.activeRecords > 0 || segment.quarantinedRecords > 0 {
			remaining = append(remaining, id)
			continue
		}
		if segment.stateFile != nil {
			if err := segment.stateFile.Close(); err != nil {
				wal.fault = err
				remaining = append(remaining, id)
				continue
			}
			segment.stateFile = nil
		}
		if err := os.Remove(segment.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			wal.fault = err
			remaining = append(remaining, id)
			continue
		}
		if err := os.Remove(segment.statePath); err != nil && !errors.Is(err, os.ErrNotExist) {
			wal.fault = err
			remaining = append(remaining, id)
			continue
		}
		wal.usedBytes -= segment.size + segment.stateSize
		delete(wal.segments, id)
		removed++
	}
	wal.segmentIDs = remaining
	if removed > 0 {
		if err := syncDirectory(wal.directory); err != nil {
			wal.fault = err
		}
		wal.observeUsageLocked()
	}
	return removed
}

func (wal *WAL) recordRecoveryCorruption() {
	if wal.observer != nil {
		wal.observer.RecordWALCorruption()
	}
}
