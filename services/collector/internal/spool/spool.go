package spool

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/msHamed1/node-flow/services/collector/internal/telemetry"
)

var (
	ErrFull          = errors.New("collector durable spool is full")
	ErrBusy          = errors.New("collector durable admission queue is full")
	ErrCorruptRecord = errors.New("collector spool record is corrupt")
	ErrCorruptWAL    = errors.New("collector WAL contains committed corruption")
	ErrLegacySpool   = errors.New("legacy per-envelope spool records are present")
)

const (
	recordMagic   = "NFW1"
	recordSuffix  = ".wal"
	filenameWidth = 20
	attemptWidth  = 5
)

type Observer interface {
	SetSpoolUsage(bytes int64, activeRecords int64, quarantinedRecords int64)
	RecordSpoolCorruption()
}

type Config struct {
	Directory string
	MaxBytes  int64
}

type Recovery struct {
	Records     int64
	Bytes       int64
	Corruptions int64
	Segments    int64
	Truncated   int64
}

type Stats struct {
	Bytes              int64
	ReservedBytes      int64
	ActiveRecords      int64
	QuarantinedRecords int64
	Segments           int64
}

type Record struct {
	ID         uint64
	Attempts   int
	EnqueuedAt time.Time
	Envelope   telemetry.Envelope
}

// Storage is the durable admission contract used by the processing pipeline.
// Implementations must not return successfully from Append until the record has
// crossed their documented crash-recovery boundary.
type Storage interface {
	Append(context.Context, telemetry.Envelope) (Record, error)
	NextAfter(uint64) (Record, bool, error)
	Ack([]Record) error
	MarkRetry([]Record) error
	Quarantine([]Record, string) error
	Stats() Stats
	Ready() error
	Close() error
}

var _ Storage = (*Store)(nil)

type diskRecord struct {
	ID                 uint64             `json:"id"`
	EnqueuedAtUnixNano int64              `json:"enqueuedAtUnixNano"`
	Envelope           telemetry.Envelope `json:"envelope"`
}

type metadata struct {
	filename  string
	attempts  int
	allocated int64
}

type Store struct {
	mutex               sync.Mutex
	directory           string
	quarantineDirectory string
	maxBytes            int64
	nextID              uint64
	usedBytes           int64
	active              map[uint64]metadata
	ids                 []uint64
	quarantined         int64
	observer            Observer
}

func Open(config Config, observer Observer) (*Store, Recovery, error) {
	if strings.TrimSpace(config.Directory) == "" {
		return nil, Recovery{}, errors.New("spool directory is required")
	}
	if config.MaxBytes < 1 {
		return nil, Recovery{}, errors.New("spool maximum bytes must be positive")
	}
	directory, err := filepath.Abs(config.Directory)
	if err != nil {
		return nil, Recovery{}, fmt.Errorf("resolve spool directory: %w", err)
	}
	quarantineDirectory := filepath.Join(directory, "quarantine")
	if err := os.MkdirAll(quarantineDirectory, 0o700); err != nil {
		return nil, Recovery{}, fmt.Errorf("create spool directories: %w", err)
	}
	if err := os.Chmod(directory, 0o700); err != nil {
		return nil, Recovery{}, fmt.Errorf("secure spool directory: %w", err)
	}
	if err := os.Chmod(quarantineDirectory, 0o700); err != nil {
		return nil, Recovery{}, fmt.Errorf("secure spool quarantine: %w", err)
	}

	store := &Store{
		directory: directory, quarantineDirectory: quarantineDirectory, maxBytes: config.MaxBytes,
		nextID: 1, active: make(map[uint64]metadata), observer: observer,
	}
	recovery, err := store.recover()
	if err != nil {
		return nil, Recovery{}, err
	}
	store.observe()
	return store, recovery, nil
}

func (store *Store) Append(ctx context.Context, envelope telemetry.Envelope) (Record, error) {
	if err := ctx.Err(); err != nil {
		return Record{}, err
	}
	store.mutex.Lock()
	defer store.mutex.Unlock()

	id := store.nextID
	store.nextID++
	record := Record{ID: id, EnqueuedAt: time.Now().UTC(), Envelope: envelope}
	encoded, err := encodeRecord(record)
	if err != nil {
		return Record{}, err
	}
	temporary := filepath.Join(store.directory, fmt.Sprintf(".%020d.tmp", id))
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return Record{}, fmt.Errorf("create spool record: %w", err)
	}
	removeTemporary := true
	defer func() {
		_ = file.Close()
		if removeTemporary {
			_ = os.Remove(temporary)
		}
	}()
	if _, err := file.Write(encoded); err != nil {
		return Record{}, fmt.Errorf("write spool record: %w", err)
	}
	if err := file.Sync(); err != nil {
		return Record{}, fmt.Errorf("sync spool record: %w", err)
	}
	info, err := file.Stat()
	if err != nil {
		return Record{}, fmt.Errorf("stat spool record: %w", err)
	}
	allocated := allocatedFileBytes(info)
	if store.usedBytes+allocated > store.maxBytes {
		return Record{}, ErrFull
	}
	if err := file.Close(); err != nil {
		return Record{}, fmt.Errorf("close spool record: %w", err)
	}
	filename := activeFilename(id, 0)
	if err := os.Rename(temporary, filepath.Join(store.directory, filename)); err != nil {
		return Record{}, fmt.Errorf("commit spool record: %w", err)
	}
	removeTemporary = false
	store.active[id] = metadata{filename: filename, attempts: 0, allocated: allocated}
	store.ids = append(store.ids, id)
	store.usedBytes += allocated
	store.observe()
	if err := syncDirectory(store.directory); err != nil {
		return record, fmt.Errorf("sync spool directory: %w", err)
	}
	return record, nil
}

func (store *Store) NextAfter(after uint64) (Record, bool, error) {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	index := sort.Search(len(store.ids), func(index int) bool { return store.ids[index] > after })
	for index < len(store.ids) {
		id := store.ids[index]
		index++
		entry, exists := store.active[id]
		if !exists {
			continue
		}
		record, err := store.read(id, entry)
		if err == nil {
			return record, true, nil
		}
		if !errors.Is(err, ErrCorruptRecord) {
			return Record{ID: id}, true, err
		}
		if quarantineErr := store.quarantineLocked(id, "corrupt"); quarantineErr != nil {
			return Record{}, false, fmt.Errorf("quarantine corrupt spool record %d: %w", id, quarantineErr)
		}
		if store.observer != nil {
			store.observer.RecordSpoolCorruption()
		}
		store.compactIndex()
		store.observe()
		if syncErr := store.syncQuarantineMove(); syncErr != nil {
			return Record{ID: id}, true, fmt.Errorf("%w: record %d quarantined but not checkpointed: %v", ErrCorruptRecord, id, syncErr)
		}
		return Record{ID: id}, true, fmt.Errorf("%w: record %d: %v", ErrCorruptRecord, id, err)
	}
	return Record{}, false, nil
}

func (store *Store) Ack(records []Record) error {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	changed := false
	for _, record := range records {
		entry, exists := store.active[record.ID]
		if !exists {
			continue
		}
		if err := os.Remove(filepath.Join(store.directory, entry.filename)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove acknowledged spool record %d: %w", record.ID, err)
		}
		delete(store.active, record.ID)
		store.usedBytes -= entry.allocated
		changed = true
	}
	if !changed {
		return nil
	}
	store.compactIndex()
	store.observe()
	return syncDirectory(store.directory)
}

func (store *Store) MarkRetry(records []Record) error {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	changed := false
	for index := range records {
		entry, exists := store.active[records[index].ID]
		if !exists {
			continue
		}
		nextAttempts := entry.attempts + 1
		if nextAttempts > 99_999 {
			return fmt.Errorf("spool retry count exceeded for record %d", records[index].ID)
		}
		nextFilename := activeFilename(records[index].ID, nextAttempts)
		if err := os.Rename(
			filepath.Join(store.directory, entry.filename),
			filepath.Join(store.directory, nextFilename),
		); err != nil {
			return fmt.Errorf("checkpoint retry for spool record %d: %w", records[index].ID, err)
		}
		entry.filename = nextFilename
		entry.attempts = nextAttempts
		store.active[records[index].ID] = entry
		records[index].Attempts = nextAttempts
		changed = true
	}
	if changed {
		return syncDirectory(store.directory)
	}
	return nil
}

func (store *Store) Quarantine(records []Record, reason string) error {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	for _, record := range records {
		if err := store.quarantineLocked(record.ID, reason); err != nil {
			return err
		}
	}
	store.compactIndex()
	store.observe()
	if err := syncDirectory(store.directory); err != nil {
		return err
	}
	return syncDirectory(store.quarantineDirectory)
}

func (store *Store) Stats() Stats {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	return Stats{
		Bytes: store.usedBytes, ActiveRecords: int64(len(store.active)),
		QuarantinedRecords: store.quarantined,
	}
}

func (store *Store) Ready() error {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	if store.usedBytes >= store.maxBytes {
		return ErrFull
	}
	return nil
}

func (store *Store) Close() error {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	return syncDirectory(store.directory)
}

func (store *Store) recover() (Recovery, error) {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	recovery := Recovery{}
	quarantined, err := os.ReadDir(store.quarantineDirectory)
	if err != nil {
		return recovery, fmt.Errorf("read spool quarantine: %w", err)
	}
	for _, entry := range quarantined {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return recovery, err
		}
		store.usedBytes += allocatedFileBytes(info)
		store.quarantined++
		store.bumpSequence(entry.Name())
	}

	entries, err := os.ReadDir(store.directory)
	if err != nil {
		return recovery, fmt.Errorf("read spool directory: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if strings.HasSuffix(entry.Name(), ".tmp") {
			if err := os.Remove(filepath.Join(store.directory, entry.Name())); err != nil {
				return recovery, fmt.Errorf("remove incomplete spool record: %w", err)
			}
			if err := syncDirectory(store.directory); err != nil {
				return recovery, fmt.Errorf("sync removal of incomplete spool record: %w", err)
			}
			continue
		}
		id, attempts, validName := parseActiveFilename(entry.Name())
		info, statErr := entry.Info()
		if statErr != nil {
			return recovery, statErr
		}
		allocated := allocatedFileBytes(info)
		store.usedBytes += allocated
		if !validName {
			if err := store.quarantinePathLocked(entry.Name(), "corrupt"); err != nil {
				return recovery, err
			}
			if err := store.syncQuarantineMove(); err != nil {
				return recovery, err
			}
			recovery.Corruptions++
			continue
		}
		store.bumpSequence(entry.Name())
		metadata := metadata{filename: entry.Name(), attempts: attempts, allocated: allocated}
		if _, duplicate := store.active[id]; duplicate {
			if err := store.quarantinePathLocked(entry.Name(), "duplicate-id"); err != nil {
				return recovery, err
			}
			if err := store.syncQuarantineMove(); err != nil {
				return recovery, err
			}
			recovery.Corruptions++
			continue
		}
		if _, err := store.read(id, metadata); err != nil {
			if !errors.Is(err, ErrCorruptRecord) {
				return recovery, fmt.Errorf("recover spool record %d: %w", id, err)
			}
			if err := store.quarantinePathLocked(entry.Name(), "corrupt"); err != nil {
				return recovery, err
			}
			if err := store.syncQuarantineMove(); err != nil {
				return recovery, err
			}
			recovery.Corruptions++
			continue
		}
		store.active[id] = metadata
		store.ids = append(store.ids, id)
		recovery.Records++
	}
	sort.Slice(store.ids, func(left, right int) bool { return store.ids[left] < store.ids[right] })
	recovery.Bytes = store.usedBytes
	if store.observer != nil {
		for range recovery.Corruptions {
			store.observer.RecordSpoolCorruption()
		}
	}
	return recovery, nil
}

func (store *Store) read(id uint64, entry metadata) (Record, error) {
	data, err := os.ReadFile(filepath.Join(store.directory, entry.filename))
	if err != nil {
		return Record{}, fmt.Errorf("read record: %w", err)
	}
	record, err := decodeRecord(data)
	if err != nil {
		return Record{}, fmt.Errorf("%w: %v", ErrCorruptRecord, err)
	}
	if record.ID != id {
		return Record{}, fmt.Errorf("%w: record id %d does not match filename id %d", ErrCorruptRecord, record.ID, id)
	}
	record.Attempts = entry.attempts
	return record, nil
}

func (store *Store) quarantineLocked(id uint64, reason string) error {
	entry, exists := store.active[id]
	if !exists {
		return nil
	}
	if err := store.quarantinePathLocked(entry.filename, reason); err != nil {
		return err
	}
	delete(store.active, id)
	return nil
}

func (store *Store) quarantinePathLocked(filename, reason string) error {
	safeReason := strings.Map(func(character rune) rune {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '-' {
			return character
		}
		return '-'
	}, strings.ToLower(reason))
	destination := filepath.Join(store.quarantineDirectory, filename+"."+safeReason+".dead")
	if err := os.Rename(filepath.Join(store.directory, filename), destination); err != nil {
		return fmt.Errorf("quarantine spool record %s: %w", filename, err)
	}
	store.quarantined++
	return nil
}

func (store *Store) syncQuarantineMove() error {
	if err := syncDirectory(store.directory); err != nil {
		return fmt.Errorf("sync spool after quarantine: %w", err)
	}
	if err := syncDirectory(store.quarantineDirectory); err != nil {
		return fmt.Errorf("sync quarantine directory: %w", err)
	}
	return nil
}

func (store *Store) compactIndex() {
	if len(store.ids) < 1_024 || len(store.ids) <= len(store.active)*2 {
		return
	}
	ids := make([]uint64, 0, len(store.active))
	for _, id := range store.ids {
		if _, exists := store.active[id]; exists {
			ids = append(ids, id)
		}
	}
	store.ids = ids
}

func (store *Store) observe() {
	if store.observer != nil {
		store.observer.SetSpoolUsage(store.usedBytes, int64(len(store.active)), store.quarantined)
	}
}

func (store *Store) bumpSequence(filename string) {
	prefix := strings.SplitN(filename, "-", 2)[0]
	id, err := strconv.ParseUint(strings.TrimLeft(prefix, "0"), 10, 64)
	if err == nil && id >= store.nextID {
		store.nextID = id + 1
	}
}

func activeFilename(id uint64, attempts int) string {
	return fmt.Sprintf("%0*d-%0*d%s", filenameWidth, id, attemptWidth, attempts, recordSuffix)
}

func parseActiveFilename(filename string) (uint64, int, bool) {
	if !strings.HasSuffix(filename, recordSuffix) {
		return 0, 0, false
	}
	base := strings.TrimSuffix(filename, recordSuffix)
	parts := strings.Split(base, "-")
	if len(parts) != 2 || len(parts[0]) != filenameWidth || len(parts[1]) != attemptWidth {
		return 0, 0, false
	}
	id, idErr := strconv.ParseUint(parts[0], 10, 64)
	attempts, attemptsErr := strconv.Atoi(parts[1])
	return id, attempts, idErr == nil && attemptsErr == nil && id > 0
}

func encodeRecord(record Record) ([]byte, error) {
	payload, err := json.Marshal(diskRecord{
		ID: record.ID, EnqueuedAtUnixNano: record.EnqueuedAt.UnixNano(), Envelope: record.Envelope,
	})
	if err != nil {
		return nil, fmt.Errorf("encode spool record: %w", err)
	}
	buffer := bytes.NewBuffer(make([]byte, 0, len(payload)+12))
	buffer.WriteString(recordMagic)
	if err := binary.Write(buffer, binary.BigEndian, uint32(len(payload))); err != nil {
		return nil, err
	}
	buffer.Write(payload)
	if err := binary.Write(buffer, binary.BigEndian, crc32.ChecksumIEEE(payload)); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func decodeRecord(data []byte) (Record, error) {
	if len(data) < 12 || string(data[:4]) != recordMagic {
		return Record{}, errors.New("invalid record header")
	}
	payloadSize := int(binary.BigEndian.Uint32(data[4:8]))
	if payloadSize < 1 || payloadSize != len(data)-12 {
		return Record{}, errors.New("invalid record length")
	}
	payload := data[8 : 8+payloadSize]
	writtenChecksum := binary.BigEndian.Uint32(data[8+payloadSize:])
	if crc32.ChecksumIEEE(payload) != writtenChecksum {
		return Record{}, errors.New("record checksum mismatch")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var stored diskRecord
	if err := decoder.Decode(&stored); err != nil {
		return Record{}, fmt.Errorf("decode record payload: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Record{}, errors.New("record payload contains multiple values")
	}
	if stored.ID == 0 || stored.EnqueuedAtUnixNano <= 0 {
		return Record{}, errors.New("record metadata is invalid")
	}
	return Record{
		ID: stored.ID, EnqueuedAt: time.Unix(0, stored.EnqueuedAtUnixNano).UTC(), Envelope: stored.Envelope,
	}, nil
}
