if (!globalThis.__watchTogetherContentScriptLoaded) {
globalThis.__watchTogetherContentScriptLoaded = true;

const SMALL_DRIFT_SECONDS = 0.35;
const LARGE_DRIFT_SECONDS = 1.25;

let activeVideo = null;
let pendingPlayTimer = null;
let suppressLocalEventsUntil = 0;
let lastMediaKey = "";
let lastURL = location.href;
let lastUserInteractionAt = 0;
let lastRoomPauseKey = "";
let lastPrimedRoomKey = "";
let extensionContextValid = true;
let mutationObserver = null;
let pollingTimer = null;
const safeHandlePotentialMediaChange = withExtensionContextGuard(handlePotentialMediaChange);
let controlState = {
  inRoom: false,
  role: "viewer",
  currentPageUrl: "",
  roomMediaUrl: "",
  mediaMatches: false,
  requireManualPlay: false,
  canControlLocally: false,
  canApplyRemote: false
};

bootstrap();

function bootstrap() {
  selectAndBindVideo();
  mutationObserver = new MutationObserver(() => {
    if (!extensionContextValid) {
      return;
    }
    selectAndBindVideo();
  });
  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.addEventListener("popstate", safeHandlePotentialMediaChange);
  ["pointerdown", "keydown", "touchstart"].forEach((eventName) => {
    window.addEventListener(eventName, () => {
      lastUserInteractionAt = Date.now();
    }, true);
  });
  pollingTimer = setInterval(() => {
    if (!extensionContextValid) {
      shutdownContentScript();
      return;
    }
    if (location.href !== lastURL) {
      lastURL = location.href;
      handlePotentialMediaChange();
    }
    selectAndBindVideo();
  }, 1000);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "collect_status") {
    sendResponse({ ok: true, payload: collectStatus() });
    return true;
  }

  if (message?.type === "apply_remote_command") {
    if (!controlState.canApplyRemote) {
      sendResponse({ ok: false, reason: "remote control disabled for this page" });
      return true;
    }
    applyRemoteCommand(message.payload);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "set_control_state") {
    controlState = { ...controlState, ...message.payload };
    if (!controlState.inRoom) {
      lastRoomPauseKey = "";
      lastPrimedRoomKey = "";
    }
    if (!controlState.canApplyRemote && pendingPlayTimer) {
      clearTimeout(pendingPlayTimer);
      pendingPlayTimer = null;
    }
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

function selectAndBindVideo() {
  const nextVideo = findBestVideo();
  if (nextVideo === activeVideo) {
    return;
  }

  unbindVideo();
  activeVideo = nextVideo;
  if (!activeVideo) {
    reportStatus();
    return;
  }

  bindVideo(activeVideo);
  handlePotentialMediaChange();
}

function findBestVideo() {
  const videos = [...document.querySelectorAll("video")];
  if (!videos.length) {
    return null;
  }

  return videos
    .filter((video) => video.isConnected)
    .sort((left, right) => visibleArea(right) - visibleArea(left))[0] || null;
}

function visibleArea(video) {
  const rect = video.getBoundingClientRect();
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function bindVideo(video) {
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  video.addEventListener("seeked", onSeeked);
  video.addEventListener("ratechange", onRateChange);
  video.addEventListener("loadedmetadata", safeHandlePotentialMediaChange);
  video.addEventListener("loadeddata", safeHandlePotentialMediaChange);
  video.addEventListener("canplay", safeHandlePotentialMediaChange);
  video.addEventListener("canplaythrough", safeHandlePotentialMediaChange);
  video.addEventListener("progress", safeHandlePotentialMediaChange);
  video.addEventListener("waiting", safeHandlePotentialMediaChange);
  video.addEventListener("stalled", safeHandlePotentialMediaChange);
  video.addEventListener("durationchange", safeHandlePotentialMediaChange);
  video.addEventListener("emptied", safeHandlePotentialMediaChange);
}

function unbindVideo() {
  if (!activeVideo) {
    return;
  }
  activeVideo.removeEventListener("play", onPlay);
  activeVideo.removeEventListener("pause", onPause);
  activeVideo.removeEventListener("seeked", onSeeked);
  activeVideo.removeEventListener("ratechange", onRateChange);
  activeVideo.removeEventListener("loadedmetadata", safeHandlePotentialMediaChange);
  activeVideo.removeEventListener("loadeddata", safeHandlePotentialMediaChange);
  activeVideo.removeEventListener("canplay", safeHandlePotentialMediaChange);
  activeVideo.removeEventListener("canplaythrough", safeHandlePotentialMediaChange);
  activeVideo.removeEventListener("progress", safeHandlePotentialMediaChange);
  activeVideo.removeEventListener("waiting", safeHandlePotentialMediaChange);
  activeVideo.removeEventListener("stalled", safeHandlePotentialMediaChange);
  activeVideo.removeEventListener("durationchange", safeHandlePotentialMediaChange);
  activeVideo.removeEventListener("emptied", safeHandlePotentialMediaChange);
}

function onPlay() {
  if (shouldIgnoreLocalEvent() || !controlState.canControlLocally) {
    return;
  }

  if (controlState.requireManualPlay && Date.now() - lastUserInteractionAt > 2000) {
    suppressEvents(400);
    activeVideo.pause();
    reportStatus();
    return;
  }

  // Host play is converted into a scheduled start, so we immediately pause and
  // wait for the server-timed play command to come back.
  suppressEvents(400);
  activeVideo.pause();
  emitEvent("play");
}

function onPause() {
  if (shouldIgnoreLocalEvent() || !controlState.canControlLocally) {
    return;
  }

  emitEvent("pause");
}

function onSeeked() {
  if (shouldIgnoreLocalEvent() || !controlState.canControlLocally) {
    return;
  }

  emitEvent("seek", { resumeAfterSeek: !activeVideo.paused });
}

function onRateChange() {
  if (shouldIgnoreLocalEvent() || !controlState.canControlLocally) {
    return;
  }

  emitEvent("rate_change");
}

function handlePotentialMediaChange() {
  if (!extensionContextValid) {
    return;
  }

  try {
  const status = collectStatus();
  if (!status.hasVideo) {
    sendRuntimeMessageSafely({ type: "content_status", payload: status });
    return;
  }

  if (status.media.mediaKey !== lastMediaKey) {
    lastMediaKey = status.media.mediaKey;
  }

  maybePrimeViewerVideo(status);
  maybePauseForRoomSync(status);
  sendRuntimeMessageSafely({ type: "content_status", payload: status });
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      invalidateExtensionContext();
      return;
    }
    throw error;
  }
}

function emitEvent(event, extra = {}) {
  if (!extensionContextValid) {
    return;
  }

  sendRuntimeMessageSafely({
    type: "content_event",
    payload: {
      event,
      currentTime: activeVideo?.currentTime || 0,
      playbackRate: activeVideo?.playbackRate || 1,
      media: buildMediaState(),
      ...extra
    }
  });
  reportStatus();
}

function maybePauseForRoomSync(status) {
  if (!activeVideo || activeVideo.paused || !controlState.inRoom) {
    return;
  }

  const pageUrl = status?.media?.pageUrl || "";
  const roomMediaUrl = controlState.roomMediaUrl || "";
  if (!pageUrl) {
    return;
  }
  if (roomMediaUrl && roomMediaUrl !== pageUrl) {
    return;
  }

  const pauseKey = `${pageUrl}|${roomMediaUrl || "bootstrap"}`;
  if (pauseKey === lastRoomPauseKey) {
    return;
  }

  lastRoomPauseKey = pauseKey;
  suppressEvents(400);
  activeVideo.pause();
}

function maybePrimeViewerVideo(status) {
  if (!activeVideo || !status?.hasVideo || !controlState.inRoom || controlState.canControlLocally) {
    return;
  }

  const pageUrl = status.media?.pageUrl || "";
  const roomMediaUrl = controlState.roomMediaUrl || "";
  if (!pageUrl || !roomMediaUrl || roomMediaUrl !== pageUrl) {
    return;
  }
  if ((status.readyState || 0) < HTMLMediaElement.HAVE_FUTURE_DATA) {
    return;
  }

  const primeKey = `${roomMediaUrl}|${status.media?.mediaKey || ""}`;
  if (primeKey === lastPrimedRoomKey) {
    return;
  }
  lastPrimedRoomKey = primeKey;

  queueMicrotask(() => {
    primeViewerVideo().catch((error) => {
      console.debug("Viewer prime skipped", error);
    });
  });
}

async function primeViewerVideo() {
  if (!activeVideo || !extensionContextValid) {
    return;
  }

  suppressEvents(700);
  try {
    await activeVideo.play();
  } catch (error) {
    return;
  }

  setTimeout(() => {
    if (!activeVideo || !extensionContextValid) {
      return;
    }
    suppressEvents(500);
    activeVideo.currentTime = 0;
    activeVideo.pause();
  }, 120);
}

function collectStatus() {
  if (!activeVideo) {
    return {
      hasVideo: false,
      paused: true,
      currentTime: 0,
      playbackRate: 1,
      media: buildMediaState()
    };
  }

  return {
    hasVideo: true,
    paused: activeVideo.paused,
    currentTime: activeVideo.currentTime,
    playbackRate: activeVideo.playbackRate,
    duration: activeVideo.duration,
    isBufferedReady: isBufferedReady(activeVideo),
    bufferedAheadSeconds: bufferedAheadSeconds(activeVideo),
    readyState: activeVideo.readyState,
    media: buildMediaState()
  };
}

function buildMediaState() {
  const video = activeVideo;
  const currentSrc = video?.currentSrc || "";
  const duration = Number.isFinite(video?.duration) ? Number(video.duration.toFixed(3)) : 0;
  const normalizedURL = normalizeURL(location.href);
  const mediaKey = normalizedURL;

  return {
    pageUrl: normalizedURL,
    pageTitle: document.title,
    currentSrc,
    duration,
    mediaKey
  };
}

function normalizeURL(rawURL) {
  try {
    const url = new URL(rawURL);
    url.hash = "";
    if (url.hostname === "www.youtube.com" || url.hostname === "youtube.com") {
      if (url.pathname === "/watch") {
        const videoID = url.searchParams.get("v");
        url.search = "";
        if (videoID) {
          url.searchParams.set("v", videoID);
        }
        return url.toString();
      }
      if (url.pathname.startsWith("/shorts/")) {
        const shortID = url.pathname.split("/").filter(Boolean)[1] || "";
        url.search = "";
        url.pathname = shortID ? `/shorts/${shortID}` : url.pathname;
        return url.toString();
      }
    }
    if (url.hostname === "youtu.be") {
      const pathParts = url.pathname.split("/").filter(Boolean);
      url.search = "";
      url.pathname = pathParts.length ? `/${pathParts[0]}` : url.pathname;
      return url.toString();
    }
    return url.toString();
  } catch (error) {
    return rawURL;
  }
}

function isBufferedReady(video) {
  if (!video) {
    return false;
  }

  if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    return true;
  }

  const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);
    if (currentTime >= start && currentTime + 0.5 <= end) {
      return true;
    }
  }

  return false;
}

function bufferedAheadSeconds(video) {
  if (!video) {
    return 0;
  }

  const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);
    if (currentTime >= start && currentTime <= end) {
      return Math.max(0, end - currentTime);
    }
  }

  return 0;
}

function shouldIgnoreLocalEvent() {
  return !activeVideo || Date.now() < suppressLocalEventsUntil;
}

function suppressEvents(ms) {
  suppressLocalEventsUntil = Date.now() + ms;
}

function applyRemoteCommand(command) {
  if (!activeVideo) {
    return;
  }

  clearTimeout(pendingPlayTimer);
  pendingPlayTimer = null;

  switch (command.type) {
    case "scheduled_play":
      setPlaybackRate(command.payload.playbackRate);
      hardSeek(command.payload.targetTimeSeconds);
      schedulePlay(
        command.payload.startAtLocalTime,
        command.payload.targetTimeSeconds,
        command.payload.playbackRate
      );
      break;
    case "pause":
      if (Math.abs(activeVideo.currentTime - command.payload.positionSeconds) > SMALL_DRIFT_SECONDS) {
        hardSeek(command.payload.positionSeconds);
      }
      suppressEvents(300);
      activeVideo.pause();
      break;
    case "seek":
      setPlaybackRate(command.payload.playbackRate);
      hardSeek(command.payload.targetTimeSeconds);
      if (command.payload.resumeAfterSeek) {
        schedulePlay(
          command.payload.startAtLocalTime || Date.now(),
          command.payload.targetTimeSeconds,
          command.payload.playbackRate
        );
      } else {
        suppressEvents(300);
        activeVideo.pause();
      }
      break;
    case "rate_change":
      setPlaybackRate(command.payload.playbackRate);
      if (Math.abs(activeVideo.currentTime - command.payload.positionSeconds) > LARGE_DRIFT_SECONDS) {
        hardSeek(command.payload.positionSeconds);
      }
      break;
    case "sync_to_state":
      syncToRoomState(command.payload.roomState, command.payload.startAtLocalTime);
      break;
    default:
      break;
  }

  reportStatus();
}

function schedulePlay(startAtLocalTime, targetTimeSeconds, playbackRate) {
  const delay = Math.max(0, (startAtLocalTime || Date.now()) - Date.now());
  suppressEvents(delay + 400);
  activeVideo.pause();
  pendingPlayTimer = setTimeout(async () => {
    try {
      await startPlaybackWithActivationFallback();
      setTimeout(() => {
        nudgePlaybackAfterStart(startAtLocalTime, targetTimeSeconds, playbackRate);
      }, 250);
    } catch (error) {
      console.warn("Scheduled play failed", error);
    }
  }, delay);
}

function syncToRoomState(roomState, startAtLocalTime) {
  if (!roomState) {
    return;
  }

  const playback = roomState.playback;
  setPlaybackRate(playback.playbackRate);

  if (!playback.playing) {
    if (Math.abs(activeVideo.currentTime - playback.positionSeconds) > SMALL_DRIFT_SECONDS) {
      hardSeek(playback.positionSeconds);
    }
    suppressEvents(300);
    activeVideo.pause();
    return;
  }

  if (playback.scheduledStartAtMs && startAtLocalTime && startAtLocalTime > Date.now()) {
    hardSeek(playback.positionSeconds);
    schedulePlay(startAtLocalTime, playback.positionSeconds, playback.playbackRate);
    return;
  }

  const expected = playback.positionSeconds;
  const drift = activeVideo.currentTime - expected;
  if (Math.abs(drift) > LARGE_DRIFT_SECONDS) {
    hardSeek(expected);
  } else if (Math.abs(drift) > SMALL_DRIFT_SECONDS) {
    const adjustment = drift > 0 ? -0.08 : 0.08;
    setPlaybackRate(clamp(playback.playbackRate + adjustment, 0.25, 4));
    setTimeout(() => setPlaybackRate(playback.playbackRate), 1500);
  }

  if (activeVideo.paused) {
    schedulePlay(Date.now() + 50, expected, playback.playbackRate);
  }
}

function nudgePlaybackAfterStart(startAtLocalTime, targetTimeSeconds, playbackRate) {
  if (!activeVideo || activeVideo.paused) {
    return;
  }

  const expectedPosition = (targetTimeSeconds || 0)
    + (Math.max(0, Date.now() - (startAtLocalTime || Date.now())) / 1000) * (playbackRate || 1);
  const drift = activeVideo.currentTime - expectedPosition;

  if (Math.abs(drift) > LARGE_DRIFT_SECONDS) {
    hardSeek(expectedPosition);
    return;
  }

  if (Math.abs(drift) > 0.15) {
    const adjustment = drift > 0 ? -0.12 : 0.12;
    setPlaybackRate(clamp((playbackRate || 1) + adjustment, 0.25, 4));
    setTimeout(() => setPlaybackRate(playbackRate || 1), 1200);
  }
}

async function startPlaybackWithActivationFallback() {
  try {
    await activeVideo.play();
    return;
  } catch (error) {
    console.warn("Direct play failed, trying player activation fallback", error);
  }

  const activationTarget = findActivationTarget();
  if (activationTarget) {
    fireSyntheticClick(activationTarget);
    await wait(120);
  }

  await activeVideo.play();
}

function findActivationTarget() {
  if (!activeVideo) {
    return null;
  }

  const videoRect = activeVideo.getBoundingClientRect();
  const centerX = videoRect.left + (videoRect.width / 2);
  const centerY = videoRect.top + (videoRect.height / 2);
  const candidates = [...document.querySelectorAll("button, [role='button'], .play, .play-button, .vjs-big-play-button")];

  return candidates
    .filter((candidate) => isElementVisible(candidate))
    .map((candidate) => ({
      candidate,
      score: activationScore(candidate, centerX, centerY)
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.candidate || null;
}

function activationScore(element, centerX, centerY) {
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    return 0;
  }

  const text = [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.textContent,
    element.className
  ].join(" ").toLowerCase();

  let score = 0;
  if (text.includes("play") || text.includes("start") || text.includes("resume")) {
    score += 10;
  }

  const elementCenterX = rect.left + (rect.width / 2);
  const elementCenterY = rect.top + (rect.height / 2);
  const distance = Math.hypot(centerX - elementCenterX, centerY - elementCenterY);
  score += Math.max(0, 500 - distance) / 25;

  if (rect.width > 30 && rect.height > 30) {
    score += 2;
  }

  return score;
}

function isElementVisible(element) {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden"
    && style.display !== "none"
    && rect.width > 0
    && rect.height > 0;
}

function fireSyntheticClick(element) {
  ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
    element.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    }));
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hardSeek(targetTime) {
  suppressEvents(350);
  activeVideo.currentTime = Math.max(0, targetTime || 0);
}

function setPlaybackRate(rate) {
  suppressEvents(250);
  activeVideo.playbackRate = rate || 1;
}

function reportStatus() {
  if (!extensionContextValid) {
    return;
  }
  sendRuntimeMessageSafely({ type: "content_status", payload: collectStatus() });
}

function sendRuntimeMessageSafely(message) {
  if (!extensionContextValid) {
    return;
  }

  try {
    const sendPromise = chrome.runtime.sendMessage(message);
    if (sendPromise && typeof sendPromise.catch === "function") {
      sendPromise.catch((error) => {
        if (isExtensionContextInvalidatedError(error)) {
          invalidateExtensionContext();
          return;
        }
        console.debug("Runtime message failed", error);
      });
    }
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) {
      invalidateExtensionContext();
      return;
    }
    console.debug("Runtime message failed", error);
  }
}

function isExtensionContextInvalidatedError(error) {
  return String(error?.message || error || "").includes("Extension context invalidated");
}

function invalidateExtensionContext() {
  if (!extensionContextValid) {
    return;
  }
  extensionContextValid = false;
  shutdownContentScript();
}

function withExtensionContextGuard(fn) {
  return (...args) => {
    if (!extensionContextValid) {
      return;
    }

    try {
      return fn(...args);
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        invalidateExtensionContext();
        return;
      }
      throw error;
    }
  };
}

function shutdownContentScript() {
  if (pendingPlayTimer) {
    clearTimeout(pendingPlayTimer);
    pendingPlayTimer = null;
  }
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
  unbindVideo();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
}
