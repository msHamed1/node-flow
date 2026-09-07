package pipeline

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	collectormetrics "github.com/msHamed1/node-flow/services/collector/internal/metrics"
	"github.com/msHamed1/node-flow/services/collector/internal/telemetry"
)

var (
	ErrQueueFull = errors.New("collector queue is full")
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
}

type Pipeline struct {
	config     Config
	sink       Sink
	metrics    *collectormetrics.Collector
	logger     *slog.Logger
	queue      chan *item
	jobs       []chan []*item
	context    context.Context
	cancel     context.CancelFunc
	mutex      sync.RWMutex
	accepting  bool
	closeOnce  sync.Once
	workers    sync.WaitGroup
	dispatcher sync.WaitGroup
	done       chan struct{}
}

type item struct {
	envelope telemetry.Envelope
	received time.Time
	result   chan result
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
	ctx, cancel := context.WithCancel(context.Background())
	pipeline := &Pipeline{
		config:    config,
		sink:      sink,
		metrics:   metrics,
		logger:    logger,
		queue:     make(chan *item, config.QueueSize),
		jobs:      make([]chan []*item, config.Workers),
		context:   ctx,
		cancel:    cancel,
		accepting: true,
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

// Enqueue admits an envelope to bounded memory without waiting for the sink.
// The HTTP boundary uses this method so a slow topology sink cannot starve the
// upstream OpenTelemetry export queue. Processing failures remain observable
// through metrics and structured logs after admission.
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
		close(p.queue)
		p.mutex.Unlock()
	})
}

func (p *Pipeline) Wait(ctx context.Context) error {
	select {
	case <-p.done:
		return p.sink.Close()
	case <-ctx.Done():
		p.cancel()
		select {
		case <-p.done:
		case <-time.After(time.Second):
		}
		return fmt.Errorf("drain collector pipeline: %w", ctx.Err())
	}
}

func (p *Pipeline) Ready(ctx context.Context) error {
	p.mutex.RLock()
	accepting := p.accepting
	p.mutex.RUnlock()
	if !accepting {
		return ErrClosed
	}
	return p.sink.Ready(ctx)
}

func (p *Pipeline) start() {
	p.dispatcher.Add(1)
	go p.dispatch()
	for worker := 0; worker < p.config.Workers; worker++ {
		p.workers.Add(1)
		go p.work(worker+1, p.jobs[worker])
	}
	go func() {
		p.dispatcher.Wait()
		p.workers.Wait()
		close(p.done)
	}()
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
		workerBatches := make([][]*item, len(p.jobs))
		for _, entry := range batch {
			worker := workerIndex(entry.envelope, len(p.jobs))
			workerBatches[worker] = append(workerBatches[worker], entry)
		}
		for worker, workerBatch := range workerBatches {
			if len(workerBatch) == 0 {
				continue
			}
			select {
			case p.jobs[worker] <- workerBatch:
			case <-p.context.Done():
				p.complete(workerBatch, nil, p.context.Err())
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
			for entry := range p.queue {
				p.complete([]*item{entry}, nil, p.context.Err())
			}
			return
		}
	}
}

func (p *Pipeline) work(id int, jobs <-chan []*item) {
	defer p.workers.Done()
	for batch := range jobs {
		p.metrics.WorkerStarted()
		eventCount := batchEventCount(batch)
		p.metrics.ObserveBatchSize(eventCount)
		envelopes := make([]telemetry.Envelope, len(batch))
		for index, entry := range batch {
			envelopes[index] = entry.envelope
		}
		outcomes, err := p.sink.ConsumeBatch(p.context, envelopes)
		p.metrics.WorkerStopped()
		if err != nil {
			p.metrics.RecordError()
			p.logger.Error("collector batch failed", "worker", id, "envelopes", len(batch), "events", eventCount, "error", err)
		} else {
			p.metrics.RecordProcessed(eventCount)
		}
		p.complete(batch, outcomes, err)
	}
}

func workerIndex(envelope telemetry.Envelope, workers int) int {
	serviceName := ""
	if envelope.SpanBatch != nil {
		serviceName = envelope.SpanBatch.ServiceName
	} else if envelope.RuntimeMetrics != nil {
		serviceName = envelope.RuntimeMetrics.ServiceName
	}
	var hash uint32 = 2_166_136_261
	for index := 0; index < len(serviceName); index++ {
		hash ^= uint32(serviceName[index])
		hash *= 16_777_619
	}
	return int(hash % uint32(workers))
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
