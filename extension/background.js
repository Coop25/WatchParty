const DEFAULT_SERVER_WS_URL = "ws://localhost:8080/ws";
const HEARTBEAT_INTERVAL_MS = 2000;
const TIME_SYNC_SAMPLES = 5;
const MIN_TIME_SYNC_SAMPLES = 3;
const AUTO_NAVIGATE_COOLDOWN_MS = 3 * 60 * 1000;
const MAX_CONNECTION_FAILURES = 3;
const VIEWER_READY_POSITION_TOLERANCE_SECONDS = 0.75;
const VIEWER_READY_BUFFER_AHEAD_SECONDS = 4;
const VIEWER_READY_STABLE_MS = 5000;
const VIEWER_NETWORK_IDLE_MS = 5000;
const VIEWER_READY_MIN_READY_STATE = 4;
const DEFAULT_AUTO_PLAY_ENABLED = true;
const POP_OUT_WINDOW_URL = "popup.html?mode=window";
const POP_OUT_WINDOW_WIDTH = 440;
const POP_OUT_WINDOW_HEIGHT = 760;
const STORAGE_KEYS = ["serverUrl", "autoPlayEnabled", "clientSessionId", "roomId", "roomTabId", "shouldReconnectRoom"];

const state = {
  ws: null,
  wsState: "disconnected",
  reconnectTimer: null,
  roomId: "",
  clientId: "",
  clientSessionId: "",
  role: "viewer",
  roomState: null,
  serverOffsetMs: 0,
  timeSamples: [],
  popupPorts: new Set(),
  lastContentStatus: null,
  activeTabId: null,
  roomTabId: null,
  serverUrl: DEFAULT_SERVER_WS_URL,
  lastError: "",
  timeSyncReady: false,
  connectionFailures: 0,
  shouldRetryConnection: false,
  lastAutoNavigatedRoomUrl: "",
  lastAutoNavigateAt: 0,
  lastViewerSyncKey: "",
  lastClientReadyKey: "",
  viewerReadySinceAt: 0,
  awaitingHostManualPlay: false,
  pendingNetworkRequests: {},
  lastNetworkActivityAt: {},
  unlockedTabIds: {},
  autoPlayEnabled: DEFAULT_AUTO_PLAY_ENABLED,
  shouldReconnectRoom: false,
  popupWindowId: null
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(STORAGE_KEYS).then((stored) => {
    const nextValues = {};
    if (!stored.serverUrl) {
      nextValues.serverUrl = DEFAULT_SERVER_WS_URL;
    }
    if (typeof stored.autoPlayEnabled !== "boolean") {
      nextValues.autoPlayEnabled = DEFAULT_AUTO_PLAY_ENABLED;
    }
    if (!stored.clientSessionId) {
      nextValues.clientSessionId = crypto.randomUUID();
    }
    if (Object.keys(nextValues).length > 0) {
      return chrome.storage.local.set(nextValues);
    }
    return undefined;
  }).finally(() => {
    broadcastState();
    syncControlStateToRoomTab();
  });
});

initializeState();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") {
    return;
  }
  state.popupPorts.add(port);
  port.postMessage({ type: "state", payload: publicState() });
  port.onMessage.addListener((msg) => handlePopupMessage(msg));
  port.onDisconnect.addListener(() => {
    state.popupPorts.delete(port);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "content_status") {
    const senderTabId = sender.tab?.id ?? null;
    if (state.roomTabId && senderTabId !== state.roomTabId) {
      if (senderTabId) {
        syncControlStateToTab(senderTabId, disabledControlState());
      }
      sendResponse({ ok: true, ignored: true });
      return true;
    }
    state.lastContentStatus = { ...message.payload, tabId: senderTabId };
    maybeSendMediaChanged();
    maybeAutoNavigateToRoomMedia();
    maybeSyncViewerAfterPageMatch();
    broadcastState();
    syncControlStateToRoomTab();
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "content_event") {
    const senderTabId = sender.tab?.id ?? null;
    if (state.roomTabId && senderTabId !== state.roomTabId) {
      if (senderTabId) {
        syncControlStateToTab(senderTabId, disabledControlState());
      }
      sendResponse({ ok: true, ignored: true });
      return true;
    }
    handleContentEvent(message.payload, sender.tab?.id ?? null);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "get_state") {
    sendResponse({ ok: true, payload: publicState() });
    return true;
  }

  return false;
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  state.activeTabId = tabId;
  if (!state.roomTabId || tabId === state.roomTabId) {
    await requestTabStatus(tabId);
    await syncControlStateToRoomTab(tabId);
  } else {
    await syncControlStateToRoomTab();
    await syncControlStateToTab(tabId, disabledControlState());
    broadcastState();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if ((tabId === state.activeTabId || tabId === state.roomTabId) && changeInfo.status === "complete") {
    await requestTabStatus(tabId);
    await syncControlStateToRoomTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (state.activeTabId === tabId) {
    state.activeTabId = null;
  }
  if (state.roomTabId !== tabId) {
    return;
  }

  delete state.pendingNetworkRequests[tabId];
  delete state.lastNetworkActivityAt[tabId];
  state.roomTabId = null;
  state.lastContentStatus = null;
  persistRoomState();
  broadcastState();

  const nextActiveTabId = await getActiveTabId();
  state.activeTabId = nextActiveTabId;
  if (nextActiveTabId) {
    await requestTabStatus(nextActiveTabId);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (state.popupWindowId === windowId) {
    state.popupWindowId = null;
  }
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    trackNetworkActivity(details.tabId, 1, details.type);
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    trackNetworkActivity(details.tabId, -1, details.type);
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    trackNetworkActivity(details.tabId, -1, details.type);
  },
  { urls: ["<all_urls>"] }
);

setInterval(async () => {
  const tabId = state.roomTabId || await getActiveTabId();
  if (tabId && (!state.roomTabId || tabId === state.roomTabId)) {
    if (!state.roomTabId) {
      state.activeTabId = tabId;
    }
    await requestTabStatus(tabId);
  }

  if (holdsRemote() && state.roomId && state.lastContentStatus?.hasVideo) {
    sendToServer("heartbeat", {
      positionSeconds: state.lastContentStatus.currentTime,
      playbackRate: state.lastContentStatus.playbackRate,
      playing: !state.lastContentStatus.paused,
      media: state.lastContentStatus.media
    });
  }
}, HEARTBEAT_INTERVAL_MS);

async function handlePopupMessage(message) {
  switch (message?.type) {
    case "create_room":
      await setRoomTabId(state.activeTabId || await getActiveTabId());
      await refreshRoomTabStatus();
      state.shouldRetryConnection = true;
      state.connectionFailures = 0;
      state.shouldReconnectRoom = true;
      persistRoomState();
      if (!await ensureConnected()) {
        break;
      }
      sendToServer("create_room", { clientSessionId: state.clientSessionId });
      break;
    case "join_room":
      await setRoomTabId(state.activeTabId || await getActiveTabId());
      await refreshRoomTabStatus();
      state.shouldRetryConnection = true;
      state.connectionFailures = 0;
      if (!await ensureConnected()) {
        break;
      }
      state.roomId = normalizeRoomId(message.payload?.roomId || "");
      state.role = "viewer";
      state.shouldReconnectRoom = true;
      persistRoomState();
      sendToServer("join_room", { roomId: state.roomId, clientSessionId: state.clientSessionId });
      break;
    case "refresh_status":
      await refreshRoomTabStatus();
      break;
    case "set_server_url":
      await setServerURL(message.payload?.serverUrl || DEFAULT_SERVER_WS_URL);
      break;
    case "set_auto_play_enabled":
      await setAutoPlayEnabled(Boolean(message.payload?.enabled));
      break;
    case "navigate_to_room_media":
      await navigateToRoomMedia();
      break;
    case "adopt_active_tab":
      await adoptActiveTabAsRoomTab();
      break;
    case "toggle_tab_unlock":
      await toggleActiveTabUnlock();
      break;
    case "leave_room":
      if (state.roomId && state.role === "viewer") {
        await leaveCurrentRoom();
      }
      break;
    case "set_shared_control":
      if (state.roomId && state.role === "host") {
        sendToServer("set_shared_control", { enabled: Boolean(message.payload?.enabled) });
      }
      break;
    case "disband_room":
      if (state.roomId && state.role === "host") {
        sendToServer("disband_room", {});
        disconnectFromServer();
        clearRoomState("");
      }
      break;
    case "claim_remote":
      if (state.roomId && state.role === "viewer" && !state.roomState?.remoteHolderClientId) {
        sendToServer("claim_remote", {});
      }
      break;
    case "release_remote":
      if (state.roomId && holdsRemote()) {
        sendToServer("release_remote", {});
      }
      break;
    case "reclaim_remote":
      if (state.roomId && state.role === "host") {
        sendToServer("reclaim_remote", {});
      }
      break;
    case "open_popup_window":
      await openPopupWindow();
      break;
    default:
      break;
  }
}

async function ensureConnected() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    await waitForTimeSync();
    return true;
  }

  state.shouldRetryConnection = true;
  connectWebSocket();
  const connected = await waitForSocketReady();
  if (!connected) {
    return false;
  }
  await waitForTimeSync();
  return true;
}

function connectWebSocket() {
  if (!state.shouldRetryConnection) {
    state.wsState = "disconnected";
    broadcastState();
    return;
  }

  clearTimeout(state.reconnectTimer);
  if (state.ws) {
    try {
      state.ws.close();
    } catch (error) {
      console.warn("Failed to close existing socket", error);
    }
  }
  state.wsState = "connecting";
  state.lastError = "";
  broadcastState();

  const ws = new WebSocket(state.serverUrl || DEFAULT_SERVER_WS_URL);
  state.ws = ws;

  ws.addEventListener("open", () => {
    state.wsState = "connected";
    state.connectionFailures = 0;
    state.lastError = "";
    state.timeSamples = [];
    state.timeSyncReady = false;
    broadcastState();
    runTimeSync();
    if (state.roomId) {
      sendToServer("join_room", { roomId: state.roomId, clientSessionId: state.clientSessionId });
    }
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    handleServerMessage(message);
  });

  ws.addEventListener("close", () => {
    const failedInitialConnect = state.wsState === "connecting" || state.wsState === "error";
    state.wsState = "disconnected";
    if (failedInitialConnect) {
      state.connectionFailures += 1;
      if (state.connectionFailures >= MAX_CONNECTION_FAILURES) {
        state.shouldRetryConnection = false;
      }
    }
    broadcastState();
    if (state.shouldRetryConnection) {
      state.reconnectTimer = setTimeout(connectWebSocket, 1500);
    }
  });

  ws.addEventListener("error", () => {
    state.wsState = "error";
    broadcastState();
  });
}

function handleServerMessage(message) {
  switch (message.type) {
    case "welcome":
      break;
    case "time_sync_reply":
      recordTimeSyncSample(message.payload);
      break;
    case "room_state":
      {
      const previousRemoteHolderClientId = state.roomState?.remoteHolderClientId || "";
      state.roomId = message.roomId || state.roomId;
      state.roomState = message.payload;
      state.clientId = state.clientSessionId;
      persistRoomState();
      state.lastViewerSyncKey = "";
      state.lastClientReadyKey = "";
      state.viewerReadySinceAt = 0;
      state.role = state.roomState?.hostClientId === state.clientId ? "host" : "viewer";
      const controlsRemote = holdsRemote();
      const gainedRemote = controlsRemote && previousRemoteHolderClientId !== state.clientId;
      refreshRoomTabStatus().then(() => {
        if (controlsRemote && state.role === "host") {
          initializeRoomFromActivePage();
        } else {
          maybeAutoNavigateToRoomMedia();
          maybeSyncViewerAfterPageMatch();
          syncControlStateToRoomTab();
        }
        if (gainedRemote) {
          syncClientToRoomState();
        }
      });
      if (!controlsRemote) {
        syncClientToRoomState();
      }
      break;
      }
    case "scheduled_play":
      state.awaitingHostManualPlay = false;
      applyToContent({
        type: "scheduled_play",
        payload: {
        targetTimeSeconds: message.payload.targetTimeSeconds,
        playbackRate: message.payload.playbackRate,
        startAtLocalTime: serverToLocalTime(message.payload.startAtServerTime)
      }
    });
      updateLocalRoomStateForCommand("scheduled_play", message.payload);
      break;
    case "pause":
      applyToContent({ type: "pause", payload: message.payload });
      updateLocalRoomStateForCommand("pause", message.payload);
      break;
    case "seek":
      applyToContent({
        type: "seek",
        payload: {
          ...message.payload,
          startAtLocalTime: message.payload.startAtServerTime
            ? serverToLocalTime(message.payload.startAtServerTime)
            : null
        }
      });
      updateLocalRoomStateForCommand("seek", message.payload);
      break;
    case "rate_change":
      applyToContent({ type: "rate_change", payload: message.payload });
      updateLocalRoomStateForCommand("rate_change", message.payload);
      break;
    case "media_changed":
      if (holdsRemote()) {
        state.awaitingHostManualPlay = !message.payload?.autoPlayOnReady;
      }
      updateLocalRoomStateForCommand("media_changed", message.payload);
      broadcastState();
      break;
    case "room_closed":
      disconnectFromServer();
      clearRoomState("Room closed by host.");
      return;
    case "error":
      state.lastError = message.payload?.message || "Server error";
      console.warn("Server error:", message.payload?.message);
      break;
    default:
      break;
  }

  broadcastState();
  syncControlStateToRoomTab();
}

function handleContentEvent(payload) {
  if (!state.roomId || !canSendPlaybackCommands()) {
    return;
  }

  switch (payload.event) {
    case "play":
      state.awaitingHostManualPlay = false;
      sendToServer("scheduled_play", {
        targetTimeSeconds: payload.currentTime,
        playbackRate: payload.playbackRate,
        media: payload.media
      });
      break;
    case "pause":
      sendToServer("pause", {
        positionSeconds: payload.currentTime,
        media: payload.media
      });
      break;
    case "seek":
      sendToServer("seek", {
        targetTimeSeconds: payload.currentTime,
        resumeAfterSeek: payload.resumeAfterSeek,
        playbackRate: payload.playbackRate,
        media: payload.media
      });
      break;
    case "rate_change":
      sendToServer("rate_change", {
        playbackRate: payload.playbackRate,
        positionSeconds: payload.currentTime,
        media: payload.media
      });
      break;
    default:
      break;
  }
}

function maybeSendMediaChanged() {
  if (!state.roomId || !canSendPlaybackCommands() || !state.lastContentStatus?.hasVideo) {
    return;
  }

  const currentKey = state.lastContentStatus.media?.mediaKey || "";
  const roomKey = state.roomState?.media?.mediaKey || "";
  const currentPageUrl = state.lastContentStatus.media?.pageUrl || "";
  const roomPageUrl = state.roomState?.media?.pageUrl || "";
  if ((currentKey && currentKey !== roomKey) || (currentPageUrl && currentPageUrl !== roomPageUrl)) {
    sendToServer("media_changed", {
      media: state.lastContentStatus.media,
      positionSeconds: state.lastContentStatus.currentTime,
      playbackRate: state.lastContentStatus.playbackRate,
      playing: false,
      autoPlayOnReady: currentAutoPlayOnReady()
    });
  }
}

function initializeRoomFromActivePage() {
  if (!state.roomId || !canSendPlaybackCommands() || !state.lastContentStatus) {
    return;
  }

  const roomKey = state.roomState?.media?.mediaKey || "";
  const pageMedia = state.lastContentStatus.media;
  if (!pageMedia?.pageUrl) {
    return;
  }

  const shouldInitializeRoomMedia = !roomKey
    || roomKey !== pageMedia.mediaKey
    || state.roomState?.media?.pageUrl !== pageMedia.pageUrl;

  if (shouldInitializeRoomMedia) {
    applyToContent({
      type: "pause",
      payload: {
        positionSeconds: state.lastContentStatus.currentTime || 0,
        media: pageMedia
      }
    });
    sendToServer("media_changed", {
      media: pageMedia,
      positionSeconds: state.lastContentStatus.currentTime || 0,
      playbackRate: state.lastContentStatus.playbackRate || 1,
      playing: false,
      autoPlayOnReady: currentAutoPlayOnReady()
    });
    state.awaitingHostManualPlay = !currentAutoPlayOnReady();
  }
}

function sendToServer(type, payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }

  state.ws.send(JSON.stringify({
    type,
    roomId: state.roomId,
    clientId: state.clientId,
    messageId: crypto.randomUUID(),
    sentAt: Date.now(),
    payload
  }));
}

async function requestTabStatus(tabId) {
  if (!tabId) {
    return;
  }
  if (state.roomTabId && tabId !== state.roomTabId) {
    return;
  }
  try {
    const response = await requestTabStatusOnce(tabId);
    if (response?.payload) {
      state.lastContentStatus = { ...response.payload, tabId };
      broadcastState();
      syncControlStateToRoomTab(tabId);
    }
  } catch (error) {
    try {
      await ensureContentScriptInjected(tabId);
      const response = await requestTabStatusOnce(tabId);
      if (response?.payload) {
        state.lastContentStatus = { ...response.payload, tabId };
        broadcastState();
        syncControlStateToRoomTab(tabId);
        return;
      }
    } catch (retryError) {
      console.warn("Failed to collect tab status", retryError);
    }

    state.lastContentStatus = null;
    broadcastState();
    syncControlStateToRoomTab(tabId);
  }
}

function requestTabStatusOnce(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "collect_status" });
}

async function ensureContentScriptInjected(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url || "";
  if (!isScriptInjectableURL(url)) {
    throw new Error(`Cannot inject content script into ${url || "this tab"}`);
  }

  const [{ result: alreadyLoaded = false } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => Boolean(globalThis.__watchTogetherContentScriptLoaded)
  });

  if (alreadyLoaded) {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
}

function isScriptInjectableURL(url) {
  return Boolean(url)
    && !url.startsWith("chrome://")
    && !url.startsWith("chrome-extension://")
    && !url.startsWith("devtools://")
    && !url.startsWith("about:")
    && !url.startsWith("edge://");
}

async function refreshRoomTabStatus() {
  const tabId = state.roomTabId || state.activeTabId || await getActiveTabId();
  if (!tabId) {
    return;
  }

  state.roomTabId = tabId;
  await requestTabStatus(tabId);
}

async function maybeAutoNavigateToRoomMedia() {
  if (!state.roomId || state.role !== "viewer") {
    return;
  }

  const roomMediaUrl = state.roomState?.media?.pageUrl || "";
  if (!roomMediaUrl) {
    return;
  }

  if (!state.roomTabId) {
    return;
  }

  const currentPageUrl = state.lastContentStatus?.media?.pageUrl || "";
  if (urlsMatch(roomMediaUrl, currentPageUrl)) {
    return;
  }

  const now = Date.now();
  if (
    state.lastAutoNavigatedRoomUrl === roomMediaUrl
    && now-state.lastAutoNavigateAt < AUTO_NAVIGATE_COOLDOWN_MS
  ) {
    return;
  }

  state.lastAutoNavigatedRoomUrl = roomMediaUrl;
  state.lastAutoNavigateAt = now;
  await navigateToRoomMedia();
}

function maybeSyncViewerAfterPageMatch() {
  if (holdsRemote() || !state.roomId || !state.roomState || !state.lastContentStatus?.hasVideo) {
    state.viewerReadySinceAt = 0;
    return;
  }

  const currentPageUrl = state.lastContentStatus.media?.pageUrl || "";
  const roomPageUrl = state.roomState.media?.pageUrl || "";
  const syncKey = [
    state.roomTabId || "",
    currentPageUrl,
    state.roomState.playback.lastUpdatedAtMs || "",
    state.roomState.playback.scheduledStartAtMs || "",
    state.roomState.playback.positionSeconds || "",
    state.roomState.playback.playing ? "1" : "0"
  ].join("|");
  const pageMatches = Boolean(currentPageUrl)
    && Boolean(roomPageUrl)
    && currentPageUrl === roomPageUrl;

  if (pageMatches && syncKey !== state.lastViewerSyncKey) {
    state.lastViewerSyncKey = syncKey;
    syncClientToRoomState();
  }

  const targetPosition = state.roomState.playback?.positionSeconds || 0;
  const clientPosition = state.lastContentStatus.currentTime || 0;
  const nearTarget = Math.abs(clientPosition - targetPosition) <= VIEWER_READY_POSITION_TOLERANCE_SECONDS;
  const bufferedEnough = (state.lastContentStatus.bufferedAheadSeconds || 0) >= VIEWER_READY_BUFFER_AHEAD_SECONDS;
  const readyStateEnough = (state.lastContentStatus.readyState || 0) >= VIEWER_READY_MIN_READY_STATE;
  const networkIdle = isRoomTabNetworkIdle();
  const readyNow = (
    pageMatches
    && state.lastContentStatus.isBufferedReady
    && readyStateEnough
    && nearTarget
    && bufferedEnough
    && networkIdle
  );
  if (!readyNow) {
    state.viewerReadySinceAt = 0;
    return;
  }

  if (!state.viewerReadySinceAt) {
    state.viewerReadySinceAt = Date.now();
    return;
  }

  if (Date.now() - state.viewerReadySinceAt < VIEWER_READY_STABLE_MS) {
    return;
  }

  const readyKey = [state.roomId, roomPageUrl, state.lastContentStatus.media?.mediaKey || ""].join("|");
  if (readyKey !== state.lastClientReadyKey) {
    state.lastClientReadyKey = readyKey;
    sendToServer("client_ready", {
      mediaKey: state.lastContentStatus.media?.mediaKey || "",
      pageUrl: currentPageUrl,
      hasVideo: true,
      isBufferedReady: true
    });
  }
}

async function applyToContent(command) {
  const tabId = state.roomTabId || await getActiveTabId();
  if (!tabId) {
    return;
  }

  const controlState = buildControlState();
  if (!controlState.canApplyRemote) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: "apply_remote_command", payload: command });
  } catch (error) {
    console.warn("Failed to send command to content script", error);
  }
}

function syncClientToRoomState() {
  if (!state.roomState) {
    return;
  }

  const roomState = structuredClone(state.roomState);
  const serverNow = Date.now() + state.serverOffsetMs;
  if (
    roomState.playback.playing
    && roomState.referenceServerMs
    && serverNow > roomState.referenceServerMs
  ) {
    const elapsedSeconds = (serverNow - roomState.referenceServerMs) / 1000;
    roomState.playback.positionSeconds += elapsedSeconds * roomState.playback.playbackRate;
    roomState.referenceServerMs = serverNow;
  }
  const startAtLocalTime = roomState.playback.scheduledStartAtMs
    ? serverToLocalTime(roomState.playback.scheduledStartAtMs)
    : null;

  applyToContent({
    type: "sync_to_state",
    payload: {
      roomState,
      startAtLocalTime
    }
  });
}

function updateLocalRoomStateForCommand(type, payload) {
  if (!state.roomState) {
    return;
  }

  const next = structuredClone(state.roomState);
  next.media = payload.media || next.media;
  if (type === "scheduled_play") {
    next.playback.playing = true;
    next.playback.positionSeconds = payload.targetTimeSeconds;
    next.playback.playbackRate = payload.playbackRate;
    next.playback.scheduledStartAtMs = payload.startAtServerTime;
  } else if (type === "pause") {
    next.playback.playing = false;
    next.playback.positionSeconds = payload.positionSeconds;
    next.playback.scheduledStartAtMs = 0;
  } else if (type === "seek") {
    next.playback.positionSeconds = payload.targetTimeSeconds;
    next.playback.playbackRate = payload.playbackRate;
    next.playback.playing = payload.resumeAfterSeek;
    next.playback.scheduledStartAtMs = payload.startAtServerTime || 0;
  } else if (type === "rate_change") {
    next.playback.positionSeconds = payload.positionSeconds;
    next.playback.playbackRate = payload.playbackRate;
  } else if (type === "media_changed") {
    next.media = payload.media;
    next.playback.positionSeconds = payload.positionSeconds;
    next.playback.playbackRate = payload.playbackRate;
    next.playback.playing = payload.playing;
    next.playback.autoPlayOnReady = Boolean(payload.autoPlayOnReady);
  }
  state.roomState = next;
}

function runTimeSync() {
  for (let index = 0; index < TIME_SYNC_SAMPLES; index += 1) {
    setTimeout(() => {
      const clientSentAt = Date.now();
      sendToServer("time_sync", { clientSentAt });
    }, index * 120);
  }
}

function recordTimeSyncSample(payload) {
  const clientReceivedAt = Date.now();
  const rtt = clientReceivedAt - payload.clientSentAt;
  const midpoint = payload.clientSentAt + (rtt / 2);
  const offset = payload.serverTime - midpoint;
  state.timeSamples.push({ rtt, offset });
  state.timeSamples.sort((a, b) => a.rtt - b.rtt);
  const best = state.timeSamples.slice(0, Math.min(3, state.timeSamples.length));
  const avgOffset = best.reduce((sum, sample) => sum + sample.offset, 0) / best.length;
  state.serverOffsetMs = Number.isFinite(avgOffset) ? avgOffset : 0;
  state.timeSyncReady = state.timeSamples.length >= MIN_TIME_SYNC_SAMPLES;
  broadcastState();
}

function serverToLocalTime(serverTimeMs) {
  return Math.round(serverTimeMs - state.serverOffsetMs);
}

function publicState() {
  const roomMediaUrl = state.roomState?.media?.pageUrl || "";
  const currentPageUrl = state.lastContentStatus?.media?.pageUrl || "";
  const mediaMatches = !state.roomState?.media?.mediaKey
    || !state.lastContentStatus?.media?.mediaKey
    || state.roomState.media.mediaKey === state.lastContentStatus.media.mediaKey;
  const roomTabMissing = Boolean(state.roomId) && !state.roomTabId;
  const currentPageMatchesRoom = Boolean(roomMediaUrl)
    && urlsMatch(roomMediaUrl, currentPageUrl);
  const canAdoptActiveTab = Boolean(state.roomId)
    && roomTabMissing
    && Boolean(currentPageUrl)
    && (currentPageMatchesRoom || (state.role === "host" && !roomMediaUrl));
  const canNavigateToRoomMedia = Boolean(roomMediaUrl)
    && !currentPageMatchesRoom
    && (!roomTabMissing || Boolean(state.activeTabId));

  return {
    wsState: state.wsState,
    serverUrl: state.serverUrl,
    lastError: state.lastError,
    roomId: state.roomId,
    clientId: state.clientId,
    role: state.role,
    roomState: state.roomState,
    viewerCount: state.roomState?.viewerCount || 0,
    sharedControlEnabled: Boolean(state.roomState?.sharedControlEnabled),
    serverOffsetMs: state.serverOffsetMs,
    timeSyncReady: state.timeSyncReady,
    connectionFailures: state.connectionFailures,
    shouldRetryConnection: state.shouldRetryConnection,
    hasVideo: Boolean(state.lastContentStatus?.hasVideo),
    videoStatus: state.lastContentStatus?.hasVideo ? "Video found" : "No HTML5 video found",
    mediaMatches,
    roomMediaUrl,
    roomTabMissing,
    canAdoptActiveTab,
    canNavigateToRoomMedia,
    tabControlUnlocked: isRoomTabUnlocked(),
    autoPlayEnabled: state.autoPlayEnabled,
    roomTabId: state.roomTabId,
    awaitingHostManualPlay: state.awaitingHostManualPlay,
    remoteStateLabel: describeRemoteState(),
    remoteAction: remoteAction(),
    remoteActionLabel: remoteActionLabel(),
    canToggleSharedControl: state.role === "host" && Boolean(state.roomId),
    currentPage: currentPageUrl,
    currentTitle: state.lastContentStatus?.media?.pageTitle || ""
  };
}

function buildControlState() {
  const inRoom = Boolean(state.roomId);
  const currentPageUrl = state.lastContentStatus?.media?.pageUrl || "";
  const roomMediaUrl = state.roomState?.media?.pageUrl || "";
  const mediaMatches = !roomMediaUrl || !currentPageUrl || roomMediaUrl === currentPageUrl;
  const isHost = state.role === "host";
  const isRemoteHolder = holdsRemote();
  const sharedControlEnabled = Boolean(state.roomState?.sharedControlEnabled);
  const hostBootstrapAllowed = isHost && inRoom && !roomMediaUrl && Boolean(currentPageUrl);
  const controlsUnlocked = isRoomTabUnlocked();
  const canControlPlayback = sharedControlEnabled || isRemoteHolder;

  return {
    inRoom,
    role: state.role,
    currentPageUrl,
    roomMediaUrl,
    mediaMatches,
    controlsUnlocked,
    requireManualPlay: state.awaitingHostManualPlay && canControlPlayback,
    roomTabIsActive: true,
    canControlLocally: !controlsUnlocked && inRoom && canControlPlayback && (mediaMatches || hostBootstrapAllowed),
    canApplyRemote: !controlsUnlocked && inRoom && Boolean(roomMediaUrl) && mediaMatches
  };
}

function broadcastState() {
  const snapshot = { type: "state", payload: publicState() };
  for (const port of state.popupPorts) {
    port.postMessage(snapshot);
  }
}

function normalizeRoomId(value) {
  return String(value || "").trim().toUpperCase();
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id || null;
}

function waitForSocketReady() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const check = () => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        resolve(true);
      } else if (!state.shouldRetryConnection && state.wsState === "disconnected") {
        resolve(false);
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

function waitForTimeSync(timeoutMs = 1500) {
  if (state.timeSyncReady) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      if (state.timeSyncReady || Date.now() - startedAt >= timeoutMs) {
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

async function initializeState() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS);
  state.serverUrl = stored.serverUrl || DEFAULT_SERVER_WS_URL;
  state.autoPlayEnabled = typeof stored.autoPlayEnabled === "boolean"
    ? stored.autoPlayEnabled
    : DEFAULT_AUTO_PLAY_ENABLED;
  state.clientSessionId = stored.clientSessionId || crypto.randomUUID();
  state.clientId = state.clientSessionId;
  state.roomId = normalizeRoomId(stored.roomId || "");
  state.roomTabId = Number.isInteger(stored.roomTabId) ? stored.roomTabId : null;
  state.shouldReconnectRoom = Boolean(stored.shouldReconnectRoom) && Boolean(state.roomId);
  if (!stored.clientSessionId) {
    await chrome.storage.local.set({ clientSessionId: state.clientSessionId });
  }
  if (state.shouldReconnectRoom && state.roomId) {
    state.shouldRetryConnection = true;
    connectWebSocket();
  }
  broadcastState();
}

async function setServerURL(serverUrl) {
  const normalized = String(serverUrl || "").trim() || DEFAULT_SERVER_WS_URL;
  state.serverUrl = normalized;
  await chrome.storage.local.set({ serverUrl: normalized });
  state.connectionFailures = 0;
  state.shouldRetryConnection = false;

  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.close();
  }

  broadcastState();
}

async function setAutoPlayEnabled(enabled) {
  state.autoPlayEnabled = enabled;
  await chrome.storage.local.set({ autoPlayEnabled: enabled });
  broadcastState();
}

async function leaveCurrentRoom() {
  disconnectFromServer();
  clearRoomState("");
}

function disconnectFromServer() {
  state.shouldRetryConnection = false;
  state.shouldReconnectRoom = false;
  clearTimeout(state.reconnectTimer);
  state.wsState = "disconnected";
  state.connectionFailures = 0;
  state.timeSyncReady = false;
  state.timeSamples = [];
  persistRoomState();
  broadcastState();
  if (state.ws) {
    try {
      state.ws.close();
    } catch (error) {
      console.warn("Failed to close websocket while leaving room", error);
    }
    state.ws = null;
  }
}

async function toggleActiveTabUnlock() {
  const tabId = state.roomTabId || state.activeTabId || await getActiveTabId();
  if (!tabId) {
    return;
  }

  if (state.unlockedTabIds[tabId]) {
    delete state.unlockedTabIds[tabId];
  } else {
    state.unlockedTabIds[tabId] = true;
  }

  broadcastState();
  await syncControlStateToRoomTab(tabId);
}

function isRoomTabUnlocked() {
  return Boolean(state.roomTabId && state.unlockedTabIds[state.roomTabId]);
}

function clearRoomState(reason) {
  const previousRoomTabId = state.roomTabId;
  state.roomId = "";
  state.role = "viewer";
  state.roomState = null;
  state.roomTabId = null;
  state.shouldReconnectRoom = false;
  state.lastViewerSyncKey = "";
  state.lastClientReadyKey = "";
  state.viewerReadySinceAt = 0;
  state.awaitingHostManualPlay = false;
  if (previousRoomTabId) {
    delete state.pendingNetworkRequests[previousRoomTabId];
    delete state.lastNetworkActivityAt[previousRoomTabId];
  }
  state.lastError = reason || "";
  persistRoomState();
  broadcastState();
  if (previousRoomTabId) {
    syncControlStateToTab(previousRoomTabId, disabledControlState());
  }
}

async function syncControlStateToRoomTab(tabIdOverride) {
  const tabId = tabIdOverride || state.roomTabId || state.activeTabId || await getActiveTabId();
  if (!tabId) {
    return;
  }

  await syncControlStateToTab(tabId, buildControlState());
}

async function syncControlStateToTab(tabId, payload) {
  if (!tabId) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "set_control_state",
      payload
    });
  } catch (error) {
    // Ignore pages without the content script ready yet.
  }
}

function disabledControlState() {
  return {
    inRoom: false,
    role: "viewer",
    currentPageUrl: "",
    roomMediaUrl: "",
    mediaMatches: false,
    controlsUnlocked: false,
    requireManualPlay: false,
    roomTabIsActive: false,
    canControlLocally: false,
    canApplyRemote: false
  };
}

function holdsRemote() {
  return Boolean(state.roomId)
    && Boolean(state.roomState?.remoteHolderClientId)
    && state.roomState.remoteHolderClientId === state.clientId;
}

function currentAutoPlayOnReady() {
  if (state.role === "host") {
    return state.autoPlayEnabled;
  }
  return state.roomState?.playback?.autoPlayOnReady !== false;
}

function describeRemoteState() {
  if (!state.roomId) {
    return "Not in room";
  }
  if (state.roomState?.sharedControlEnabled) {
    return "Everyone";
  }
  const remoteHolderClientId = state.roomState?.remoteHolderClientId || "";
  if (!remoteHolderClientId) {
    return "Available to claim";
  }
  if (remoteHolderClientId === state.clientId) {
    return "You";
  }
  if (remoteHolderClientId === state.roomState?.hostClientId) {
    return "Host";
  }
  return "Viewer";
}

function remoteAction() {
  if (!state.roomId) {
    return "";
  }
  if (state.roomState?.sharedControlEnabled) {
    return "";
  }
  if (holdsRemote()) {
    return "release_remote";
  }
  if (state.role === "host") {
    return "reclaim_remote";
  }
  if (!state.roomState?.remoteHolderClientId) {
    return "claim_remote";
  }
  return "";
}

function remoteActionLabel() {
  const action = remoteAction();
  if (action === "release_remote") {
    return "Put Down Remote";
  }
  if (action === "reclaim_remote") {
    return "Take Remote Back";
  }
  if (action === "claim_remote") {
    return "Pick Up Remote";
  }
  return "";
}

function canSendPlaybackCommands() {
  return Boolean(state.roomId) && (Boolean(state.roomState?.sharedControlEnabled) || holdsRemote());
}

async function setRoomTabId(nextTabId) {
  const previousRoomTabId = state.roomTabId;
  state.roomTabId = nextTabId || null;
  if (state.roomTabId && state.pendingNetworkRequests[state.roomTabId] == null) {
    state.pendingNetworkRequests[state.roomTabId] = 0;
    state.lastNetworkActivityAt[state.roomTabId] = Date.now();
  }
  if (previousRoomTabId && previousRoomTabId !== state.roomTabId) {
    delete state.pendingNetworkRequests[previousRoomTabId];
    delete state.lastNetworkActivityAt[previousRoomTabId];
    await syncControlStateToTab(previousRoomTabId, disabledControlState());
  }
  persistRoomState();
}

async function navigateToRoomMedia() {
  const roomMediaUrl = state.roomState?.media?.pageUrl;
  if (!roomMediaUrl) {
    return;
  }

  const tabId = state.roomTabId || state.activeTabId || await getActiveTabId();
  if (!tabId) {
    return;
  }

  await setRoomTabId(tabId);
  await chrome.tabs.update(tabId, { url: roomMediaUrl });
}

async function adoptActiveTabAsRoomTab() {
  const activeTabId = state.activeTabId || await getActiveTabId();
  if (!activeTabId) {
    return;
  }

  await setRoomTabId(activeTabId);
  await requestTabStatus(activeTabId);
  await syncControlStateToRoomTab(activeTabId);
  maybeSyncViewerAfterPageMatch();
  broadcastState();
}

function trackNetworkActivity(tabId, delta, requestType) {
  if (tabId < 0 || !state.roomTabId || tabId !== state.roomTabId) {
    return;
  }
  if (requestType === "websocket") {
    return;
  }

  const currentPending = state.pendingNetworkRequests[tabId] || 0;
  const nextPending = Math.max(0, currentPending + delta);
  state.pendingNetworkRequests[tabId] = nextPending;
  state.lastNetworkActivityAt[tabId] = Date.now();
}

function isRoomTabNetworkIdle() {
  if (!state.roomTabId) {
    return false;
  }

  const pending = state.pendingNetworkRequests[state.roomTabId] || 0;
  const lastActivityAt = state.lastNetworkActivityAt[state.roomTabId] || 0;
  return pending === 0 && lastActivityAt > 0 && (Date.now() - lastActivityAt) >= VIEWER_NETWORK_IDLE_MS;
}

async function openPopupWindow() {
  if (state.popupWindowId != null) {
    try {
      await chrome.windows.update(state.popupWindowId, { focused: true });
      return;
    } catch (error) {
      state.popupWindowId = null;
    }
  }

  const popupUrl = chrome.runtime.getURL(POP_OUT_WINDOW_URL);
  const createdWindow = await chrome.windows.create({
    url: popupUrl,
    type: "popup",
    width: POP_OUT_WINDOW_WIDTH,
    height: POP_OUT_WINDOW_HEIGHT,
    focused: true
  });
  state.popupWindowId = createdWindow.id ?? null;
}

function urlsMatch(left, right) {
  return Boolean(left) && Boolean(right) && left === right;
}

function persistRoomState() {
  chrome.storage.local.set({
    roomId: state.roomId || "",
    roomTabId: state.roomTabId ?? null,
    shouldReconnectRoom: Boolean(state.shouldReconnectRoom && state.roomId)
  }).catch(() => {
    // Ignore storage write failures in the background worker.
  });
}
