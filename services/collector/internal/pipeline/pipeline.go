package pipeline

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"sync"
	"time"

	collectormetrics "github.com/msHamed1/node-flow/services/collector/internal/metrics"
	"github.com/msHamed1/node-flow/services/collector/internal/spool"
	"github.com/msHamed1/node-flow/services/collector/internal/telemetry"
)

var (
	ErrQueueFull = errors.New("collector queue is full")
	ErrSpoolFull = spool.ErrFull
	ErrClosed    = errors.New("collector is shutting down")
)

type Outcome struct {
	Revision *uint64
}

type Sink interface {
	ConsumeBatch(context.Context, []telemetry.Envelope) ([]Outcome, error)
	Ready(context.Context) error
	Close() error
}

type Config struct {
	Workers       int
	QueueSize     int
	BatchSize     int
	FlushInterval time.Duration
	Spool         spool.Storage
	Retry         RetryConfig
}

type RetryConfig struct {
	InitialBackoff time.Duration
	MaxBackoff     time.Duration
	MaxAttempts    int
	Jitter         float64
}

type Pipeline struct {
	config     Config
	sink       Sink
	metrics    *collectormetrics.Collector
	logger     *slog.Logger
	spool      spool.Storage
	retry      RetryConfig
	queue      chan *item
	jobs       []chan []*item
	context    context.Context
	cancel     context.CancelFunc
	mutex      sync.RWMutex
	stateMutex sync.Mutex
	// admissionBarrier lets WAL appends group concurrently while ensuring the
	// loader cannot publish before a Submit waiter exists. The loader also holds
	// stateMutex while reading storage so a just-acknowledged stale read cannot be
	// re-enqueued after its in-flight marker is released.
	admissionBarrier sync.RWMutex
	accepting        bool
	inFlight         map[uint64]struct{}
	waiters          map[uint64]chan result
	wake             chan struct{}
	closeOnce        sync.Once
	loader           sync.WaitGroup
	workers          sync.WaitGroup
	dispatcher       sync.WaitGroup
	done             chan struct{}
}

type item struct {
	envelope telemetry.Envelope
	received time.Time
	result   chan result
	record   *spool.Record
}

type result struct {
	outcome Outcome
	error   error
}

func New(config Config, sink Sink, metrics *collectormetrics.Collector, logger *slog.Logger) (*Pipeline, error) {
	if config.Workers < 1 || config.QueueSize < 1 || config.BatchSize < 1 || config.FlushInterval <= 0 {
		return nil, errors.New("workers, queue size, batch size, and flush interval must be positive")
	}
	if config.BatchSize > config.QueueSize {
		return nil, errors.New("batch size cannot exceed queue size")
	}
	if config.Spool != nil {
		if config.Retry.InitialBackoff <= 0 || config.Retry.MaxBackoff < config.Retry.InitialBackoff ||
			config.Retry.MaxAttempts < 1 || config.Retry.Jitter < 0 || config.Retry.Jitter > 1 {
			return nil, errors.New("durable retry settings are invalid")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	pipeline := &Pipeline{
		config:    config,
		sink:      sink,
		metrics:   metrics,
		logger:    logger,
		spool:     config.Spool,
		retry:     config.Retry,
		queue:     make(chan *item, config.QueueSize),
		jobs:      make([]chan []*item, config.Workers),
		context:   ctx,
		cancel:    cancel,
		accepting: true,
		inFlight:  make(map[uint64]struct{}),
		waiters:   make(map[uint64]chan result),
		wake:      make(chan struct{}, 1),
		done:      make(chan struct{}),
	}
	for worker := range pipeline.jobs {
		pipeline.jobs[worker] = make(chan []*item, 1)
	}
	pipeline.start()
	return pipeline, nil
}

func (p *Pipeline) Submit(ctx context.Context, envelope telemetry.Envelope) (Outcome, error) {
	entry, err := p.enqueue(ctx, envelope, true)
	if err != nil {
		return Outcome{}, err
	}

	select {
	case completed := <-entry.result:
		return completed.outcome, completed.error
	case <-ctx.Done():
		return Outcome{}, ctx.Err()
	}
}

// Enqueue admits an envelope without waiting for the sink. In durable mode it
// returns only after the storage implementation's documented durability
// boundary; in memory mode it returns after bounded channel admission.
func (p *Pipeline) Enqueue(ctx context.Context, envelope telemetry.Envelope) error {
	_, err := p.enqueue(ctx, envelope, false)
	return err
}

func (p *Pipeline) enqueue(ctx context.Context, envelope telemetry.Envelope, waitForResult bool) (*item, error) {
	eventCount := envelope.EventCount()
	p.metrics.RecordReceived(eventCount)
	entry := &item{envelope: envelope, received: time.Now()}
	if waitForResult {
		entry.result = make(chan result, 1)
	}

	p.mutex.RLock()
	if !p.accepting {
		p.mutex.RUnlock()
		p.metrics.RecordRejected("closed", eventCount)
		return nil, ErrClosed
	}
	if p.spool != nil {
		p.admissionBarrier.RLock()
		record, err := p.spool.Append(ctx, envelope)
		if err == nil && entry.result != nil {
			p.stateMutex.Lock()
			p.waiters[record.ID] = entry.result
			p.stateMutex.Unlock()
		}
		p.admissionBarrier.RUnlock()
		p.mutex.RUnlock()
		p.signalLoader()
		if err != nil {
			if errors.Is(err, spool.ErrBusy) {
				p.metrics.RecordRejected("queue_full", eventCount)
				return nil, ErrQueueFull
			}
			if errors.Is(err, spool.ErrFull) {
				p.metrics.RecordRejected("spool_full", eventCount)
				return nil, ErrSpoolFull
			}
			p.metrics.RecordError()
			return nil, err
		}
		entry.record = &record
		return entry, nil
	}
	select {
	case p.queue <- entry:
		p.metrics.SetQueueDepth(len(p.queue))
		p.mutex.RUnlock()
	case <-ctx.Done():
		p.mutex.RUnlock()
		return nil, ctx.Err()
	default:
		p.mutex.RUnlock()
		p.metrics.RecordRejected("queue_full", eventCount)
		return nil, ErrQueueFull
	}
	return entry, nil
}

func (p *Pipeline) CloseAdmission() {
	p.closeOnce.Do(func() {
		p.mutex.Lock()
		p.accepting = false
		if p.spool == nil {
			close(p.queue)
		}
		p.mutex.Unlock()
		p.signalLoader()
	})
}

func (p *Pipeline) Wait(ctx context.Context) error {
	select {
	case <-p.done:
		return errors.Join(p.sink.Close(), p.closeSpool())
	case <-ctx.Done():
		p.cancel()
		select {
		case <-p.done:
		case <-time.After(time.Second):
		}
		return fmt.Errorf("drain collector pipeline: %w", ctx.Err())
	}
}

func (p *Pipeline) closeSpool() error {
	if p.spool == nil {
		return nil
	}
	return p.spool.Close()
}

func (p *Pipeline) Ready(ctx context.Context) error {
	p.mutex.RLock()
	accepting := p.accepting
	p.mutex.RUnlock()
	if !accepting {
		return ErrClosed
	}
	if p.spool != nil {
		return p.spool.Ready()
	}
	return p.sink.Ready(ctx)
}

func (p *Pipeline) start() {
	if p.spool != nil {
		p.loader.Add(1)
		go p.loadDurableRecords()
	}
	p.dispatcher.Add(1)
	go p.dispatch()
	for worker := 0; worker < p.config.Workers; worker++ {
		p.workers.Add(1)
		go p.work(worker+1, p.jobs[worker])
	}
	go func() {
		p.loader.Wait()
		p.dispatcher.Wait()
		p.workers.Wait()
		close(p.done)
	}()
}

func (p *Pipeline) loadDurableRecords() {
	defer p.loader.Done()
	defer close(p.queue)
	var cursor uint64
	for {
		p.admissionBarrier.Lock()
		p.stateMutex.Lock()
		record, found, err := p.spool.NextAfter(cursor)
		if err != nil {
			p.stateMutex.Unlock()
			p.admissionBarrier.Unlock()
			if errors.Is(err, spool.ErrCorruptRecord) {
				cursor = record.ID
				p.logger.Error("quarantined corrupt spool record", "record_id", record.ID, "error", err)
				continue
			}
			p.logger.Error("read durable spool record", "record_id", record.ID, "error", err)
			if !p.waitForLoaderWake(100 * time.Millisecond) {
				return
			}
			continue
		}
		if found {
			cursor = record.ID
			if _, exists := p.inFlight[record.ID]; exists {
				p.stateMutex.Unlock()
				p.admissionBarrier.Unlock()
				continue
			}
			p.inFlight[record.ID] = struct{}{}
			waiter := p.waiters[record.ID]
			p.stateMutex.Unlock()
			p.admissionBarrier.Unlock()
			entry := &item{
				envelope: record.Envelope, received: record.EnqueuedAt, result: waiter, record: &record,
			}
			select {
			case p.queue <- entry:
				p.metrics.SetQueueDepth(len(p.queue))
			case <-p.context.Done():
				p.releaseRecords([]*item{entry})
				return
			}
			continue
		}
		p.stateMutex.Unlock()
		p.admissionBarrier.Unlock()

		cursor = 0
		p.mutex.RLock()
		accepting := p.accepting
		p.mutex.RUnlock()
		if !accepting && p.spool.Stats().ActiveRecords == 0 {
			return
		}
		if !p.waitForLoaderWake(100 * time.Millisecond) {
			return
		}
	}
}

func (p *Pipeline) waitForLoaderWake(interval time.Duration) bool {
	select {
	case <-p.wake:
		return true
	case <-time.After(interval):
		return true
	case <-p.context.Done():
		return false
	}
}

func (p *Pipeline) signalLoader() {
	if p.spool == nil {
		return
	}
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

func (p *Pipeline) dispatch() {
	defer p.dispatcher.Done()
	defer func() {
		for _, jobs := range p.jobs {
			close(jobs)
		}
	}()
	timer := time.NewTimer(p.config.FlushInterval)
	defer timer.Stop()
	pending := make([]*item, 0, p.config.BatchSize)
	var pendingEvents uint64

	flush := func() {
		if len(pending) == 0 {
			return
		}
		batch := pending
		pending = make([]*item, 0, p.config.BatchSize)
		pendingEvents = 0
		workerBatches := make([][][]*item, len(p.jobs))
		workerIndexes := make([]map[string]int, len(p.jobs))
		for _, entry := range batch {
			worker := workerIndex(entry.envelope, len(p.jobs))
			if workerIndexes[worker] == nil {
				workerIndexes[worker] = make(map[string]int)
			}
			key := serviceKey(entry.envelope)
			group, exists := workerIndexes[worker][key]
			if !exists {
				group = len(workerBatches[worker])
				workerIndexes[worker][key] = group
				workerBatches[worker] = append(workerBatches[worker], nil)
			}
			workerBatches[worker][group] = append(workerBatches[worker][group], entry)
		}
		for worker, serviceBatches := range workerBatches {
			for _, workerBatch := range serviceBatches {
				select {
				case p.jobs[worker] <- workerBatch:
				case <-p.context.Done():
					p.complete(workerBatch, nil, p.context.Err())
					p.releaseRecords(workerBatch)
				}
			}
		}
	}

	for {
		select {
		case entry, open := <-p.queue:
			if !open {
				flush()
				return
			}
			p.metrics.SetQueueDepth(len(p.queue))
			pending = append(pending, entry)
			pendingEvents += entry.envelope.EventCount()
			if pendingEvents >= uint64(p.config.BatchSize) {
				flush()
				resetTimer(timer, p.config.FlushInterval)
			}
		case <-timer.C:
			flush()
			timer.Reset(p.config.FlushInterval)
		case <-p.context.Done():
			p.complete(pending, nil, p.context.Err())
			p.releaseRecords(pending)
			for entry := range p.queue {
				p.complete([]*item{entry}, nil, p.context.Err())
				p.releaseRecords([]*item{entry})
			}
			return
		}
	}
}

func (p *Pipeline) work(id int, jobs <-chan []*item) {
	defer p.workers.Done()
	for batch := range jobs {
		eventCount := batchEventCount(batch)
		p.metrics.ObserveBatchSize(eventCount)
		envelopes := make([]telemetry.Envelope, len(batch))
		for index, entry := range batch {
			envelopes[index] = entry.envelope
		}
		for {
			p.metrics.WorkerStarted()
			outcomes, err := p.sink.ConsumeBatch(p.context, envelopes)
			p.metrics.WorkerStopped()
			if err == nil {
				if p.spool != nil {
					if err = p.ackDurableBatch(batch); err != nil {
						p.complete(batch, nil, err)
						p.releaseRecords(batch)
						break
					}
				}
				p.metrics.RecordProcessed(eventCount)
				p.complete(batch, outcomes, nil)
				p.releaseRecords(batch)
				break
			}

			p.metrics.RecordError()
			p.logger.Error("collector batch failed", "worker", id, "service", serviceKey(batch[0].envelope), "envelopes", len(batch), "events", eventCount, "error", err)
			if p.spool == nil {
				p.complete(batch, outcomes, err)
				break
			}
			if p.context.Err() != nil {
				p.complete(batch, nil, p.context.Err())
				p.releaseRecords(batch)
				break
			}
			if isPermanentSinkError(err) || p.retryExhausted(batch) {
				if quarantineErr := p.quarantineDurableBatch(batch, err); quarantineErr != nil {
					p.complete(batch, nil, quarantineErr)
				} else {
					p.metrics.RecordSpoolPermanent(uint64(len(batch)))
					p.complete(batch, nil, err)
				}
				p.releaseRecords(batch)
				break
			}
			if err := p.retryDurableBatch(batch); err != nil {
				p.complete(batch, nil, err)
				p.releaseRecords(batch)
				break
			}
			if !p.waitForRetry(p.retryDelay(batch)) {
				p.complete(batch, nil, p.context.Err())
				p.releaseRecords(batch)
				break
			}
		}
	}
}

func (p *Pipeline) ackDurableBatch(batch []*item) error {
	records := durableRecords(batch)
	for {
		if err := p.spool.Ack(records); err == nil {
			return nil
		} else {
			p.metrics.RecordError()
			p.logger.Error("checkpoint acknowledged spool batch", "records", len(records), "error", err)
		}
		if !p.waitForRetry(p.retry.InitialBackoff) {
			return p.context.Err()
		}
	}
}

func (p *Pipeline) retryDurableBatch(batch []*item) error {
	records := durableRecords(batch)
	if err := p.spool.MarkRetry(records); err != nil {
		return err
	}
	for index := range records {
		*batch[index].record = records[index]
	}
	p.metrics.RecordSpoolRetry(uint64(len(records)))
	return nil
}

func (p *Pipeline) quarantineDurableBatch(batch []*item, sinkErr error) error {
	reason := "attempts-exhausted"
	if isPermanentSinkError(sinkErr) {
		reason = "permanent"
	}
	for {
		if err := p.spool.Quarantine(durableRecords(batch), reason); err == nil {
			return nil
		} else {
			p.metrics.RecordError()
			p.logger.Error("quarantine permanently failed spool batch", "records", len(batch), "error", err)
		}
		if !p.waitForRetry(p.retry.InitialBackoff) {
			return p.context.Err()
		}
	}
}

func (p *Pipeline) retryExhausted(batch []*item) bool {
	for _, entry := range batch {
		if entry.record != nil && entry.record.Attempts+1 >= p.retry.MaxAttempts {
			return true
		}
	}
	return false
}

func (p *Pipeline) retryDelay(batch []*item) time.Duration {
	attempt := 1
	for _, entry := range batch {
		if entry.record != nil && entry.record.Attempts > attempt {
			attempt = entry.record.Attempts
		}
	}
	exponent := min(attempt-1, 30)
	delay := float64(p.retry.InitialBackoff) * math.Pow(2, float64(exponent))
	if delay > float64(p.retry.MaxBackoff) {
		delay = float64(p.retry.MaxBackoff)
	}
	if p.retry.Jitter > 0 {
		delay *= 1 + ((rand.Float64()*2)-1)*p.retry.Jitter
	}
	return max(time.Millisecond, time.Duration(delay))
}

func (p *Pipeline) waitForRetry(delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-p.context.Done():
		return false
	}
}

func (p *Pipeline) releaseRecords(batch []*item) {
	if p.spool == nil {
		return
	}
	p.stateMutex.Lock()
	for _, entry := range batch {
		if entry.record == nil {
			continue
		}
		delete(p.inFlight, entry.record.ID)
		delete(p.waiters, entry.record.ID)
	}
	p.stateMutex.Unlock()
	p.signalLoader()
}

func durableRecords(batch []*item) []spool.Record {
	records := make([]spool.Record, 0, len(batch))
	for _, entry := range batch {
		if entry.record != nil {
			records = append(records, *entry.record)
		}
	}
	return records
}

type permanentSinkError interface {
	Permanent() bool
}

func isPermanentSinkError(err error) bool {
	var permanent permanentSinkError
	return errors.As(err, &permanent) && permanent.Permanent()
}

func workerIndex(envelope telemetry.Envelope, workers int) int {
	serviceName := serviceKey(envelope)
	var hash uint32 = 2_166_136_261
	for index := 0; index < len(serviceName); index++ {
		hash ^= uint32(serviceName[index])
		hash *= 16_777_619
	}
	return int(hash % uint32(workers))
}

func serviceKey(envelope telemetry.Envelope) string {
	if envelope.SpanBatch != nil {
		return envelope.SpanBatch.ServiceName
	} else if envelope.RuntimeMetrics != nil {
		return envelope.RuntimeMetrics.ServiceName
	}
	return ""
}

func (p *Pipeline) complete(batch []*item, outcomes []Outcome, err error) {
	for index, entry := range batch {
		outcome := Outcome{}
		if index < len(outcomes) {
			outcome = outcomes[index]
		}
		p.metrics.ObserveProcessing(time.Since(entry.received))
		if entry.result != nil {
			entry.result <- result{outcome: outcome, error: err}
		}
	}
}

func batchEventCount(batch []*item) uint64 {
	var total uint64
	for _, entry := range batch {
		total += entry.envelope.EventCount()
	}
	return total
}

func resetTimer(timer *time.Timer, duration time.Duration) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	timer.Reset(duration)
}
