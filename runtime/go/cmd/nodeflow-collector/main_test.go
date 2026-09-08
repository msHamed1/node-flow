package main

import (
	"net"
	"testing"
)

type stubAddress string

func (address stubAddress) Network() string { return "tcp" }
func (address stubAddress) String() string  { return string(address) }

func TestRuntimeURLUsesLoopbackForWildcardListeners(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"0.0.0.0:7331": "http://127.0.0.1:7331",
		"[::]:7331":    "http://[::1]:7331",
		"127.0.0.1:0":  "http://127.0.0.1:0",
	}
	for address, expected := range tests {
		address, expected := address, expected
		t.Run(address, func(t *testing.T) {
			t.Parallel()
			actual, err := runtimeURL(stubAddress(address))
			if err != nil {
				t.Fatalf("runtimeURL returned an error: %v", err)
			}
			if actual != expected {
				t.Fatalf("runtimeURL() = %q, want %q", actual, expected)
			}
		})
	}
}

func TestRuntimeURLRejectsInvalidAddresses(t *testing.T) {
	t.Parallel()
	if _, err := runtimeURL(stubAddress("missing-port")); err == nil {
		t.Fatal("runtimeURL accepted an address without a port")
	}
}

var _ net.Addr = stubAddress("")
