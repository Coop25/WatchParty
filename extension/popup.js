const port = chrome.runtime.connect({ name: "popup" });

const createRoomButton = document.getElementById("createRoomButton");
const joinRoomButton = document.getElementById("joinRoomButton");
const roomCodeInput = document.getElementById("roomCodeInput");
const serverUrlInput = document.getElementById("serverUrlInput");
const saveServerButton = document.getElementById("saveServerButton");
const toggleUnlockButton = document.getElementById("toggleUnlockButton");
const disbandRoomButton = document.getElementById("disbandRoomButton");
const remoteActionButton = document.getElementById("remoteActionButton");

const connectionState = document.getElementById("connectionState");
const connectionMirror = document.getElementById("connectionMirror");
const connectionError = document.getElementById("connectionError");
const roomState = document.getElementById("roomState");
const roleState = document.getElementById("roleState");
const remoteState = document.getElementById("remoteState");
const remoteModeState = document.getElementById("remoteModeState");
const videoState = document.getElementById("videoState");
const mediaMatchState = document.getElementById("mediaMatchState");
const currentPage = document.getElementById("currentPage");
const roomMedia = document.getElementById("roomMedia");
const navigateButton = document.getElementById("navigateButton");

createRoomButton.addEventListener("click", () => {
  port.postMessage({ type: "create_room" });
});

joinRoomButton.addEventListener("click", () => {
  port.postMessage({
    type: "join_room",
    payload: { roomId: roomCodeInput.value.trim().toUpperCase() }
  });
});

saveServerButton.addEventListener("click", () => {
  port.postMessage({
    type: "set_server_url",
    payload: { serverUrl: serverUrlInput.value.trim() }
  });
});

navigateButton.addEventListener("click", () => {
  port.postMessage({ type: "navigate_to_room_media" });
});

toggleUnlockButton.addEventListener("click", () => {
  port.postMessage({ type: "toggle_tab_unlock" });
});

disbandRoomButton.addEventListener("click", () => {
  port.postMessage({ type: "disband_room" });
});

remoteActionButton.addEventListener("click", () => {
  if (!remoteActionButton.dataset.action) {
    return;
  }
  port.postMessage({ type: remoteActionButton.dataset.action });
});

port.onMessage.addListener((message) => {
  if (message.type !== "state") {
    return;
  }
  render(message.payload);
});

function render(state) {
  const connectionLabel = formatConnectionState(state.wsState);
  serverUrlInput.value = state.serverUrl || "ws://localhost:8080/ws";
  connectionState.textContent = connectionLabel;
  connectionMirror.textContent = connectionLabel;
  connectionError.textContent = state.lastError || "";
  connectionError.hidden = !state.lastError;
  roomState.textContent = state.roomId || "Not joined";
  roleState.textContent = formatRole(state.role || "viewer");
  remoteState.textContent = state.remoteStateLabel || "Host";
  remoteModeState.textContent = state.tabControlUnlocked ? "Unlocked" : "Synced";
  toggleUnlockButton.textContent = state.tabControlUnlocked ? "Lock Controls" : "Unlock Controls";
  disbandRoomButton.hidden = state.role !== "host" || !state.roomId;
  videoState.textContent = state.videoStatus || "Unknown";
  mediaMatchState.textContent = state.mediaMatches ? "Matched" : "Mismatch";
  currentPage.textContent = state.currentPage || "No active page";
  roomMedia.textContent = state.roomMediaUrl || "No room media yet";
  navigateButton.hidden = !state.canNavigateToRoomMedia;
  remoteActionButton.hidden = false;
  remoteActionButton.dataset.action = state.remoteAction || "";
  remoteActionButton.textContent = state.remoteActionLabel || "Remote Unavailable";
  remoteActionButton.disabled = !state.remoteAction;
}

function formatConnectionState(value) {
  const normalized = String(value || "disconnected").toLowerCase();
  if (normalized === "connected") {
    return "Connected";
  }
  if (normalized === "connecting") {
    return "Connecting";
  }
  if (normalized === "error") {
    return "Error";
  }
  return "Offline";
}

function formatRole(value) {
  return value === "host" ? "Host" : "Viewer";
}
