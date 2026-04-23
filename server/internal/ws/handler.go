package ws

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/Coop25/WatchParty/server/internal/protocol"
	"github.com/Coop25/WatchParty/server/internal/rooms"
)

type Handler struct {
	manager  *rooms.Manager
	upgrader websocket.Upgrader
}

type clientConn struct {
	id      string
	connID  string
	conn    *websocket.Conn
	sendMu  sync.Mutex
	roomID  string
	manager *rooms.Manager
}

func NewHandler(manager *rooms.Manager) *Handler {
	return &Handler{
		manager: manager,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(_ *http.Request) bool {
				return true
			},
		},
	}
}

func (h *Handler) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("websocket upgrade failed remote_addr=%s err=%v", r.RemoteAddr, err)
		http.Error(w, "websocket upgrade failed", http.StatusBadRequest)
		return
	}

	client := &clientConn{
		id:      newClientID(),
		connID:  newClientID(),
		conn:    conn,
		manager: h.manager,
	}
	log.Printf("websocket connected conn_id=%s remote_addr=%s", client.connID, r.RemoteAddr)
	defer func() {
		log.Printf("websocket disconnected conn_id=%s client_id=%s room_id=%s", client.connID, client.id, client.roomID)
		if client.roomID != "" {
			h.manager.RemoveClient(client.roomID, client.id, client)
		}
		_ = conn.Close()
	}()

	if err := client.write(protocol.Envelope{
		Type:     "welcome",
		ClientID: client.connID,
		SentAt:   time.Now().UnixMilli(),
	}); err != nil {
		return
	}

	for {
		var msg protocol.IncomingEnvelope
		if err := conn.ReadJSON(&msg); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("websocket read error for client %s: %v", client.id, err)
			}
			return
		}

		log.Printf("websocket message client_id=%s room_id=%s type=%s", client.id, msg.RoomID, msg.Type)
		if err := h.handleMessage(client, msg); err != nil {
			log.Printf("websocket message error client_id=%s room_id=%s type=%s err=%v", client.id, msg.RoomID, msg.Type, err)
			_ = client.write(protocol.Envelope{
				Type:     "error",
				RoomID:   client.roomID,
				ClientID: client.id,
				SentAt:   time.Now().UnixMilli(),
				Payload:  protocol.ErrorPayload{Message: err.Error()},
			})
		}
	}
}

func (h *Handler) handleMessage(client *clientConn, msg protocol.IncomingEnvelope) error {
	switch msg.Type {
	case "time_sync":
		var payload protocol.TimeSyncPayload
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			return err
		}
		return client.write(protocol.Envelope{
			Type:     "time_sync_reply",
			ClientID: client.id,
			SentAt:   time.Now().UnixMilli(),
			Payload: protocol.TimeSyncReplyPayload{
				ClientSentAt: payload.ClientSentAt,
				ServerTime:   time.Now().UnixMilli(),
			},
		})
	case "create_room":
		var payload protocol.CreateRoomPayload
		if err := json.Unmarshal(msg.Payload, &payload); err != nil && len(msg.Payload) > 0 {
			return err
		}
		if payload.ClientSessionID != "" {
			client.id = payload.ClientSessionID
		}
		room, err := h.manager.CreateRoom(client)
		if err != nil {
			return err
		}
		client.roomID = room.ID
		snapshot, err := h.manager.Snapshot(room.ID)
		if err != nil {
			return err
		}
		return client.write(protocol.Envelope{
			Type:     "room_state",
			RoomID:   room.ID,
			ClientID: client.id,
			SentAt:   time.Now().UnixMilli(),
			Payload:  snapshot,
		})
	case "join_room":
		var payload protocol.JoinRoomPayload
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			return err
		}
		if payload.ClientSessionID != "" {
			client.id = payload.ClientSessionID
		}
		room, err := h.manager.JoinRoom(payload.RoomID, client)
		if err != nil {
			return err
		}
		client.roomID = room.ID
		snapshot, err := h.manager.Snapshot(room.ID)
		if err != nil {
			return err
		}
		return client.write(protocol.Envelope{
			Type:     "room_state",
			RoomID:   room.ID,
			ClientID: client.id,
			SentAt:   time.Now().UnixMilli(),
			Payload:  snapshot,
		})
	case "client_ready":
		var payload protocol.ClientReadyPayload
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			return err
		}
		return h.manager.HandleViewerReady(client.roomID, client.id, payload)
	case "claim_remote":
		return h.manager.ClaimRemote(client.roomID, client.id)
	case "release_remote":
		return h.manager.ReleaseRemote(client.roomID, client.id)
	case "reclaim_remote":
		return h.manager.ReclaimRemote(client.roomID, client.id)
	case "set_shared_control":
		var payload protocol.SetSharedControlPayload
		if err := json.Unmarshal(msg.Payload, &payload); err != nil {
			return err
		}
		return h.manager.SetSharedControl(client.roomID, client.id, payload.Enabled)
	case "disband_room":
		roomID := client.roomID
		if roomID == "" {
			roomID = msg.RoomID
		}
		if err := h.manager.DisbandRoom(roomID, client.id); err != nil {
			return err
		}
		client.roomID = ""
		return nil
	case "media_changed", "scheduled_play", "pause", "seek", "rate_change", "heartbeat":
		_, err := h.manager.HandleControlMessage(client.roomID, client.id, msg.Type, msg.Payload)
		return err
	default:
		return nil
	}
}

func (c *clientConn) ID() string {
	return c.id
}

func (c *clientConn) Send(message protocol.Envelope) {
	message.SentAt = time.Now().UnixMilli()
	if err := c.write(message); err != nil {
		log.Printf("write error to client %s: %v", c.id, err)
	}
}

func (c *clientConn) write(message protocol.Envelope) error {
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	return c.conn.WriteJSON(message)
}

func newClientID() string {
	return time.Now().Format("20060102150405.000000000")
}
