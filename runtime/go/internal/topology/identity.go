package topology

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

var invalidIdentityCharacters = regexp.MustCompile(`[^a-z0-9._/-]+`)

func NormalizeSemanticIdentity(value string) string {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(value)), ":")
	normalized := make([]string, 0, len(parts))
	for _, part := range parts {
		part = invalidIdentityCharacters.ReplaceAllString(strings.TrimSpace(part), "-")
		part = strings.Trim(part, "-")
		if part != "" {
			normalized = append(normalized, part)
		}
	}
	return strings.Join(normalized, ":")
}

func StableNodeID(kind, identity, framework string) string {
	normalizedKind := NormalizeSemanticIdentity(kind)
	normalizedIdentity := NormalizeSemanticIdentity(identity)
	if normalizedIdentity == "" {
		normalizedIdentity = "unknown"
	}
	if normalizedIdentity != normalizedKind && !strings.HasPrefix(normalizedIdentity, normalizedKind+":") {
		normalizedIdentity = normalizedKind + ":" + normalizedIdentity
	}
	normalizedFramework := NormalizeSemanticIdentity(framework)
	if normalizedFramework != "" && !strings.HasPrefix(normalizedIdentity, normalizedFramework+":") {
		normalizedIdentity = normalizedFramework + ":" + normalizedIdentity
	}
	return normalizedIdentity
}

func StableEdgeID(source, target string) string {
	return "dependency:" + source + "->" + target
}

func stablePathID(entrypoint string, nodes []string) string {
	return stableHash("path", NormalizeSemanticIdentity(entrypoint)+":"+strings.Join(nodes, ">"))
}

// JavaScript hashes UTF-16 code units, not UTF-8 bytes or Unicode code points.
// Matching that detail keeps path IDs stable even though they are not part of
// the current canonical compatibility contract.
func stableHash(prefix, value string) string {
	hash := uint32(2166136261)
	for _, codeUnit := range utf16.Encode([]rune(value)) {
		hash ^= uint32(codeUnit)
		hash *= 16777619
	}
	return prefix + ":" + strconv.FormatUint(uint64(hash), 36)
}

func round(value float64) float64 {
	return math.Floor(value*100+0.5) / 100
}

func percentile(values []float64, percentileValue float64) float64 {
	if len(values) == 0 {
		return 0
	}
	ordered := append([]float64(nil), values...)
	sortFloat64s(ordered)
	index := int(math.Ceil(percentileValue*float64(len(ordered)))) - 1
	if index < 0 {
		index = 0
	}
	return round(ordered[index])
}
