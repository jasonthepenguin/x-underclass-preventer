// Background service worker controlling Pomodoro state and alarms.

const DEFAULT_FOCUS_MINUTES = 25;
const DEFAULT_BREAK_MINUTES = 5;

const STORAGE_KEY = "xUnderclassPomodoroState";
const ALARM_NAME = "pomodoroTransition";

const DEFAULT_STATE = {
  status: "idle", // idle | running | paused
  phase: "focus", // focus | break
  focusMinutes: DEFAULT_FOCUS_MINUTES,
  breakMinutes: DEFAULT_BREAK_MINUTES,
  cycleStart: null,
  nextTransition: null,
  remainingMs: null
};

chrome.runtime.onStartup.addListener(initializeState);
chrome.runtime.onInstalled.addListener(initializeState);
chrome.alarms.onAlarm.addListener(handleAlarm);
chrome.action.onClicked.addListener(handleActionClick);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request?.type) return false;

  switch (request.type) {
    case "GET_STATE":
      ensureState()
        .then(state => sendResponse({ state }))
        .catch(() => sendResponse({ state: { ...DEFAULT_STATE } }));
      return true;
    case "SET_DURATIONS":
      setDurations(request.focusMinutes, request.breakMinutes)
        .then(state => sendResponse({ state }))
        .catch(() => sendResponse({ state: null }));
      return true;
    case "START_SESSION":
      startSession(request.focusMinutes, request.breakMinutes)
        .then(state => sendResponse({ state }))
        .catch(() => sendResponse({ state: null }));
      return true;
    case "PAUSE_SESSION":
      pauseSession()
        .then(state => sendResponse({ state }))
        .catch(() => sendResponse({ state: null }));
      return true;
    case "RESUME_SESSION":
      resumeSession()
        .then(state => sendResponse({ state }))
        .catch(() => sendResponse({ state: null }));
      return true;
    case "STOP_SESSION":
      stopSession()
        .then(state => sendResponse({ state }))
        .catch(() => sendResponse({ state: null }));
      return true;
    default:
      return false;
  }
});

async function initializeState() {
  const state = await ensureState();
  const normalized = await normalizeState(state);
  await saveState(normalized);
  scheduleAlarm(normalized);
}

async function ensureState() {
  const stored = await loadState();
  if (stored) {
    return { ...DEFAULT_STATE, ...stored };
  }

  await saveState({ ...DEFAULT_STATE });
  return { ...DEFAULT_STATE };
}

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] ?? null;
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function scheduleAlarm(state) {
  if (state.status !== "running" || !state.nextTransition) {
    chrome.alarms.clear(ALARM_NAME);
    return;
  }

  const when = Math.max(Date.now() + 200, state.nextTransition);
  chrome.alarms.create(ALARM_NAME, { when });
}

async function handleAlarm(alarm) {
  if (alarm.name !== ALARM_NAME) return;

  const state = await ensureState();
  const normalized = await normalizeState(state);
  await saveState(normalized);

  if (normalized.status !== "running" || !normalized.nextTransition) {
    scheduleAlarm(normalized);
    return;
  }

  if (normalized.nextTransition > Date.now()) {
    scheduleAlarm(normalized);
    return;
  }

  const advanced = advancePhase(normalized);
  await saveState(advanced);
  await broadcastState(advanced);
  scheduleAlarm(advanced);
}

async function setDurations(focusMinutes, breakMinutes) {
  const state = await ensureState();
  const focusMs = toMs(focusMinutes ?? state.focusMinutes);
  const breakMs = toMs(breakMinutes ?? state.breakMinutes);

  let updated = {
    ...state,
    focusMinutes: minutesFromMs(focusMs),
    breakMinutes: minutesFromMs(breakMs)
  };

  if (state.status === "running") {
    updated = adjustRunningDurations(updated, focusMs, breakMs);
  } else if (state.status === "paused") {
    const durationMs = updated.phase === "focus" ? focusMs : breakMs;
    const remaining = Math.min(state.remainingMs ?? durationMs, durationMs);
    updated = {
      ...updated,
      remainingMs: remaining
    };
  }

  await saveState(updated);
  await broadcastState(updated);
  scheduleAlarm(updated);
  return updated;
}

async function startSession(focusMinutes, breakMinutes) {
  const state = await ensureState();
  const focusMs = toMs(focusMinutes ?? state.focusMinutes);
  const breakMs = toMs(breakMinutes ?? state.breakMinutes);
  const now = Date.now();

  const updated = {
    ...state,
    status: "running",
    phase: "focus",
    focusMinutes: minutesFromMs(focusMs),
    breakMinutes: minutesFromMs(breakMs),
    cycleStart: now,
    nextTransition: now + focusMs,
    remainingMs: null
  };

  await saveState(updated);
  await broadcastState(updated);
  scheduleAlarm(updated);
  return updated;
}

async function pauseSession() {
  const state = await ensureState();
  if (state.status !== "running" || !state.nextTransition) {
    return state;
  }

  const remainingMs = Math.max(0, state.nextTransition - Date.now());
  const updated = {
    ...state,
    status: "paused",
    nextTransition: null,
    remainingMs
  };

  await saveState(updated);
  await broadcastState(updated);
  scheduleAlarm(updated);
  return updated;
}

async function resumeSession() {
  const state = await ensureState();
  if (state.status !== "paused") {
    return state;
  }

  const focusMs = toMs(state.focusMinutes);
  const breakMs = toMs(state.breakMinutes);
  const durationMs = state.phase === "focus" ? focusMs : breakMs;

  const remainingMs = Math.min(
    state.remainingMs ?? durationMs,
    durationMs
  );

  const now = Date.now();
  const cycleStart = Math.max(0, now - (durationMs - remainingMs));

  const updated = {
    ...state,
    status: "running",
    cycleStart,
    nextTransition: now + remainingMs,
    remainingMs: null
  };

  await saveState(updated);
  await broadcastState(updated);
  scheduleAlarm(updated);
  return updated;
}

async function stopSession() {
  const state = await ensureState();
  const updated = {
    ...state,
    status: "idle",
    phase: "focus",
    cycleStart: null,
    nextTransition: null,
    remainingMs: null
  };
  await saveState(updated);
  await broadcastState(updated);
  scheduleAlarm(updated);
  return updated;
}

function adjustRunningDurations(state, focusMs, breakMs) {
  const now = Date.now();
  const durationMs = state.phase === "focus" ? focusMs : breakMs;
  const elapsed = Math.max(0, now - (state.cycleStart ?? now));
  const clampedElapsed = Math.min(elapsed, durationMs);
  const remaining = Math.max(0, durationMs - clampedElapsed);

  return {
    ...state,
    cycleStart: now - clampedElapsed,
    nextTransition: now + remaining
  };
}

async function normalizeState(state) {
  const normalized = { ...DEFAULT_STATE, ...state };

  if (normalized.status !== "running" || !normalized.nextTransition) {
    return normalized;
  }

  const focusMs = toMs(normalized.focusMinutes);
  const breakMs = toMs(normalized.breakMinutes);

  let { phase, cycleStart, nextTransition } = normalized;
  const now = Date.now();

  while (nextTransition !== null && nextTransition <= now) {
    if (phase === "focus") {
      phase = "break";
      cycleStart = nextTransition;
      nextTransition = cycleStart + breakMs;
    } else {
      phase = "focus";
      cycleStart = nextTransition;
      nextTransition = cycleStart + focusMs;
    }
  }

  return {
    ...normalized,
    phase,
    cycleStart,
    nextTransition
  };
}

function advancePhase(state) {
  const now = Date.now();
  const nextPhase = state.phase === "focus" ? "break" : "focus";
  const durationMs =
    nextPhase === "focus"
      ? toMs(state.focusMinutes)
      : toMs(state.breakMinutes);

  return {
    ...state,
    status: "running",
    phase: nextPhase,
    cycleStart: now,
    nextTransition: now + durationMs,
    remainingMs: null
  };
}

function toMs(minutes) {
  const parsed = Number(minutes);
  return Math.max(1, Math.round(parsed || 0)) * 60 * 1000;
}

function minutesFromMs(ms) {
  return Math.max(1, Math.round(ms / (60 * 1000)));
}

async function broadcastState(state) {
  try {
    chrome.runtime.sendMessage({ type: "STATE_UPDATED", state });
  } catch (error) {
    // ignore runtime message errors
  }

  try {
    const tabs = await chrome.tabs.query({
      url: [
        "https://x.com/*",
        "https://www.x.com/*",
        "https://twitter.com/*",
        "https://www.twitter.com/*"
      ]
    });

    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "STATE_UPDATED", state });
    }
  } catch (error) {
    // ignore broadcast failures
  }
}

async function handleActionClick(tab) {
  if (!tab?.id || !tab.url) return;
  if (!isSupportedUrl(tab.url)) return;

  try {
    const state = await ensureState();
    chrome.tabs.sendMessage(tab.id, {
      type: "OPEN_CONTROLS",
      state
    });
  } catch (error) {
    // best effort; ignore if content script is unreachable
  }
}

function isSupportedUrl(url) {
  return /^https:\/\/(www\.)?(x|twitter)\.com\//.test(url ?? "");
}
