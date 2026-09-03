package telemetry

import (
	"math"
	"strings"
	"testing"

	nodeflowv1 "github.com/msHamed1/node-flow/services/collector/gen/nodeflow/v1"
	"google.golang.org/protobuf/proto"
)

func TestValidateAndSanitizeSpanBatch(t *testing.T) {
	t.Parallel()
	envelope := validEnvelope()
	envelope.SpanBatch.Spans[0].Attributes = map[string]any{
		"http.request.header.authorization": "Bearer secret",
		"http.request.header.cookie":        "session=secret",
		"user.password":                     "secret",
		"db.statement":                      "select secret",
		"http.request.body":                 `{"password":"secret"}`,
		"url.full":                          "https://user:pass@example.com/payments?token=secret#private",
		"http.route":                        "/payments",
	}

	if err := ValidateAndSanitize(&envelope, DefaultLimits()); err != nil {
		t.Fatalf("ValidateAndSanitize returned an error: %v", err)
	}
	attributes := envelope.SpanBatch.Spans[0].Attributes
	for _, key := range []string{
		"http.request.header.authorization", "http.request.header.cookie", "user.password",
		"db.statement", "http.request.body",
	} {
		if _, exists := attributes[key]; exists {
			t.Fatalf("sensitive attribute %q was retained", key)
		}
	}
	if got := attributes["url.full"]; got != "https://example.com/payments" {
		t.Fatalf("URL was not sanitized: %v", got)
	}
	if got := attributes["http.route"]; got != "/payments" {
		t.Fatalf("safe topology attribute changed: %v", got)
	}
}

func TestValidateAndSanitizeRejectsMalformedMessages(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		mutate func(*Envelope)
	}{
		{"protocol", func(envelope *Envelope) { envelope.ProtocolVersion = "2.0" }},
		{"both payloads", func(envelope *Envelope) { envelope.RuntimeMetrics = &RuntimeMetrics{} }},
		{"service", func(envelope *Envelope) { envelope.SpanBatch.ServiceName = "" }},
		{"empty spans", func(envelope *Envelope) { envelope.SpanBatch.Spans = nil }},
		{"kind", func(envelope *Envelope) { envelope.SpanBatch.Spans[0].Kind = "future" }},
		{"status", func(envelope *Envelope) { envelope.SpanBatch.Spans[0].Status = "unknown" }},
		{"self parent", func(envelope *Envelope) { envelope.SpanBatch.Spans[0].ParentSpanID = "span-1" }},
		{"nan duration", func(envelope *Envelope) { envelope.SpanBatch.Spans[0].DurationMS = math.NaN() }},
		{"attribute type", func(envelope *Envelope) {
			envelope.SpanBatch.Spans[0].Attributes = map[string]any{"bad": []string{"value"}}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			envelope := validEnvelope()
			test.mutate(&envelope)
			if err := ValidateAndSanitize(&envelope, DefaultLimits()); err == nil {
				t.Fatal("expected validation failure")
			}
		})
	}
}

func TestDecodeProtobuf(t *testing.T) {
	t.Parallel()
	message := &nodeflowv1.TelemetryEnvelope{
		ProtocolVersion: ProtocolVersion,
		Payload: &nodeflowv1.TelemetryEnvelope_SpanBatch{SpanBatch: &nodeflowv1.SpanBatch{
			ServiceName: "payments-api",
			NodeVersion: "v22",
			Spans: []*nodeflowv1.TelemetrySpan{{
				TraceId: "trace-1", SpanId: "span-1", Name: "POST /payments",
				Kind: nodeflowv1.SpanKind_SPAN_KIND_HTTP_ROUTE, Status: nodeflowv1.SpanStatus_SPAN_STATUS_OK,
				StartTimeUnixMs: 1_700_000_000_000, DurationMs: 12,
				Attributes: map[string]*nodeflowv1.AttributeValue{
					"nodeflow.sampled": {Value: &nodeflowv1.AttributeValue_BoolValue{BoolValue: true}},
				},
			}},
		}},
	}
	data, err := proto.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := DecodeProtobuf(data)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.SpanBatch.ServiceName != "payments-api" || envelope.SpanBatch.Spans[0].Kind != "http-route" {
		t.Fatalf("unexpected decoded envelope: %#v", envelope)
	}
	if envelope.SpanBatch.Spans[0].Attributes["nodeflow.sampled"] != true {
		t.Fatalf("protobuf attribute did not decode: %#v", envelope.SpanBatch.Spans[0].Attributes)
	}
}

func TestDecodeJSONRejectsMultipleValues(t *testing.T) {
	t.Parallel()
	var batch SpanBatch
	if err := DecodeJSON(strings.NewReader(`{} {}`), &batch); err == nil {
		t.Fatal("expected multiple JSON values to be rejected")
	}
}

func validEnvelope() Envelope {
	return Envelope{
		ProtocolVersion: ProtocolVersion,
		SpanBatch: &SpanBatch{
			ServiceName: "payments-api",
			NodeVersion: "v22",
			Spans: []Span{{
				TraceID: "trace-1", SpanID: "span-1", Name: "POST /payments", Kind: "http-route",
				StartTimeUnixMS: 1_700_000_000_000, DurationMS: 12, Status: "ok",
			}},
		},
	}
}
