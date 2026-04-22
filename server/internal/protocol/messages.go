package protocol

import "encoding/json"

type Envelope struct {
	Type      string      `json:"type"`
	RoomID    string      `json:"roomId,omitempty"`
	ClientID  string      `json:"clientId,omitempty"`
	MessageID string      `json:"messageId,omitempty"`
	SentAt    int64       `json:"sentAt,omitempty"`
	Payload   interface{} `json:"payload,omitempty"`
}

type IncomingEnvelope struct {
	Type      string          `json:"type"`
	RoomID    string          `json:"roomId,omitempty"`
	ClientID  string          `json:"clientId,omitempty"`
	MessageID string          `json:"messageId,omitempty"`
	SentAt    int64           `json:"sentAt,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type ErrorPayload struct {
	Message string `json:"message"`
}

type RoomClosedPayload struct {
	Reason string `json:"reason"`
}

type CreateRoomPayload struct{}

type JoinRoomPayload struct {
	RoomID string `json:"roomId"`
}

type DisbandRoomPayload struct{}
type ClaimRemotePayload struct{}
type ReleaseRemotePayload struct{}
type ReclaimRemotePayload struct{}

type TimeSyncPayload struct {
	ClientSentAt int64 `json:"clientSentAt"`
}

type TimeSyncReplyPayload struct {
	ClientSentAt int64 `json:"clientSentAt"`
	ServerTime   int64 `json:"serverTime"`
}

type MediaState struct {
	PageURL    string  `json:"pageUrl"`
	PageTitle  string  `json:"pageTitle"`
	CurrentSrc string  `json:"currentSrc"`
	Duration   float64 `json:"duration"`
	MediaKey   string  `json:"mediaKey"`
}

type PlaybackState struct {
	Playing            bool    `json:"playing"`
	PositionSeconds    float64 `json:"positionSeconds"`
	PlaybackRate       float64 `json:"playbackRate"`
	ScheduledStartAtMS int64   `json:"scheduledStartAtMs"`
	LastUpdatedAtMS    int64   `json:"lastUpdatedAtMs"`
	AutoPlayOnReady    bool    `json:"autoPlayOnReady"`
	WaitingForReady    bool    `json:"waitingForReady"`
	WaitDeadlineMS     int64   `json:"waitDeadlineMs"`
	ReadyViewerCount   int     `json:"readyViewerCount"`
	AwaitedViewerCount int     `json:"awaitedViewerCount"`
}

type RoomStatePayload struct {
	RoomID               string        `json:"roomId"`
	HostClientID         string        `json:"hostClientId"`
	RemoteHolderClientID string        `json:"remoteHolderClientId"`
	ViewerCount          int           `json:"viewerCount"`
	Media                MediaState    `json:"media"`
	Playback             PlaybackState `json:"playback"`
	ReferenceServerMS    int64         `json:"referenceServerMs"`
}

type ScheduledPlayPayload struct {
	TargetTimeSeconds float64    `json:"targetTimeSeconds"`
	PlaybackRate      float64    `json:"playbackRate"`
	StartAtServerTime int64      `json:"startAtServerTime"`
	Media             MediaState `json:"media"`
}

type PausePayload struct {
	PositionSeconds float64    `json:"positionSeconds"`
	Media           MediaState `json:"media"`
}

type SeekPayload struct {
	TargetTimeSeconds float64    `json:"targetTimeSeconds"`
	ResumeAfterSeek   bool       `json:"resumeAfterSeek"`
	PlaybackRate      float64    `json:"playbackRate"`
	StartAtServerTime int64      `json:"startAtServerTime,omitempty"`
	Media             MediaState `json:"media"`
}

type RateChangePayload struct {
	PlaybackRate    float64    `json:"playbackRate"`
	PositionSeconds float64    `json:"positionSeconds"`
	Media           MediaState `json:"media"`
}

type MediaChangedPayload struct {
	Media           MediaState `json:"media"`
	PositionSeconds float64    `json:"positionSeconds"`
	PlaybackRate    float64    `json:"playbackRate"`
	Playing         bool       `json:"playing"`
	AutoPlayOnReady bool       `json:"autoPlayOnReady"`
}

type HeartbeatPayload struct {
	PositionSeconds float64    `json:"positionSeconds"`
	PlaybackRate    float64    `json:"playbackRate"`
	Playing         bool       `json:"playing"`
	Media           MediaState `json:"media"`
}

type ClientReadyPayload struct {
	MediaKey        string `json:"mediaKey"`
	PageURL         string `json:"pageUrl"`
	HasVideo        bool   `json:"hasVideo"`
	IsBufferedReady bool   `json:"isBufferedReady"`
}
