package telemetry

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"

	nodeflowv1 "github.com/msHamed1/node-flow/services/collector/gen/nodeflow/v1"
	"google.golang.org/protobuf/proto"
)

func DecodeProtobuf(data []byte) (Envelope, error) {
	message := &nodeflowv1.TelemetryEnvelope{}
	if err := proto.Unmarshal(data, message); err != nil {
		return Envelope{}, fmt.Errorf("decode protobuf: %w", err)
	}
	envelope := Envelope{ProtocolVersion: message.GetProtocolVersion()}
	switch payload := message.Payload.(type) {
	case *nodeflowv1.TelemetryEnvelope_SpanBatch:
		envelope.SpanBatch = spanBatchFromProto(payload.SpanBatch)
	case *nodeflowv1.TelemetryEnvelope_RuntimeMetrics:
		envelope.RuntimeMetrics = runtimeFromProto(payload.RuntimeMetrics)
	case nil:
		return Envelope{}, errors.New("telemetry envelope has no payload")
	default:
		return Envelope{}, errors.New("telemetry envelope has an unknown payload")
	}
	return envelope, nil
}

func DecodeJSON(reader io.Reader, target any) error {
	decoder := json.NewDecoder(reader)
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode JSON: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("decode JSON: multiple values are not allowed")
		}
		return fmt.Errorf("decode JSON: %w", err)
	}
	return nil
}

func spanBatchFromProto(batch *nodeflowv1.SpanBatch) *SpanBatch {
	if batch == nil {
		return &SpanBatch{}
	}
	spans := make([]Span, 0, len(batch.GetSpans()))
	for _, span := range batch.GetSpans() {
		attributes := make(map[string]any, len(span.GetAttributes()))
		for key, attribute := range span.GetAttributes() {
			switch value := attribute.GetValue().(type) {
			case *nodeflowv1.AttributeValue_StringValue:
				attributes[key] = value.StringValue
			case *nodeflowv1.AttributeValue_NumberValue:
				attributes[key] = value.NumberValue
			case *nodeflowv1.AttributeValue_BoolValue:
				attributes[key] = value.BoolValue
			}
		}
		spans = append(spans, Span{
			TraceID:         span.GetTraceId(),
			SpanID:          span.GetSpanId(),
			ParentSpanID:    span.GetParentSpanId(),
			Name:            span.GetName(),
			Kind:            spanKindFromProto(span.GetKind()),
			StartTimeUnixMS: span.GetStartTimeUnixMs(),
			DurationMS:      span.GetDurationMs(),
			Status:          spanStatusFromProto(span.GetStatus()),
			Attributes:      attributes,
		})
	}
	return &SpanBatch{
		ServiceName: batch.GetServiceName(),
		NodeVersion: batch.GetNodeVersion(),
		Spans:       spans,
	}
}

func runtimeFromProto(metrics *nodeflowv1.RuntimeMetrics) *RuntimeMetrics {
	if metrics == nil {
		return &RuntimeMetrics{}
	}
	return &RuntimeMetrics{
		Timestamp:            metrics.GetTimestampUnixMs(),
		ServiceName:          metrics.GetServiceName(),
		RSSBytes:             metrics.GetRssBytes(),
		HeapUsedBytes:        metrics.GetHeapUsedBytes(),
		HeapTotalBytes:       metrics.GetHeapTotalBytes(),
		CPUPercent:           metrics.GetCpuPercent(),
		EventLoopUtilization: metrics.GetEventLoopUtilization(),
		UptimeSeconds:        metrics.GetUptimeSeconds(),
	}
}

func spanKindFromProto(kind nodeflowv1.SpanKind) string {
	return map[nodeflowv1.SpanKind]string{
		nodeflowv1.SpanKind_SPAN_KIND_HTTP_ROUTE:    "http-route",
		nodeflowv1.SpanKind_SPAN_KIND_CONTROLLER:    "controller",
		nodeflowv1.SpanKind_SPAN_KIND_SERVICE:       "service",
		nodeflowv1.SpanKind_SPAN_KIND_DATABASE:      "database",
		nodeflowv1.SpanKind_SPAN_KIND_REDIS:         "redis",
		nodeflowv1.SpanKind_SPAN_KIND_QUEUE:         "queue",
		nodeflowv1.SpanKind_SPAN_KIND_WORKER:        "worker",
		nodeflowv1.SpanKind_SPAN_KIND_EXTERNAL_HTTP: "external-http",
		nodeflowv1.SpanKind_SPAN_KIND_CUSTOM:        "custom",
		nodeflowv1.SpanKind_SPAN_KIND_INTERNAL:      "internal",
	}[kind]
}

func spanStatusFromProto(status nodeflowv1.SpanStatus) string {
	if status == nodeflowv1.SpanStatus_SPAN_STATUS_ERROR {
		return "error"
	}
	if status == nodeflowv1.SpanStatus_SPAN_STATUS_OK {
		return "ok"
	}
	return ""
}
