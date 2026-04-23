package rooms

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"sync"
	"time"

	"github.com/Coop25/WatchParty/server/internal/protocol"
)

const (
	scheduledPlayLead   = 1000 * time.Millisecond
	readyResumePlayLead = 3000 * time.Millisecond
	seekResumeLead      = 600 * time.Millisecond
	mediaWaitLead       = 15000 * time.Millisecond
	readyGraceLead      = 5000 * time.Millisecond
	hostReconnectGrace  = 30 * time.Second
	roomInactivityTTL   = 1 * time.Hour
	roomCleanupInterval = 1 * time.Minute
	roomCodeLength      = 6
)

type Client interface {
	ID() string
	Send(protocol.Envelope)
}

type Manager struct {
	mu    sync.RWMutex
	rooms map[string]*Room
}

type Room struct {
	ID                       string
	HostClientID             string
	RemoteHolderClientID     string
	SharedControlEnabled     bool
	Media                    protocol.MediaState
	BasePositionSeconds      float64
	PlaybackRate             float64
	Playing                  bool
	ScheduledStartAtMS       int64
	LastUpdatedAtMS          int64
	AutoPlayOnReady          bool
	Clients                  map[string]Client
	WaitingForReady          bool
	WaitDeadlineMS           int64
	ResumePosition           float64
	ResumePlaybackRate       float64
	ReadyViewerIDs           map[string]bool
	ReadyGraceArmed          bool
	HostDisconnectDeadlineMS int64
	LastActivityAtMS         int64
}

func NewManager() *Manager {
	manager := &Manager{rooms: make(map[string]*Room)}
	go manager.expireInactiveRoomsLoop()
	return manager
}

func (m *Manager) CreateRoom(host Client) (*Room, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	for i := 0; i < 5; i++ {
		roomID, err := randomRoomCode(roomCodeLength)
		if err != nil {
			return nil, err
		}
		if _, exists := m.rooms[roomID]; exists {
			continue
		}

		now := nowMS()
		room := &Room{
			ID:                   roomID,
			HostClientID:         host.ID(),
			RemoteHolderClientID: host.ID(),
			PlaybackRate:         1,
			LastUpdatedAtMS:      now,
			LastActivityAtMS:     now,
			AutoPlayOnReady:      true,
			Clients:              map[string]Client{host.ID(): host},
			ReadyViewerIDs:       make(map[string]bool),
			ScheduledStartAtMS:   0,
		}
		m.rooms[roomID] = room
		log.Printf("room created room_id=%s host_client_id=%s", roomID, host.ID())
		return cloneRoom(room), nil
	}

	return nil, fmt.Errorf("failed to allocate room id")
}

func (m *Manager) JoinRoom(roomID string, client Client) (*Room, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	room, ok := m.rooms[roomID]
	if !ok {
		return nil, fmt.Errorf("room not found")
	}

	room.Clients[client.ID()] = client
	m.touchRoomLocked(room, nowMS())
	if room.HostClientID == client.ID() {
		room.HostDisconnectDeadlineMS = 0
		room.RemoteHolderClientID = client.ID()
	}
	log.Printf("room joined room_id=%s client_id=%s clients=%d", roomID, client.ID(), len(room.Clients))
	return cloneRoom(room), nil
}

func (m *Manager) RemoveClient(roomID, clientID string, client Client) {
	m.mu.Lock()
	defer m.mu.Unlock()

	room, ok := m.rooms[roomID]
	if !ok {
		return
	}

	currentClient, exists := room.Clients[clientID]
	if !exists || currentClient != client {
		return
	}

	delete(room.Clients, clientID)
	if len(room.Clients) == 0 {
		log.Printf("room deleted room_id=%s reason=empty", roomID)
		delete(m.rooms, roomID)
		return
	}

	m.touchRoomLocked(room, nowMS())

	if room.HostClientID == clientID {
		room.HostDisconnectDeadlineMS = nowMS() + hostReconnectGrace.Milliseconds()
		log.Printf("host disconnected room_id=%s host_client_id=%s reconnect_deadline_ms=%d", roomID, clientID, room.HostDisconnectDeadlineMS)
		go m.expireHostReconnectGrace(room.ID, clientID, room.HostDisconnectDeadlineMS)
	} else if room.RemoteHolderClientID == clientID {
		room.RemoteHolderClientID = room.HostClientID
		log.Printf("remote reassigned room_id=%s previous_holder=%s new_holder=%s", roomID, clientID, room.RemoteHolderClientID)
	}

	log.Printf("client removed room_id=%s client_id=%s clients=%d", roomID, clientID, len(room.Clients))
	m.broadcastLocked(room, protocol.Envelope{
		Type:    "room_state",
		RoomID:  room.ID,
		Payload: room.snapshotLocked(nowMS()),
	})
}

func (m *Manager) DisbandRoom(roomID, clientID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	room, ok := m.rooms[roomID]
	if !ok {
		return fmt.Errorf("room not found")
	}
	if room.HostClientID != clientID {
		return fmt.Errorf("only the host can disband the room")
	}

	log.Printf("room disbanded room_id=%s host_client_id=%s", roomID, clientID)
	for _, client := range room.Clients {
		client.Send(protocol.Envelope{
			Type:   "room_closed",
			RoomID: room.ID,
			Payload: protocol.RoomClosedPayload{
				Reason: "host_disbanded",
			},
		})
	}

	delete(m.rooms, roomID)
	return nil
}

func (m *Manager) expireHostReconnectGrace(roomID, hostClientID string, deadlineMS int64) {
	timer := time.NewTimer(time.Until(time.UnixMilli(deadlineMS)))
	defer timer.Stop()
	<-timer.C

	m.mu.Lock()
	defer m.mu.Unlock()

	room, ok := m.rooms[roomID]
	if !ok || room.HostClientID != hostClientID || room.HostDisconnectDeadlineMS != deadlineMS {
		return
	}
	if _, stillConnected := room.Clients[hostClientID]; stillConnected {
		room.HostDisconnectDeadlineMS = 0
		return
	}

	for nextID := range room.Clients {
		room.HostClientID = nextID
		if room.RemoteHolderClientID == "" || room.RemoteHolderClientID == hostClientID {
			room.RemoteHolderClientID = nextID
		}
		room.HostDisconnectDeadlineMS = 0
		log.Printf("host reassigned room_id=%s old_host=%s new_host=%s", roomID, hostClientID, nextID)
		break
	}

	m.broadcastLocked(room, protocol.Envelope{
		Type:    "room_state",
		RoomID:  room.ID,
		Payload: room.snapshotLocked(nowMS()),
	})
}

func (m *Manager) ClaimRemote(roomID, clientID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	room, ok := m.rooms[roomID]
	if !ok {
		return fmt.Errorf("room not found")
	}
	if clientID == room.HostClientID {
		return fmt.Errorf("host already manages the remote directly")
	}
	if room.RemoteHolderClientID != "" {
		return fmt.Errorf("remote is already in use")
	}

	room.RemoteHolderClientID = clientID
	m.touchRoomLocked(room, nowMS())
	log.Printf("remote claimed room_id=%s client_id=%s", roomID, clientID)
	m.broadcastLocked(room, protocol.Envelope{
		Type:    "room_state",
		RoomID:  room.ID,
		Payload: room.snapshotLocked(nowMS()),
	})
	return nil
}

func (m *Manager) ReleaseRemote(roomID, clientID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	room, ok := m.rooms[roomID]
	if !ok {
		return fmt.Errorf("room not found")
	}
	if room.RemoteHolderClientID != clientID {
		return fmt.Errorf("only the current remote holder can put it down")
	}

	room.RemoteHolderClientID = ""
	m.touchRoomLocked(room, nowMS())
	log.Printf("remote released room_id=%s client_id=%s", roomID, clientID)
	m.broadcastLocked(room, protocol.Envelope{
		Type:    "room_state",
		RoomID:  room.ID,
		Payload: room.snapshotLocked(nowMS()),
	})
	return nil
}

func (m *Manager) ReclaimRemote(roomID, clientID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	room, ok := m.rooms[roomID]
	if !ok {
		return fmt.Errorf("room not found")
	}
	if room.HostClientID != clientID {
		return fmt.Errorf("only the host can take the remote back")
	}

	room.RemoteHolderClientID = clientID
	m.touchRoomLocked(room, nowMS())
	log.Printf("remote reclaimed room_id=%s host_client_id=%s", roomID, clientID)
	m.broadcastLocked(room, protocol.Envelope{
		Type:    "room_state",
		RoomID:  room.ID,
		Payload: room.snapshotLocked(nowMS()),
	})
	return nil
}

func (m *Manager) SetSharedControl(roomID, clientID string, enabled bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	room, ok := m.rooms[roomID]
	if !ok {
		return fmt.Errorf("room not found")
	}
	if room.HostClientID != clientID {
		return fmt.Errorf("only the host can change shared control")
	}

	room.SharedControlEnabled = enabled
	if enabled {
		room.RemoteHolderClientID = room.HostClientID
	}
	m.touchRoomLocked(room, nowMS())
	log.Printf("shared control updated room_id=%s host_client_id=%s enabled=%t", roomID, clientID, enabled)
	m.broadcastLocked(room, protocol.Envelope{
		Type:    "room_state",
		RoomID:  room.ID,
		Payload: room.snapshotLocked(nowMS()),
	})
	return nil
}

func (m *Manager) HandleControlMessage(roomID, clientID string, msgType string, payload json.RawMessage) ([]protocol.Envelope, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	room, ok := m.rooms[roomID]
	if !ok {
		return nil, fmt.Errorf("room not found")
	}
	if !room.SharedControlEnabled && room.RemoteHolderClientID != clientID {
		return nil, fmt.Errorf("only the current remote holder can control playback")
	}

	now := nowMS()
	switch msgType {
	case "media_changed":
		var incoming protocol.MediaChangedPayload
		if err := json.Unmarshal(payload, &incoming); err != nil {
			return nil, err
		}
		room.Media = incoming.Media
		room.BasePositionSeconds = incoming.PositionSeconds
		room.PlaybackRate = normalizeRate(incoming.PlaybackRate)
		room.AutoPlayOnReady = incoming.AutoPlayOnReady
		room.Playing = false
		room.ScheduledStartAtMS = 0
		room.LastUpdatedAtMS = now
		room.ReadyViewerIDs = make(map[string]bool)
		room.ReadyGraceArmed = false
		room.ResumePosition = incoming.PositionSeconds
		room.ResumePlaybackRate = room.PlaybackRate
		room.WaitDeadlineMS = 0
		m.touchRoomLocked(room, now)
		if room.AutoPlayOnReady && len(room.Clients) > 1 {
			room.WaitingForReady = true
			room.WaitDeadlineMS = now + mediaWaitLead.Milliseconds()
			go m.resumeAfterDeadline(room.ID, room.WaitDeadlineMS)
		} else {
			room.WaitingForReady = false
		}
		log.Printf("room event room_id=%s host_client_id=%s type=media_changed media_key=%s playing=%t position=%.3f rate=%.3f auto_play_on_ready=%t waiting=%t", room.ID, clientID, room.Media.MediaKey, room.Playing, room.BasePositionSeconds, room.PlaybackRate, room.AutoPlayOnReady, room.WaitingForReady)
		m.broadcastLocked(room, protocol.Envelope{
			Type:   "media_changed",
			RoomID: room.ID,
			Payload: protocol.MediaChangedPayload{
				Media:           room.Media,
				PositionSeconds: room.BasePositionSeconds,
				PlaybackRate:    room.PlaybackRate,
				Playing:         room.Playing,
				AutoPlayOnReady: room.AutoPlayOnReady,
			},
		})
		m.broadcastLocked(room, protocol.Envelope{
			Type:   "pause",
			RoomID: room.ID,
			Payload: protocol.PausePayload{
				PositionSeconds: room.BasePositionSeconds,
				Media:           room.Media,
			},
		})
		state := room.snapshotLocked(now)
		return m.broadcastLocked(room, protocol.Envelope{
			Type:    "room_state",
			RoomID:  room.ID,
			Payload: state,
		}), nil
	case "scheduled_play":
		var incoming protocol.ScheduledPlayPayload
		if err := json.Unmarshal(payload, &incoming); err != nil {
			return nil, err
		}
		if incoming.Media.MediaKey != "" {
			room.Media = incoming.Media
		}
		room.BasePositionSeconds = incoming.TargetTimeSeconds
		room.PlaybackRate = normalizeRate(incoming.PlaybackRate)
		room.Playing = true
		room.ScheduledStartAtMS = now + scheduledPlayLead.Milliseconds()
		room.LastUpdatedAtMS = room.ScheduledStartAtMS
		room.WaitingForReady = false
		room.WaitDeadlineMS = 0
		room.ReadyGraceArmed = false
		room.ReadyViewerIDs = make(map[string]bool)
		m.touchRoomLocked(room, now)
		log.Printf("room event room_id=%s host_client_id=%s type=scheduled_play media_key=%s position=%.3f rate=%.3f start_at_ms=%d", room.ID, clientID, room.Media.MediaKey, room.BasePositionSeconds, room.PlaybackRate, room.ScheduledStartAtMS)
		reply := protocol.ScheduledPlayPayload{
			TargetTimeSeconds: room.BasePositionSeconds,
			PlaybackRate:      room.PlaybackRate,
			StartAtServerTime: room.ScheduledStartAtMS,
			Media:             room.Media,
		}
		return m.broadcastLocked(room, protocol.Envelope{Type: "scheduled_play", RoomID: room.ID, Payload: reply}), nil
	case "pause":
		var incoming protocol.PausePayload
		if err := json.Unmarshal(payload, &incoming); err != nil {
			return nil, err
		}
		if incoming.Media.MediaKey != "" {
			room.Media = incoming.Media
		}
		room.BasePositionSeconds = incoming.PositionSeconds
		room.Playing = false
		room.ScheduledStartAtMS = 0
		room.LastUpdatedAtMS = now
		room.WaitingForReady = false
		room.WaitDeadlineMS = 0
		room.ReadyGraceArmed = false
		m.touchRoomLocked(room, now)
		log.Printf("room event room_id=%s host_client_id=%s type=pause media_key=%s position=%.3f", room.ID, clientID, room.Media.MediaKey, room.BasePositionSeconds)
		return m.broadcastLocked(room, protocol.Envelope{
			Type:   "pause",
			RoomID: room.ID,
			Payload: protocol.PausePayload{
				PositionSeconds: room.BasePositionSeconds,
				Media:           room.Media,
			},
		}), nil
	case "seek":
		var incoming protocol.SeekPayload
		if err := json.Unmarshal(payload, &incoming); err != nil {
			return nil, err
		}
		if incoming.Media.MediaKey != "" {
			room.Media = incoming.Media
		}
		room.BasePositionSeconds = incoming.TargetTimeSeconds
		room.PlaybackRate = normalizeRate(incoming.PlaybackRate)
		room.Playing = incoming.ResumeAfterSeek
		room.WaitingForReady = false
		room.WaitDeadlineMS = 0
		room.ReadyGraceArmed = false
		if incoming.ResumeAfterSeek {
			room.ScheduledStartAtMS = now + seekResumeLead.Milliseconds()
			room.LastUpdatedAtMS = room.ScheduledStartAtMS
		} else {
			room.ScheduledStartAtMS = 0
			room.LastUpdatedAtMS = now
		}
		m.touchRoomLocked(room, now)
		log.Printf("room event room_id=%s host_client_id=%s type=seek media_key=%s position=%.3f rate=%.3f resume=%t start_at_ms=%d", room.ID, clientID, room.Media.MediaKey, room.BasePositionSeconds, room.PlaybackRate, room.Playing, room.ScheduledStartAtMS)
		return m.broadcastLocked(room, protocol.Envelope{
			Type:   "seek",
			RoomID: room.ID,
			Payload: protocol.SeekPayload{
				TargetTimeSeconds: room.BasePositionSeconds,
				ResumeAfterSeek:   room.Playing,
				PlaybackRate:      room.PlaybackRate,
				StartAtServerTime: room.ScheduledStartAtMS,
				Media:             room.Media,
			},
		}), nil
	case "rate_change":
		var incoming protocol.RateChangePayload
		if err := json.Unmarshal(payload, &incoming); err != nil {
			return nil, err
		}
		if incoming.Media.MediaKey != "" {
			room.Media = incoming.Media
		}
		room.BasePositionSeconds = incoming.PositionSeconds
		room.PlaybackRate = normalizeRate(incoming.PlaybackRate)
		room.LastUpdatedAtMS = now
		room.ScheduledStartAtMS = 0
		room.WaitingForReady = false
		room.WaitDeadlineMS = 0
		room.ReadyGraceArmed = false
		m.touchRoomLocked(room, now)
		log.Printf("room event room_id=%s host_client_id=%s type=rate_change media_key=%s position=%.3f rate=%.3f", room.ID, clientID, room.Media.MediaKey, room.BasePositionSeconds, room.PlaybackRate)
		return m.broadcastLocked(room, protocol.Envelope{
			Type:   "rate_change",
			RoomID: room.ID,
			Payload: protocol.RateChangePayload{
				PlaybackRate:    room.PlaybackRate,
				PositionSeconds: room.BasePositionSeconds,
				Media:           room.Media,
			},
		}), nil
	case "heartbeat":
		var incoming protocol.HeartbeatPayload
		if err := json.Unmarshal(payload, &incoming); err != nil {
			return nil, err
		}
		if incoming.Media.MediaKey != "" {
			room.Media = incoming.Media
		}
		room.BasePositionSeconds = incoming.PositionSeconds
		room.PlaybackRate = normalizeRate(incoming.PlaybackRate)
		room.Playing = incoming.Playing
		room.LastUpdatedAtMS = now
		room.ScheduledStartAtMS = 0
		room.WaitingForReady = false
		room.WaitDeadlineMS = 0
		room.ReadyGraceArmed = false
		if incoming.Playing {
			m.touchRoomLocked(room, now)
		}
		log.Printf("room event room_id=%s host_client_id=%s type=heartbeat media_key=%s position=%.3f rate=%.3f playing=%t", room.ID, clientID, room.Media.MediaKey, room.BasePositionSeconds, room.PlaybackRate, room.Playing)
		return m.broadcastLocked(room, protocol.Envelope{
			Type:    "room_state",
			RoomID:  room.ID,
			Payload: room.snapshotLocked(now),
		}), nil
	default:
		return nil, fmt.Errorf("unsupported message type %q", msgType)
	}
}

func (m *Manager) HandleViewerReady(roomID, clientID string, payload protocol.ClientReadyPayload) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	room, ok := m.rooms[roomID]
	if !ok {
		return fmt.Errorf("room not found")
	}
	if clientID == room.HostClientID {
		return nil
	}
	if !room.WaitingForReady {
		return nil
	}
	if !payload.HasVideo || !payload.IsBufferedReady || payload.MediaKey == "" || payload.MediaKey != room.Media.MediaKey {
		return nil
	}

	room.ReadyViewerIDs[clientID] = true
	m.touchRoomLocked(room, nowMS())
	log.Printf("room viewer ready room_id=%s client_id=%s ready=%d awaited=%d", roomID, clientID, len(room.ReadyViewerIDs), max(0, len(room.Clients)-1))
	state := room.snapshotLocked(nowMS())
	m.broadcastLocked(room, protocol.Envelope{
		Type:    "room_state",
		RoomID:  room.ID,
		Payload: state,
	})

	if len(room.ReadyViewerIDs) >= max(0, len(room.Clients)-1) {
		now := nowMS()
		if !room.ReadyGraceArmed {
			room.ReadyGraceArmed = true
			room.WaitDeadlineMS = now + readyGraceLead.Milliseconds()
			log.Printf("room ready grace room_id=%s deadline_ms=%d", roomID, room.WaitDeadlineMS)
			state := room.snapshotLocked(now)
			m.broadcastLocked(room, protocol.Envelope{
				Type:    "room_state",
				RoomID:  room.ID,
				Payload: state,
			})
			go m.resumeAfterDeadline(room.ID, room.WaitDeadlineMS)
		}
		return nil
	}

	return nil
}

func (m *Manager) Snapshot(roomID string) (*protocol.RoomStatePayload, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	room, ok := m.rooms[roomID]
	if !ok {
		return nil, fmt.Errorf("room not found")
	}

	state := room.snapshotLocked(nowMS())
	return &state, nil
}

func (m *Manager) resumeAfterDeadline(roomID string, deadlineMS int64) {
	timer := time.NewTimer(time.Until(time.UnixMilli(deadlineMS)))
	defer timer.Stop()
	<-timer.C

	m.mu.Lock()
	defer m.mu.Unlock()

	room, ok := m.rooms[roomID]
	if !ok || !room.WaitingForReady || room.WaitDeadlineMS != deadlineMS {
		return
	}

	_ = m.resumeWaitingLocked(room, nowMS())
}

func (m *Manager) broadcastLocked(room *Room, envelope protocol.Envelope) []protocol.Envelope {
	for _, client := range room.Clients {
		client.Send(envelope)
	}
	return []protocol.Envelope{envelope}
}

func (m *Manager) resumeWaitingLocked(room *Room, now int64) error {
	if !room.WaitingForReady {
		return nil
	}

	room.WaitingForReady = false
	room.ReadyGraceArmed = false
	room.WaitDeadlineMS = 0
	room.Playing = true
	room.BasePositionSeconds = room.ResumePosition
	room.PlaybackRate = normalizeRate(room.ResumePlaybackRate)
	room.ScheduledStartAtMS = now + readyResumePlayLead.Milliseconds()
	room.LastUpdatedAtMS = room.ScheduledStartAtMS
	room.ReadyViewerIDs = make(map[string]bool)
	m.touchRoomLocked(room, now)

	log.Printf("room ready resume room_id=%s start_at_ms=%d position=%.3f rate=%.3f", room.ID, room.ScheduledStartAtMS, room.BasePositionSeconds, room.PlaybackRate)
	m.broadcastLocked(room, protocol.Envelope{
		Type:   "scheduled_play",
		RoomID: room.ID,
		Payload: protocol.ScheduledPlayPayload{
			TargetTimeSeconds: room.BasePositionSeconds,
			PlaybackRate:      room.PlaybackRate,
			StartAtServerTime: room.ScheduledStartAtMS,
			Media:             room.Media,
		},
	})
	m.broadcastLocked(room, protocol.Envelope{
		Type:    "room_state",
		RoomID:  room.ID,
		Payload: room.snapshotLocked(now),
	})

	return nil
}

func (m *Manager) expireInactiveRoomsLoop() {
	ticker := time.NewTicker(roomCleanupInterval)
	defer ticker.Stop()

	for range ticker.C {
		m.expireInactiveRooms()
	}
}

func (m *Manager) expireInactiveRooms() {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := nowMS()
	for roomID, room := range m.rooms {
		if !m.roomInactiveLocked(room, now) {
			continue
		}
		log.Printf("room expired room_id=%s reason=inactivity last_activity_at_ms=%d", roomID, room.LastActivityAtMS)
		m.closeRoomLocked(roomID, room, "inactive_timeout")
	}
}

func (m *Manager) closeRoomLocked(roomID string, room *Room, reason string) {
	for _, client := range room.Clients {
		client.Send(protocol.Envelope{
			Type:   "room_closed",
			RoomID: room.ID,
			Payload: protocol.RoomClosedPayload{
				Reason: reason,
			},
		})
	}
	delete(m.rooms, roomID)
}

func (m *Manager) touchRoomLocked(room *Room, now int64) {
	room.LastActivityAtMS = now
}

func (m *Manager) roomInactiveLocked(room *Room, now int64) bool {
	if room.LastActivityAtMS <= 0 {
		return false
	}
	return now-room.LastActivityAtMS >= roomInactivityTTL.Milliseconds()
}

func (r *Room) snapshotLocked(now int64) protocol.RoomStatePayload {
	position := r.positionAtLocked(now)

	return protocol.RoomStatePayload{
		RoomID:               r.ID,
		HostClientID:         r.HostClientID,
		RemoteHolderClientID: r.RemoteHolderClientID,
		SharedControlEnabled: r.SharedControlEnabled,
		ViewerCount:          max(0, len(r.Clients)-1),
		Media:                r.Media,
		ReferenceServerMS:    now,
		Playback: protocol.PlaybackState{
			Playing:            r.Playing,
			PositionSeconds:    position,
			PlaybackRate:       r.PlaybackRate,
			ScheduledStartAtMS: r.ScheduledStartAtMS,
			LastUpdatedAtMS:    r.LastUpdatedAtMS,
			AutoPlayOnReady:    r.AutoPlayOnReady,
			WaitingForReady:    r.WaitingForReady,
			WaitDeadlineMS:     r.WaitDeadlineMS,
			ReadyViewerCount:   len(r.ReadyViewerIDs),
			AwaitedViewerCount: max(0, len(r.Clients)-1),
		},
	}
}

func (r *Room) positionAtLocked(now int64) float64 {
	position := r.BasePositionSeconds
	if !r.Playing {
		return position
	}

	if r.ScheduledStartAtMS > 0 && now < r.ScheduledStartAtMS {
		return position
	}

	effectiveStart := r.LastUpdatedAtMS
	if effectiveStart == 0 {
		effectiveStart = now
	}
	if r.ScheduledStartAtMS > effectiveStart {
		effectiveStart = r.ScheduledStartAtMS
	}
	if now <= effectiveStart {
		return position
	}

	elapsedSeconds := float64(now-effectiveStart) / 1000
	return position + elapsedSeconds*r.PlaybackRate
}

func cloneRoom(room *Room) *Room {
	copyRoom := *room
	copyRoom.Clients = make(map[string]Client, len(room.Clients))
	for id, client := range room.Clients {
		copyRoom.Clients[id] = client
	}
	return &copyRoom
}

func randomRoomCode(length int) (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	buf := make([]byte, length)
	seed := make([]byte, length)
	if _, err := rand.Read(seed); err != nil {
		return "", err
	}
	for i := range buf {
		buf[i] = alphabet[int(seed[i])%len(alphabet)]
	}
	return string(buf), nil
}

func normalizeRate(rate float64) float64 {
	if rate <= 0 || math.IsNaN(rate) || math.IsInf(rate, 0) {
		return 1
	}
	return rate
}

func nowMS() int64 {
	return time.Now().UnixMilli()
}
