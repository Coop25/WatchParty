# WatchTogether MVP

This repository contains:

- `server/`: Go WebSocket backend for room management and playback state
- `extension/`: Chrome extension (Manifest V3) for syncing standard HTML5 `<video>` elements

## How the extension and server communicate

1. The popup asks the background service worker to create or join a room.
2. The background opens a WebSocket to `ws://localhost:8080/ws`.
3. On connect, the background runs a multi-sample `time_sync` handshake and estimates server clock offset.
4. The content script watches the active HTML5 video and reports local media status and host-originated events to the background.
5. If this client currently holds the remote, the background forwards playback commands to the Go server using the JSON protocol.
6. The Go server updates the authoritative room state and broadcasts `scheduled_play`, `pause`, `seek`, `rate_change`, `media_changed`, and `room_state` messages.
7. The background converts server timestamps into local wall-clock times and sends concrete playback commands to the content script.
8. The content script applies those commands while suppressing local event rebroadcast loops.

## JSON protocol

Every message uses the same top-level shape:

```json
{
  "type": "scheduled_play",
  "roomId": "ABC123",
  "clientId": "client-1",
  "messageId": "uuid",
  "sentAt": 1710000000000,
  "payload": {}
}
```

Supported message types:

- `create_room`
- `join_room`
- `claim_remote`
- `release_remote`
- `reclaim_remote`
- `room_state`
- `time_sync`
- `time_sync_reply`
- `scheduled_play`
- `pause`
- `seek`
- `rate_change`
- `media_changed`
- `heartbeat`
- `error`

## Local development

### Taskfile helpers

If you use [`task`](https://taskfile.dev/), the repo now includes:

```powershell
task server:start
task server:status
task server:stop
task docker:start
task docker:logs
task docker:stop
task docker:destroy
```

These tasks start the Go server in the background, store its PID in `.task/server.pid`, and write logs to `.task/server.out.log` and `.task/server.err.log`.
The Go server also emits websocket and room event logs to help debug sync behavior.
The Docker tasks build `server/Dockerfile` into `watchtogeather-server:dev` and run it as `watchtogeather-server-dev` on port `8080`.

### Docker Compose deployment with Cloudflare Tunnel

If you publish the server image to GitHub Container Registry or another registry, you can run it on another machine with the included `docker-compose.yml`.

This repo includes `.github/workflows/publish-server-image.yml`, which builds `server/Dockerfile` and publishes `ghcr.io/coop25/watchparty-server` on pushes to `master`, version tags like `v1.0.0`, and manual runs.

1. Copy `.env.example` to `.env`
2. Set `WATCHTOGEATHER_IMAGE` to your published image tag
3. Set `CLOUDFLARE_TUNNEL_TOKEN` to the token for a named Cloudflare Tunnel
4. Start the stack:

```powershell
docker compose pull
docker compose up -d
```

The application stays private on the Docker network and `cloudflared` forwards traffic to it through your tunnel. Point your Cloudflare public hostname at `http://app:8080`, then use your public WebSocket URL in the extension, for example `wss://watch.example.com/ws`.

If your GitHub image is private, sign in on the host machine first:

```powershell
docker login ghcr.io
```

### 1. Start the Go backend

```powershell
cd server
go run .
```

The WebSocket endpoint is `ws://localhost:8080/ws`.

You can also run the backend in Docker:

```powershell
task docker:start
```

### 2. Load the Chrome extension

1. Open `chrome://extensions`
2. Enable Developer Mode
3. Click Load unpacked
4. Select the `extension/` folder

The popup includes a configurable server URL field. If you leave it alone, it defaults to `ws://localhost:8080/ws`.
The popup also shows whether an HTML5 video was detected on the current page and surfaces connection failures when the backend is not reachable.
The popup uses a dark theme by default.
When creating or joining a room, the extension refreshes the active page status immediately, and the popup can navigate the active tab to the room media URL when needed.

### 3. Test the core flow

1. Open the same HTML5 video page in two Chrome windows or profiles
2. On one client, create a room from the popup
3. On the other client, join using the room code
4. Press play on the host page
5. The server schedules playback in the future and both clients start together

## MVP behavior notes

- The host owns the room, but whoever currently holds the remote is authoritative for play, pause, seek, rate changes, and media changes.
- Play is always converted into a scheduled server-time start.
- Pause is applied immediately.
- Seek while playing is rebroadcast with a short future resume time.
- Late joiners receive the current room state immediately after joining.
- Drift correction is viewer-side with tunable thresholds in `extension/content.js`.

## Known limitations

- Only standard HTML5 `<video>` elements are supported.
- The extension only targets the currently active tab.
- Viewers are marked mismatched on media changes but are not auto-navigated.
- The background service worker uses an in-memory connection state and room state.
- The backend keeps rooms in memory only, so restarting the server clears all rooms.
