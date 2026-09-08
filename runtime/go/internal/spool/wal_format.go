package spool

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"time"
)

const (
	walSegmentMagic      = "NFWALSEG"
	walSegmentVersion    = uint16(1)
	walSegmentHeaderSize = 32
	walFrameMagic        = "NFWR"
	walRecordVersion     = uint8(1)
	walFrameHeaderSize   = 28
	walCommitPayloadSize = 28
	walStateMagic        = "NFWSTATE"
	walStateVersion      = uint16(1)
	walStateHeaderSize   = 24
	walStateEntryMagic   = "NFWS"
	walStateEntryVersion = uint8(1)
	walStateEntrySize    = 24
)

type walFrameKind uint8

const (
	walFrameData   walFrameKind = 1
	walFrameCommit walFrameKind = 2
)

type walStateKind uint8

const (
	walStateRetry      walStateKind = 1
	walStateAck        walStateKind = 2
	walStateQuarantine walStateKind = 3
)

type walStateReason uint8

const (
	walReasonNone              walStateReason = 0
	walReasonPermanent         walStateReason = 1
	walReasonAttemptsExhausted walStateReason = 2
)

type walCommit struct {
	firstID   uint64
	lastID    uint64
	count     uint32
	dataBytes uint32
	checksum  uint32
}

type walStateEntry struct {
	kind     walStateKind
	reason   walStateReason
	id       uint64
	attempts uint32
}

func encodeWALSegmentHeader(segmentID uint64, createdAt time.Time) []byte {
	header := make([]byte, walSegmentHeaderSize)
	copy(header[:8], walSegmentMagic)
	binary.BigEndian.PutUint16(header[8:10], walSegmentVersion)
	binary.BigEndian.PutUint16(header[10:12], walSegmentHeaderSize)
	binary.BigEndian.PutUint64(header[12:20], segmentID)
	binary.BigEndian.PutUint64(header[20:28], uint64(createdAt.UnixNano()))
	binary.BigEndian.PutUint32(header[28:32], crc32.ChecksumIEEE(header[:28]))
	return header
}

func decodeWALSegmentHeader(header []byte, expectedID uint64) error {
	if len(header) != walSegmentHeaderSize || string(header[:8]) != walSegmentMagic {
		return errors.New("invalid WAL segment header")
	}
	if binary.BigEndian.Uint16(header[8:10]) != walSegmentVersion ||
		binary.BigEndian.Uint16(header[10:12]) != walSegmentHeaderSize {
		return errors.New("unsupported WAL segment version")
	}
	if binary.BigEndian.Uint64(header[12:20]) != expectedID {
		return errors.New("WAL segment ID does not match its filename")
	}
	if crc32.ChecksumIEEE(header[:28]) != binary.BigEndian.Uint32(header[28:32]) {
		return errors.New("WAL segment header checksum mismatch")
	}
	return nil
}

func encodeWALDataFrame(record Record) ([]byte, error) {
	payload, err := json.Marshal(diskRecord{
		ID: record.ID, EnqueuedAtUnixNano: record.EnqueuedAt.UnixNano(), Envelope: record.Envelope,
	})
	if err != nil {
		return nil, fmt.Errorf("encode WAL record: %w", err)
	}
	return encodeWALFrame(walFrameData, record.ID, payload), nil
}

func encodeWALCommitFrame(commit walCommit) []byte {
	payload := make([]byte, walCommitPayloadSize)
	binary.BigEndian.PutUint64(payload[0:8], commit.firstID)
	binary.BigEndian.PutUint64(payload[8:16], commit.lastID)
	binary.BigEndian.PutUint32(payload[16:20], commit.count)
	binary.BigEndian.PutUint32(payload[20:24], commit.dataBytes)
	binary.BigEndian.PutUint32(payload[24:28], commit.checksum)
	return encodeWALFrame(walFrameCommit, commit.lastID, payload)
}

func decodeWALCommit(payload []byte) (walCommit, error) {
	if len(payload) != walCommitPayloadSize {
		return walCommit{}, errors.New("invalid WAL commit marker length")
	}
	return walCommit{
		firstID: binary.BigEndian.Uint64(payload[0:8]), lastID: binary.BigEndian.Uint64(payload[8:16]),
		count: binary.BigEndian.Uint32(payload[16:20]), dataBytes: binary.BigEndian.Uint32(payload[20:24]),
		checksum: binary.BigEndian.Uint32(payload[24:28]),
	}, nil
}

func encodeWALFrame(kind walFrameKind, sequence uint64, payload []byte) []byte {
	header := make([]byte, walFrameHeaderSize)
	copy(header[:4], walFrameMagic)
	header[4] = walRecordVersion
	header[5] = byte(kind)
	binary.BigEndian.PutUint32(header[8:12], uint32(len(payload)))
	binary.BigEndian.PutUint64(header[12:20], sequence)
	binary.BigEndian.PutUint32(header[20:24], crc32.ChecksumIEEE(payload))
	binary.BigEndian.PutUint32(header[24:28], crc32.ChecksumIEEE(header[:24]))
	return append(header, payload...)
}

func decodeWALFrameHeader(header []byte) (walFrameKind, uint64, uint32, uint32, error) {
	if len(header) != walFrameHeaderSize || string(header[:4]) != walFrameMagic {
		return 0, 0, 0, 0, errors.New("invalid WAL record header")
	}
	if header[4] != walRecordVersion {
		return 0, 0, 0, 0, fmt.Errorf("unsupported WAL record version %d", header[4])
	}
	kind := walFrameKind(header[5])
	if kind != walFrameData && kind != walFrameCommit {
		return 0, 0, 0, 0, fmt.Errorf("unsupported WAL record kind %d", kind)
	}
	if crc32.ChecksumIEEE(header[:24]) != binary.BigEndian.Uint32(header[24:28]) {
		return 0, 0, 0, 0, errors.New("WAL record header checksum mismatch")
	}
	return kind, binary.BigEndian.Uint64(header[12:20]), binary.BigEndian.Uint32(header[8:12]),
		binary.BigEndian.Uint32(header[20:24]), nil
}

func decodeWALRecord(payload []byte, expectedID uint64) (Record, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var stored diskRecord
	if err := decoder.Decode(&stored); err != nil {
		return Record{}, fmt.Errorf("decode WAL record: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Record{}, errors.New("WAL record contains multiple JSON values")
	}
	if stored.ID == 0 || stored.ID != expectedID || stored.EnqueuedAtUnixNano <= 0 {
		return Record{}, errors.New("WAL record metadata is invalid")
	}
	return Record{
		ID: stored.ID, EnqueuedAt: time.Unix(0, stored.EnqueuedAtUnixNano).UTC(), Envelope: stored.Envelope,
	}, nil
}

func encodeWALStateHeader(segmentID uint64) []byte {
	header := make([]byte, walStateHeaderSize)
	copy(header[:8], walStateMagic)
	binary.BigEndian.PutUint16(header[8:10], walStateVersion)
	binary.BigEndian.PutUint16(header[10:12], walStateHeaderSize)
	binary.BigEndian.PutUint64(header[12:20], segmentID)
	binary.BigEndian.PutUint32(header[20:24], crc32.ChecksumIEEE(header[:20]))
	return header
}

func decodeWALStateHeader(header []byte, expectedID uint64) error {
	if len(header) != walStateHeaderSize || string(header[:8]) != walStateMagic {
		return errors.New("invalid WAL checkpoint header")
	}
	if binary.BigEndian.Uint16(header[8:10]) != walStateVersion ||
		binary.BigEndian.Uint16(header[10:12]) != walStateHeaderSize {
		return errors.New("unsupported WAL checkpoint version")
	}
	if binary.BigEndian.Uint64(header[12:20]) != expectedID {
		return errors.New("WAL checkpoint segment ID mismatch")
	}
	if crc32.ChecksumIEEE(header[:20]) != binary.BigEndian.Uint32(header[20:24]) {
		return errors.New("WAL checkpoint header checksum mismatch")
	}
	return nil
}

func encodeWALStateEntry(entry walStateEntry) []byte {
	encoded := make([]byte, walStateEntrySize)
	copy(encoded[:4], walStateEntryMagic)
	encoded[4] = walStateEntryVersion
	encoded[5] = byte(entry.kind)
	encoded[6] = byte(entry.reason)
	binary.BigEndian.PutUint64(encoded[8:16], entry.id)
	binary.BigEndian.PutUint32(encoded[16:20], entry.attempts)
	binary.BigEndian.PutUint32(encoded[20:24], crc32.ChecksumIEEE(encoded[:20]))
	return encoded
}

func decodeWALStateEntry(encoded []byte) (walStateEntry, error) {
	if len(encoded) != walStateEntrySize || string(encoded[:4]) != walStateEntryMagic {
		return walStateEntry{}, errors.New("invalid WAL checkpoint entry")
	}
	if encoded[4] != walStateEntryVersion {
		return walStateEntry{}, fmt.Errorf("unsupported WAL checkpoint entry version %d", encoded[4])
	}
	kind := walStateKind(encoded[5])
	if kind != walStateRetry && kind != walStateAck && kind != walStateQuarantine {
		return walStateEntry{}, fmt.Errorf("unsupported WAL checkpoint kind %d", kind)
	}
	if crc32.ChecksumIEEE(encoded[:20]) != binary.BigEndian.Uint32(encoded[20:24]) {
		return walStateEntry{}, errors.New("WAL checkpoint entry checksum mismatch")
	}
	return walStateEntry{
		kind: kind, reason: walStateReason(encoded[6]), id: binary.BigEndian.Uint64(encoded[8:16]),
		attempts: binary.BigEndian.Uint32(encoded[16:20]),
	}, nil
}
