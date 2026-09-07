package server

import (
	"encoding/json"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/msHamed1/node-flow/services/collector/internal/topology"
)

type SnapshotHub struct {
	mutex   sync.RWMutex
	clients map[*snapshotClient]struct{}
	engine  *topology.Engine
	version string
}

type snapshotClient struct {
	connection *websocket.Conn
	messages   chan []byte
	done       chan struct{}
	closeOnce  sync.Once
}

func NewSnapshotHub(engine *topology.Engine, version string) *SnapshotHub {
	return &SnapshotHub{
		clients: make(map[*snapshotClient]struct{}), engine: engine, version: version,
	}
}

func (hub *SnapshotHub) Publish(snapshot topology.LiveSnapshot) {
	payload, err := snapshotMessage(snapshot)
	if err != nil {
		return
	}
	hub.mutex.RLock()
	defer hub.mutex.RUnlock()
	for client := range hub.clients {
		client.offer(payload)
	}
}

func (hub *SnapshotHub) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	upgrader := websocket.Upgrader{
		HandshakeTimeout: 5 * time.Second,
		CheckOrigin:      sameOrigin,
	}
	connection, err := upgrader.Upgrade(response, request, nil)
	if err != nil {
		return
	}
	client := &snapshotClient{
		connection: connection, messages: make(chan []byte, 2), done: make(chan struct{}),
	}
	hub.mutex.Lock()
	hub.clients[client] = struct{}{}
	hub.mutex.Unlock()

	connected, _ := json.Marshal(map[string]any{
		"type": "connected", "payload": map[string]string{"version": hub.version},
	})
	go client.writeLoop()
	client.offer(connected)
	initial, _ := snapshotMessage(hub.engine.LiveSnapshot())
	client.offer(initial)
	client.readLoop()
	hub.remove(client)
}

func snapshotMessage(snapshot topology.LiveSnapshot) ([]byte, error) {
	return json.Marshal(map[string]any{"type": "snapshot", "payload": snapshot})
}

func (hub *SnapshotHub) Close() {
	hub.mutex.Lock()
	clients := make([]*snapshotClient, 0, len(hub.clients))
	for client := range hub.clients {
		clients = append(clients, client)
		delete(hub.clients, client)
	}
	hub.mutex.Unlock()
	for _, client := range clients {
		client.close()
	}
}

func (hub *SnapshotHub) remove(client *snapshotClient) {
	hub.mutex.Lock()
	delete(hub.clients, client)
	hub.mutex.Unlock()
	client.close()
}

func (client *snapshotClient) offer(payload []byte) {
	select {
	case <-client.done:
		return
	default:
	}
	select {
	case client.messages <- payload:
	default:
		select {
		case <-client.messages:
		default:
		}
		select {
		case client.messages <- payload:
		case <-client.done:
		default:
		}
	}
}

func (client *snapshotClient) writeLoop() {
	for {
		select {
		case payload := <-client.messages:
			_ = client.connection.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := client.connection.WriteMessage(websocket.TextMessage, payload); err != nil {
				client.close()
				return
			}
		case <-client.done:
			return
		}
	}
}

func (client *snapshotClient) readLoop() {
	client.connection.SetReadLimit(1_024)
	for {
		if _, _, err := client.connection.ReadMessage(); err != nil {
			return
		}
	}
}

func (client *snapshotClient) close() {
	client.closeOnce.Do(func() {
		close(client.done)
		_ = client.connection.Close()
	})
}

func sameOrigin(request *http.Request) bool {
	origin := request.Header.Get("Origin")
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	return err == nil && parsed.Host == request.Host
}
