const port = chrome.runtime.connect({ name: "popup" });

const createRoomButton = document.getElementById("createRoomButton");
const joinRoomButton = document.getElementById("joinRoomButton");
const roomCodeInput = document.getElementById("roomCodeInput");
const serverUrlInput = document.getElementById("serverUrlInput");
const saveServerButton = document.getElementById("saveServerButton");
const toggleUnlockButton = document.getElementById("toggleUnlockButton");
const disbandRoomButton = document.getElementById("disbandRoomButton");
const leaveRoomButton = document.getElementById("leaveRoomButton");
const sharedControlButton = document.getElementById("sharedControlButton");
const remoteActionButton = document.getElementById("remoteActionButton");
const popOutButton = document.getElementById("popOutButton");
const serverHealthState = document.getElementById("serverHealthState");

const connectionState = document.getElementById("connectionState");
const connectionMirror = document.getElementById("connectionMirror");
const connectionError = document.getElementById("connectionError");
const roomState = document.getElementById("roomState");
const roleState = document.getElementById("roleState");
const viewerCountState = document.getElementById("viewerCountState");
const remoteState = document.getElementById("remoteState");
const remoteModeState = document.getElementById("remoteModeState");
const videoState = document.getElementById("videoState");
const mediaMatchState = document.getElementById("mediaMatchState");
const currentPage = document.getElementById("currentPage");
const roomMedia = document.getElementById("roomMedia");
const navigateButton = document.getElementById("navigateButton");
const claimTabButton = document.getElementById("claimTabButton");

let serverUrlDraft = "";
let isEditingServerUrl = false;
let pendingServerUrlSave = "";
let saveFeedbackTimer = null;
let roomCodeFeedbackTimer = null;
let serverHealthAbortController = null;
let lastHealthCheckedServerUrl = "";
let serverHealthRetryTimer = null;
const isPoppedOutWindow = new URLSearchParams(window.location.search).get("mode") === "window";

if (isPoppedOutWindow) {
  document.body.classList.add("is-popped-out");
  popOutButton.hidden = true;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    runVisibleHealthCheckIfNeeded(true);
  } else {
    stopHealthCheckRetries();
  }
});

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
  const nextServerUrl = serverUrlInput.value.trim();
  serverUrlDraft = nextServerUrl;
  isEditingServerUrl = false;
  pendingServerUrlSave = nextServerUrl;
  setSaveButtonState("saving");
  port.postMessage({
    type: "set_server_url",
    payload: { serverUrl: nextServerUrl }
  });
});

serverUrlInput.addEventListener("focus", () => {
  isEditingServerUrl = true;
  serverUrlDraft = serverUrlInput.value;
});

serverUrlInput.addEventListener("input", () => {
  isEditingServerUrl = true;
  serverUrlDraft = serverUrlInput.value;
});

serverUrlInput.addEventListener("blur", () => {
  const normalizedDraft = serverUrlDraft.trim();
  const normalizedSaved = (serverUrlInput.dataset.savedValue || "").trim();
  isEditingServerUrl = normalizedDraft !== normalizedSaved;
});

navigateButton.addEventListener("click", () => {
  port.postMessage({ type: "navigate_to_room_media" });
});

claimTabButton.addEventListener("click", () => {
  port.postMessage({ type: "adopt_active_tab" });
});

toggleUnlockButton.addEventListener("click", () => {
  port.postMessage({ type: "toggle_tab_unlock" });
});

disbandRoomButton.addEventListener("click", () => {
  port.postMessage({ type: "disband_room" });
});

leaveRoomButton.addEventListener("click", () => {
  port.postMessage({ type: "leave_room" });
});

roomState.addEventListener("click", async () => {
  const roomCode = roomState.dataset.roomCode || "";
  if (!roomCode) {
    return;
  }

  try {
    await navigator.clipboard.writeText(roomCode);
    showRoomCodeCopiedFeedback(roomCode);
  } catch (error) {
    console.warn("Failed to copy room code", error);
  }
});

sharedControlButton.addEventListener("click", () => {
  port.postMessage({
    type: "set_shared_control",
    payload: { enabled: !sharedControlButton.dataset.enabled || sharedControlButton.dataset.enabled !== "true" }
  });
});

remoteActionButton.addEventListener("click", () => {
  if (!remoteActionButton.dataset.action) {
    return;
  }
  port.postMessage({ type: remoteActionButton.dataset.action });
});

popOutButton.addEventListener("click", () => {
  port.postMessage({ type: "open_popup_window" });
});

serverHealthState.addEventListener("click", () => {
  const currentServerUrl = normalizeServerUrl(serverUrlInput.value || serverUrlInput.dataset.savedValue || "");
  if (!currentServerUrl) {
    return;
  }
  lastHealthCheckedServerUrl = currentServerUrl;
  runServerHealthCheckSequence(currentServerUrl, true);
});

port.onMessage.addListener((message) => {
  if (message.type !== "state") {
    return;
  }
  render(message.payload);
});

runVisibleHealthCheckIfNeeded(true);

function render(state) {
  const connectionLabel = formatConnectionState(state.wsState);
  const savedServerUrl = state.serverUrl || "ws://localhost:8080/ws";
  serverUrlInput.dataset.savedValue = savedServerUrl;
  if (!isEditingServerUrl) {
    serverUrlInput.value = savedServerUrl;
    serverUrlDraft = savedServerUrl;
  }
  if (savedServerUrl !== lastHealthCheckedServerUrl && document.visibilityState === "visible") {
    lastHealthCheckedServerUrl = savedServerUrl;
    runServerHealthCheckSequence(savedServerUrl, true);
  }
  if (pendingServerUrlSave && normalizeServerUrl(savedServerUrl) === normalizeServerUrl(pendingServerUrlSave)) {
    pendingServerUrlSave = "";
    showServerUrlSavedFeedback();
  } else if (!pendingServerUrlSave) {
    setSaveButtonState("idle");
  }
  connectionState.textContent = connectionLabel;
  connectionMirror.textContent = connectionLabel;
  connectionError.textContent = state.lastError || "";
  connectionError.hidden = !state.lastError;
  roomState.dataset.roomCode = state.roomId || "";
  roomState.disabled = !state.roomId;
  roomState.title = state.roomId ? "Click to copy room code" : "No room code yet";
  if (!roomCodeFeedbackTimer) {
    roomState.textContent = state.roomId || "Not joined";
  }
  roleState.textContent = formatRole(state.role || "viewer");
  viewerCountState.textContent = String(state.viewerCount || 0);
  remoteState.textContent = state.remoteStateLabel || "Host";
  remoteModeState.textContent = state.tabControlUnlocked ? "Unlocked" : "Synced";
  toggleUnlockButton.textContent = state.tabControlUnlocked ? "Lock Controls" : "Unlock Controls";
  disbandRoomButton.hidden = state.role !== "host" || !state.roomId;
  leaveRoomButton.hidden = state.role !== "viewer" || !state.roomId;
  sharedControlButton.hidden = !state.canToggleSharedControl;
  sharedControlButton.dataset.enabled = state.sharedControlEnabled ? "true" : "false";
  sharedControlButton.textContent = state.sharedControlEnabled ? "Disable Shared Control" : "Enable Shared Control";
  videoState.textContent = state.videoStatus || "Unknown";
  mediaMatchState.textContent = state.mediaMatches ? "Matched" : "Mismatch";
  currentPage.textContent = state.currentPage || "No active page";
  roomMedia.textContent = state.roomMediaUrl || "No room media yet";
  claimTabButton.hidden = !state.canAdoptActiveTab;
  navigateButton.hidden = !state.canNavigateToRoomMedia;
  navigateButton.textContent = state.roomTabMissing ? "Open Room Media Here" : "Open Room Media";
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

function normalizeServerUrl(value) {
  return String(value || "").trim();
}

function showServerUrlSavedFeedback() {
  if (saveFeedbackTimer) {
    clearTimeout(saveFeedbackTimer);
  }
  setSaveButtonState("saved");
  saveFeedbackTimer = setTimeout(() => {
    setSaveButtonState("idle");
    saveFeedbackTimer = null;
  }, 1400);
}

function setSaveButtonState(mode) {
  saveServerButton.classList.remove("is-saving", "is-saved");
  if (mode === "saving") {
    saveServerButton.textContent = "Saving...";
    saveServerButton.classList.add("is-saving");
    return;
  }
  if (mode === "saved") {
    saveServerButton.textContent = "Saved";
    saveServerButton.classList.add("is-saved");
    return;
  }
  saveServerButton.textContent = "Save";
}

function showRoomCodeCopiedFeedback(roomCode) {
  if (roomCodeFeedbackTimer) {
    clearTimeout(roomCodeFeedbackTimer);
  }
  roomState.textContent = "Copied";
  roomState.classList.add("is-copied");
  roomCodeFeedbackTimer = setTimeout(() => {
    roomState.textContent = roomCode;
    roomState.classList.remove("is-copied");
    roomCodeFeedbackTimer = null;
  }, 1200);
}

async function runServerHealthCheck(serverUrl) {
  const healthUrl = deriveHealthUrl(serverUrl);
  serverHealthState.classList.remove("headerBadgeSuccess", "headerBadgeError");
  if (!healthUrl) {
    serverHealthState.textContent = "Invalid";
    serverHealthState.classList.add("headerBadgeError");
    return false;
  }

  if (serverHealthAbortController) {
    serverHealthAbortController.abort();
  }

  serverHealthAbortController = new AbortController();
  const timeoutId = setTimeout(() => {
    serverHealthAbortController?.abort();
  }, 4000);

  serverHealthState.textContent = "Checking";
  serverHealthState.classList.remove("headerBadgeSuccess", "headerBadgeError");

  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      cache: "no-store",
      signal: serverHealthAbortController.signal
    });

    if (!response.ok) {
      serverHealthState.textContent = `Fail ${response.status}`;
      serverHealthState.classList.add("headerBadgeError");
      return false;
    }

    await response.text();
    serverHealthState.textContent = "Reachable";
    serverHealthState.classList.add("headerBadgeSuccess");
    return true;
  } catch (error) {
    if (error?.name === "AbortError") {
      serverHealthState.textContent = "Timeout";
    } else {
      serverHealthState.textContent = "Unreachable";
    }
    serverHealthState.classList.add("headerBadgeError");
    return false;
  } finally {
    clearTimeout(timeoutId);
    serverHealthAbortController = null;
  }
}

function deriveHealthUrl(serverUrl) {
  try {
    const parsed = new URL(serverUrl);
    if (parsed.protocol === "ws:") {
      parsed.protocol = "http:";
    } else if (parsed.protocol === "wss:") {
      parsed.protocol = "https:";
    } else if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    parsed.pathname = "/healthz";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    return "";
  }
}

function runVisibleHealthCheckIfNeeded(force = false) {
  if (document.visibilityState !== "visible") {
    return;
  }
  const currentServerUrl = normalizeServerUrl(serverUrlInput.value || serverUrlInput.dataset.savedValue || "");
  if (!currentServerUrl) {
    return;
  }
  if (!force && currentServerUrl === lastHealthCheckedServerUrl) {
    return;
  }
  lastHealthCheckedServerUrl = currentServerUrl;
  runServerHealthCheckSequence(currentServerUrl, true);
}

function stopHealthCheckRetries() {
  if (serverHealthRetryTimer) {
    clearTimeout(serverHealthRetryTimer);
    serverHealthRetryTimer = null;
  }
  if (serverHealthAbortController) {
    serverHealthAbortController.abort();
    serverHealthAbortController = null;
  }
}

async function runServerHealthCheckSequence(serverUrl, resetRetries = false, attempt = 1) {
  if (resetRetries) {
    stopHealthCheckRetries();
  }

  const ok = await runServerHealthCheck(serverUrl);
  if (ok) {
    return;
  }

  if (attempt >= 3) {
    serverHealthState.textContent = "Unreachable";
    serverHealthState.classList.remove("headerBadgeSuccess");
    serverHealthState.classList.add("headerBadgeError");
    return;
  }

  const retryDelayMs = attempt === 1 ? 5000 : 10000;
  serverHealthRetryTimer = setTimeout(() => {
    if (document.visibilityState !== "visible") {
      return;
    }
    runServerHealthCheckSequence(serverUrl, false, attempt + 1);
  }, retryDelayMs);
}
