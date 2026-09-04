package telemetry

import (
	"errors"
	"fmt"
	"math"
	"net/url"
	"strings"
)

type Limits struct {
	MaxSpans          int
	MaxAttributes     int
	MaxIdentifierSize int
	MaxNameSize       int
	MaxAttributeSize  int
}

func DefaultLimits() Limits {
	return Limits{
		MaxSpans:          2_048,
		MaxAttributes:     128,
		MaxIdentifierSize: 256,
		MaxNameSize:       512,
		MaxAttributeSize:  4_096,
	}
}

var validKinds = map[string]struct{}{
	"http-route": {}, "controller": {}, "service": {}, "database": {}, "redis": {},
	"queue": {}, "worker": {}, "external-http": {}, "custom": {}, "internal": {},
}

func ValidateAndSanitize(envelope *Envelope, limits Limits) error {
	if envelope == nil {
		return errors.New("envelope is required")
	}
	if envelope.ProtocolVersion != ProtocolVersion {
		return fmt.Errorf("unsupported protocol version %q", envelope.ProtocolVersion)
	}
	if (envelope.SpanBatch != nil) == (envelope.RuntimeMetrics != nil) {
		return errors.New("exactly one telemetry payload is required")
	}
	if envelope.SpanBatch != nil {
		return validateSpanBatch(envelope.SpanBatch, limits)
	}
	return validateRuntime(envelope.RuntimeMetrics, limits)
}

func validateSpanBatch(batch *SpanBatch, limits Limits) error {
	batch.ServiceName = strings.TrimSpace(batch.ServiceName)
	if batch.ServiceName == "" || len(batch.ServiceName) > limits.MaxIdentifierSize {
		return errors.New("serviceName is required and must fit the configured limit")
	}
	if len(batch.NodeVersion) > limits.MaxIdentifierSize {
		return errors.New("nodeVersion exceeds the configured limit")
	}
	if len(batch.Spans) == 0 || len(batch.Spans) > limits.MaxSpans {
		return fmt.Errorf("spans must contain between 1 and %d entries", limits.MaxSpans)
	}
	for index := range batch.Spans {
		if err := validateSpan(&batch.Spans[index], limits); err != nil {
			return fmt.Errorf("span %d: %w", index, err)
		}
	}
	return nil
}

func validateSpan(span *Span, limits Limits) error {
	if span.TraceID == "" || len(span.TraceID) > limits.MaxIdentifierSize {
		return errors.New("traceId is required and must fit the configured limit")
	}
	if span.SpanID == "" || len(span.SpanID) > limits.MaxIdentifierSize {
		return errors.New("spanId is required and must fit the configured limit")
	}
	if span.ParentSpanID == span.SpanID && span.ParentSpanID != "" {
		return errors.New("parentSpanId cannot equal spanId")
	}
	if len(span.ParentSpanID) > limits.MaxIdentifierSize {
		return errors.New("parentSpanId exceeds the configured limit")
	}
	if strings.TrimSpace(span.Name) == "" || len(span.Name) > limits.MaxNameSize {
		return errors.New("name is required and must fit the configured limit")
	}
	if _, exists := validKinds[span.Kind]; !exists {
		return fmt.Errorf("unsupported kind %q", span.Kind)
	}
	if span.Status != "ok" && span.Status != "error" {
		return fmt.Errorf("unsupported status %q", span.Status)
	}
	if !finiteNonNegative(span.StartTimeUnixMS) || !finiteNonNegative(span.DurationMS) {
		return errors.New("timing values must be finite and non-negative")
	}
	if len(span.Attributes) > limits.MaxAttributes {
		return fmt.Errorf("attributes exceed the limit of %d", limits.MaxAttributes)
	}
	for key, value := range span.Attributes {
		if key == "" || len(key) > limits.MaxIdentifierSize {
			return errors.New("attribute keys must be non-empty and bounded")
		}
		if sensitiveAttributeKey(key) {
			delete(span.Attributes, key)
			continue
		}
		switch typed := value.(type) {
		case string:
			if len(typed) > limits.MaxAttributeSize {
				return fmt.Errorf("attribute %q exceeds the configured size", key)
			}
			span.Attributes[key] = sanitizeURLAttribute(key, typed)
		case float64:
			if math.IsNaN(typed) || math.IsInf(typed, 0) {
				return fmt.Errorf("attribute %q is not finite", key)
			}
		case bool:
		default:
			return fmt.Errorf("attribute %q has an unsupported value", key)
		}
	}
	return nil
}

func validateRuntime(metrics *RuntimeMetrics, limits Limits) error {
	if metrics == nil {
		return errors.New("runtime metrics are required")
	}
	metrics.ServiceName = strings.TrimSpace(metrics.ServiceName)
	if metrics.ServiceName == "" || len(metrics.ServiceName) > limits.MaxIdentifierSize {
		return errors.New("serviceName is required and must fit the configured limit")
	}
	values := []float64{
		metrics.Timestamp,
		metrics.CPUPercent,
		metrics.EventLoopUtilization,
		metrics.UptimeSeconds,
	}
	for _, value := range values {
		if !finiteNonNegative(value) {
			return errors.New("runtime values must be finite and non-negative")
		}
	}
	if metrics.EventLoopUtilization > 100 {
		return errors.New("eventLoopUtilization cannot exceed 100")
	}
	return nil
}

func finiteNonNegative(value float64) bool {
	return value >= 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}

var sensitiveFragments = []string{
	"authorization", "cookie", "set_cookie", "password", "passwd", "secret", "token",
	"access_token", "refresh_token", "api_key", "client_secret", "request_body",
	"response_body", "message_body", "message_payload", "db_statement", "query_text",
	"connection_string", "dsn", "url_query",
}

func sensitiveAttributeKey(key string) bool {
	normalized := strings.NewReplacer("-", "_", ".", "_", "/", "_").Replace(strings.ToLower(key))
	for _, fragment := range sensitiveFragments {
		if normalized == fragment || strings.HasSuffix(normalized, "_"+fragment) ||
			strings.Contains(normalized, "_"+fragment+"_") {
			return true
		}
	}
	return false
}

func sanitizeURLAttribute(key, value string) string {
	normalized := strings.ToLower(key)
	if normalized != "url.full" && normalized != "http.url" {
		return value
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "[REDACTED]"
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}
