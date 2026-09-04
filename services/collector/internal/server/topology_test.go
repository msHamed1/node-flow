package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/msHamed1/node-flow/services/collector/internal/topology"
)

func TestGoTopologyRESTAndDashboard(t *testing.T) {
	api, processor, _ := newTestAPI(t)
	defer stopPipeline(t, processor)
	engine := topology.New(topology.Options{ApplicationName: "payments-api", NodeVersion: "v22"})
	engine.Ingest(topologyTestSpans())
	hub := NewSnapshotHub(engine, "test")
	defer hub.Close()
	dashboard := t.TempDir()
	if err := os.WriteFile(filepath.Join(dashboard, "index.html"), []byte("<main>NodeFlow Go</main>"), 0o600); err != nil {
		t.Fatal(err)
	}
	api.topology, api.hub, api.dashboard = engine, hub, dashboard

	for _, path := range []string{"/api/snapshot", "/api/architecture"} {
		response := httptest.NewRecorder()
		api.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "database:postgresql") {
			t.Fatalf("GET %s returned %d: %s", path, response.Code, response.Body.String())
		}
	}
	response := httptest.NewRecorder()
	api.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/deep/dashboard/path", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "NodeFlow Go") {
		t.Fatalf("dashboard fallback returned %d: %s", response.Code, response.Body.String())
	}
}

func TestGoTopologyWebSocketPublishesInitialAndUpdatedSnapshots(t *testing.T) {
	api, processor, _ := newTestAPI(t)
	defer stopPipeline(t, processor)
	engine := topology.New(topology.Options{})
	hub := NewSnapshotHub(engine, "test")
	defer hub.Close()
	api.topology, api.hub = engine, hub
	server := httptest.NewServer(api.Handler())
	defer server.Close()

	connection, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	if messageType(t, connection) != "connected" || messageType(t, connection) != "snapshot" {
		t.Fatal("websocket did not publish connected and initial snapshot messages")
	}

	snapshot := engine.Ingest(topologyTestSpans())
	hub.Publish(snapshot)
	var message struct {
		Type    string                `json:"type"`
		Payload topology.LiveSnapshot `json:"payload"`
	}
	if err := connection.ReadJSON(&message); err != nil {
		t.Fatal(err)
	}
	if message.Type != "snapshot" || message.Payload.Revision != 1 || len(message.Payload.Nodes) != 2 {
		t.Fatalf("unexpected topology update: %#v", message)
	}
}

func TestTypeScriptRollbackProxiesTopologyReadsAndReportsAuthority(t *testing.T) {
	api, processor, _ := newTestAPI(t)
	defer stopPipeline(t, processor)
	proxy := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("X-Proxied-Path", request.URL.Path)
		_, _ = response.Write([]byte(`{"source":"typescript"}`))
	})
	api.topologyProxy, api.topologyAuthority = proxy, "typescript"
	for _, path := range []string{"/api/snapshot", "/api/architecture"} {
		response := httptest.NewRecorder()
		api.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK || response.Header().Get("X-Proxied-Path") != path ||
			!strings.Contains(response.Body.String(), "typescript") {
			t.Fatalf("rollback GET %s was not proxied: status=%d headers=%v body=%s", path, response.Code, response.Header(), response.Body.String())
		}
	}
	response := httptest.NewRecorder()
	api.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"topologyEngine":"typescript"`) {
		t.Fatalf("rollback health did not expose authority: %s", response.Body.String())
	}
}

func TestTopologyProxyRejectsNonHTTPURL(t *testing.T) {
	if _, err := NewTopologyProxy("file:///tmp/topology"); err == nil {
		t.Fatal("expected non-HTTP topology URL to be rejected")
	}
}

func messageType(t *testing.T, connection *websocket.Conn) string {
	t.Helper()
	_, payload, err := connection.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var message struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload, &message); err != nil {
		t.Fatal(err)
	}
	return message.Type
}

func topologyTestSpans() []topology.Span {
	return []topology.Span{
		{TraceID: "trace", SpanID: "route", Name: "GET /payments", Kind: "http-route", StartTimeUnixMS: 1, DurationMS: 10, Status: "ok"},
		{TraceID: "trace", SpanID: "database", ParentSpanID: "route", Name: "PostgreSQL", Kind: "database", StartTimeUnixMS: 2, DurationMS: 3, Status: "ok"},
	}
}
