// Content script that manages the blocking overlay and user controls on X.

const OVERLAY_ID = "x-underclass-overlay";
const DEFAULT_FALLBACK_STATE = {
  status: "idle",
  phase: "focus",
  focusMinutes: 25,
  breakMinutes: 5
};

let latestState = null;
let countdownInterval = null;
let saveStatusTimer = null;
let userOverlayActive = false;
let overlayElements = null;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize);
} else {
  initialize();
}

async function initialize() {
  latestState = await requestState();
  updateOverlay(latestState);
  subscribeToMessages();
  startCountdownTimer();
}

function subscribeToMessages() {
  chrome.runtime.onMessage.addListener(message => {
    if (!message?.type) return;

    if (message.type === "STATE_UPDATED") {
      const previous = latestState;
      latestState = message.state ?? null;

      if (enteredBreak(previous, latestState)) {
        userOverlayActive = false;
      }

      if (latestState?.status === "running" && latestState.phase === "focus") {
        userOverlayActive = true;
      }

      if (latestState?.status === "paused") {
        userOverlayActive = true;
      }

      updateOverlay(latestState);
      return;
    }

    if (message.type === "OPEN_CONTROLS") {
      if (message.state) {
        latestState = message.state;
      }
      userOverlayActive = true;
      updateOverlay(latestState ?? DEFAULT_FALLBACK_STATE);
    }
  });
}

function enteredBreak(previous, current) {
  return (
    previous?.status === "running" &&
    previous?.phase === "focus" &&
    current?.status === "running" &&
    current?.phase === "break"
  );
}

function startCountdownTimer() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }

  countdownInterval = setInterval(() => {
    if (!shouldDisplayOverlay(latestState)) return;
    renderCountdown(latestState);
  }, 1000);
}

async function requestState() {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: "GET_STATE" }, response => {
        resolve(response?.state ?? null);
      });
    } catch (error) {
      resolve(null);
    }
  });
}

function shouldDisplayOverlay(state) {
  if (userOverlayActive) return true;
  if (!state) return false;
  if (state.status === "running" && state.phase === "focus") return true;
  if (state.status === "paused") return true;
  return false;
}

function updateOverlay(state) {
  const effectiveState = state ?? DEFAULT_FALLBACK_STATE;
  if (!shouldDisplayOverlay(effectiveState)) {
    removeOverlay();
    return;
  }

  const overlay = ensureOverlay();
  if (!overlay) return;

  renderState(effectiveState);
  applyBlockedStyles();
  renderCountdown(effectiveState);
}

function ensureOverlay() {
  if (!document.body) return null;

  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.innerHTML = `
    <div class="x-underclass-backdrop"></div>
    <div class="x-underclass-modal" role="dialog" aria-modal="true">
      <button type="button" class="x-underclass-close" aria-label="Close focus overlay">×</button>
      <h1 class="x-underclass-title">Focus Time</h1>
      <p class="x-underclass-status">Idle</p>
      <div class="x-underclass-countdown">--:--</div>
      <form class="x-underclass-form">
        <label class="x-underclass-field">
          <span>Focus length (minutes)</span>
          <input id="x-underclass-focus-input" type="number" min="1" max="180" required />
        </label>
        <label class="x-underclass-field">
          <span>Break length (minutes)</span>
          <input id="x-underclass-break-input" type="number" min="1" max="120" required />
        </label>
        <button type="submit" class="x-underclass-save primary">Save Durations</button>
      </form>
      <div class="x-underclass-actions">
        <button type="button" class="primary" data-action="start">Start Focus</button>
        <button type="button" data-action="pause">Pause</button>
        <button type="button" data-action="resume">Resume</button>
        <button type="button" class="text" data-action="stop">Stop Session</button>
      </div>
      <p class="x-underclass-feedback" role="status" aria-live="polite"></p>
      <p class="x-underclass-hint">Stay on track. Twitter can wait.</p>
    </div>
  `;

  document.body.appendChild(overlay);
  cacheOverlayElements(overlay);
  attachEventHandlers();
  return overlay;
}

function cacheOverlayElements(overlay) {
  overlayElements = {
    overlay,
    closeButton: overlay.querySelector(".x-underclass-close"),
    status: overlay.querySelector(".x-underclass-status"),
    countdown: overlay.querySelector(".x-underclass-countdown"),
    focusInput: overlay.querySelector("#x-underclass-focus-input"),
    breakInput: overlay.querySelector("#x-underclass-break-input"),
    form: overlay.querySelector(".x-underclass-form"),
    saveButton: overlay.querySelector(".x-underclass-save"),
    feedback: overlay.querySelector(".x-underclass-feedback"),
    startButton: overlay.querySelector('[data-action="start"]'),
    pauseButton: overlay.querySelector('[data-action="pause"]'),
    resumeButton: overlay.querySelector('[data-action="resume"]'),
    stopButton: overlay.querySelector('[data-action="stop"]')
  };
}

function attachEventHandlers() {
  if (!overlayElements) return;

  overlayElements.closeButton.addEventListener("click", () => {
    if (latestState && (latestState.status === "running" || latestState.status === "paused")) {
      return;
    }
    userOverlayActive = false;
    removeOverlay();
  });

  overlayElements.form.addEventListener("submit", async event => {
    event.preventDefault();
    await saveDurations();
  });

  overlayElements.startButton.addEventListener("click", async () => {
    await startSession();
  });

  overlayElements.pauseButton.addEventListener("click", async () => {
    const state = await dispatch("PAUSE_SESSION");
    if (state) {
      latestState = state;
      renderState(state);
      renderCountdown(state);
    }
  });

  overlayElements.resumeButton.addEventListener("click", async () => {
    const state = await dispatch("RESUME_SESSION");
    if (state) {
      latestState = state;
      renderState(state);
      renderCountdown(state);
    }
  });

  overlayElements.stopButton.addEventListener("click", async () => {
    const state = await dispatch("STOP_SESSION");
    if (state) {
      latestState = state;
      userOverlayActive = false;
      removeOverlay();
    }
  });
}

function renderState(state) {
  if (!overlayElements) return;

  updateInput(overlayElements.focusInput, state.focusMinutes);
  updateInput(overlayElements.breakInput, state.breakMinutes);

  overlayElements.status.textContent = describeState(state);

  const isRunningFocus =
    state.status === "running" && state.phase === "focus";
  const isBreak = state.status === "running" && state.phase === "break";
  const isPaused = state.status === "paused";
  const isIdle = state.status === "idle";

  toggleHidden(overlayElements.startButton, !isIdle);
  toggleHidden(overlayElements.pauseButton, !isRunningFocus);
  toggleHidden(overlayElements.resumeButton, !isPaused);
  toggleHidden(overlayElements.stopButton, isIdle);
  toggleHidden(overlayElements.closeButton, isRunningFocus || isPaused);
}

function describeState(state) {
  if (!state) return "Idle";

  if (state.status === "running" && state.phase === "focus") {
    return "Focus session running";
  }

  if (state.status === "running" && state.phase === "break") {
    return "Break in progress";
  }

  if (state.status === "paused") {
    return "Session paused";
  }

  return "Idle";
}

function toggleHidden(element, hidden) {
  if (!element) return;
  element.classList.toggle("hidden", Boolean(hidden));
}

function updateInput(input, value) {
  if (!input) return;
  if (document.activeElement === input) return;
  input.value = value;
}

async function saveDurations() {
  const focusMinutes = sanitizeMinutes(
    overlayElements.focusInput.value,
    latestState?.focusMinutes
  );
  const breakMinutes = sanitizeMinutes(
    overlayElements.breakInput.value,
    latestState?.breakMinutes
  );

  const state = await dispatch("SET_DURATIONS", {
    focusMinutes,
    breakMinutes
  });

  if (state) {
    latestState = state;
    showFeedback("Durations saved");
    renderState(state);
    renderCountdown(state);
  }
}

async function startSession() {
  const focusMinutes = sanitizeMinutes(
    overlayElements.focusInput.value,
    latestState?.focusMinutes
  );
  const breakMinutes = sanitizeMinutes(
    overlayElements.breakInput.value,
    latestState?.breakMinutes
  );

  const state = await dispatch("START_SESSION", {
    focusMinutes,
    breakMinutes
  });

  if (state) {
    latestState = state;
    userOverlayActive = true;
    renderState(state);
    renderCountdown(state);
  }
}

function sanitizeMinutes(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed);
  }
  return fallback ?? DEFAULT_FALLBACK_STATE.focusMinutes;
}

function renderCountdown(state) {
  if (!overlayElements) return;
  const countdownEl = overlayElements.countdown;
  if (!countdownEl) return;

  const text = formatRemaining(state);
  countdownEl.textContent = text;
}

function formatRemaining(state) {
  if (!state) return "--:--";

  if (state.status === "paused") {
    const remaining = state.remainingMs ?? 0;
    return formatMs(remaining);
  }

  if (state.status === "running" && state.nextTransition) {
    const remaining = Math.max(0, state.nextTransition - Date.now());
    return formatMs(remaining);
  }

  return "--:--";
}

function formatMs(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0"
  )}`;
}

function showFeedback(message) {
  if (!overlayElements?.feedback) return;

  overlayElements.feedback.textContent = message;
  overlayElements.feedback.classList.add("visible");

  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer);
  }

  saveStatusTimer = setTimeout(() => {
    overlayElements.feedback.textContent = "";
    overlayElements.feedback.classList.remove("visible");
  }, 1500);
}

function removeOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) {
    overlay.remove();
  }
  overlayElements = null;
  clearBlockedStyles();
}

function applyBlockedStyles() {
  document.documentElement.classList.add("x-underclass-muted");
  document.body.classList.add("x-underclass-blocked");
}

function clearBlockedStyles() {
  document.documentElement.classList.remove("x-underclass-muted");
  document.body.classList.remove("x-underclass-blocked");
}

function dispatch(type, payload = {}) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type, ...payload }, response => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response?.state ?? null);
      });
    } catch (error) {
      resolve(null);
    }
  });
}
