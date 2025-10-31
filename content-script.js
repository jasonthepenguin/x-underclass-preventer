// Content script that manages the blocking overlay and user controls on X.

const OVERLAY_ID = "x-underclass-overlay";
const BREAK_BADGE_ID = "x-underclass-break-badge";
const DEFAULT_FALLBACK_STATE = {
  status: "idle",
  phase: "focus",
  focusMinutes: 25,
  breakMinutes: 5
};

let latestState = null;
let countdownInterval = null;
let feedbackTimer = null;
let userOverlayActive = false;
let overlayElements = null;
let isActionInProgress = false;
let audioContext = null;
let shortcuts = [];
let settingsPanelVisible = false;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initialize);
} else {
  initialize();
}

window.addEventListener("beforeunload", () => {
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }
});

async function initialize() {
  latestState = await requestState();
  shortcuts = await loadShortcuts();
  updateOverlay(latestState);
  renderBreakBadge(latestState);
  subscribeToMessages();
  startCountdownTimer();
}

function playNotificationSound() {
  try {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }

    const now = audioContext.currentTime;
    const oscillator1 = audioContext.createOscillator();
    const oscillator2 = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator1.connect(gainNode);
    oscillator2.connect(gainNode);
    gainNode.connect(audioContext.destination);

    // Two-tone chime: E5 (659.25 Hz) and A5 (880 Hz)
    oscillator1.frequency.setValueAtTime(659.25, now);
    oscillator2.frequency.setValueAtTime(880, now);

    oscillator1.type = "sine";
    oscillator2.type = "sine";

    // Volume envelope: fade in and fade out
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.3, now + 0.05);
    gainNode.gain.linearRampToValueAtTime(0.3, now + 0.3);
    gainNode.gain.linearRampToValueAtTime(0, now + 0.6);

    oscillator1.start(now);
    oscillator2.start(now);
    oscillator1.stop(now + 0.6);
    oscillator2.stop(now + 0.6);
  } catch (error) {
    // Silently fail if audio not supported
  }
}

function subscribeToMessages() {
  chrome.runtime.onMessage.addListener(message => {
    if (!message?.type) return;

    if (message.type === "STATE_UPDATED") {
      const previous = latestState;
      latestState = message.state ?? null;

      if (previous?.status !== latestState?.status || previous?.phase !== latestState?.phase) {
        if (enteredBreak(previous, latestState)) {
          userOverlayActive = false;
          playNotificationSound();
        }

        if (enteredFocus(previous, latestState) || latestState?.status === "paused") {
          userOverlayActive = true;
          // Play sound when break ends and new focus begins automatically
          if (enteredFocusFromBreak(previous, latestState)) {
            playNotificationSound();
          }
        }

        if (latestState?.status === "break_ready") {
          userOverlayActive = true;
          playNotificationSound();
        }
      }

      updateOverlay(latestState);
      renderBreakBadge(latestState);
      return;
    }

    if (message.type === "OPEN_CONTROLS") {
      if (message.state) {
        latestState = message.state;
      }
      userOverlayActive = true;
      updateOverlay(latestState ?? DEFAULT_FALLBACK_STATE);
      renderBreakBadge(latestState ?? DEFAULT_FALLBACK_STATE);
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

function enteredFocus(previous, current) {
  return (
    current?.status === "running" &&
    current?.phase === "focus" &&
    (previous?.phase !== "focus" || previous?.status !== "running")
  );
}

function enteredFocusFromBreak(previous, current) {
  return (
    previous?.status === "running" &&
    previous?.phase === "break" &&
    current?.status === "running" &&
    current?.phase === "focus"
  );
}

function startCountdownTimer() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
  }

  countdownInterval = setInterval(() => {
    if (!latestState) {
      removeBreakBadge();
      return;
    }

    if (shouldDisplayOverlay(latestState)) {
      renderCountdown(latestState);
    }

    renderBreakBadge(latestState);
  }, 1000);
}

async function requestState() {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: "GET_STATE" }, response => {
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

function shouldDisplayOverlay(state) {
  if (!state) return userOverlayActive;
  if (state.status === "break_ready") return true;
  if (state.status === "running" && state.phase === "focus") return true;
  if (state.status === "paused") return true;
  if (userOverlayActive) return true;
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
      <button type="button" class="x-underclass-settings-btn" aria-label="Settings" title="Settings">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </button>
      <button type="button" class="x-underclass-close" aria-label="Close focus overlay">×</button>
      <h1 class="x-underclass-title">Focus Time</h1>
      <p class="x-underclass-status">Idle</p>
      <div class="x-underclass-countdown">--:--</div>
      <div class="x-underclass-form">
        <label class="x-underclass-field">
          <span>Focus</span>
          <input id="x-underclass-focus-input" type="number" min="1" max="180" required />
        </label>
        <label class="x-underclass-field">
          <span>Break</span>
          <input id="x-underclass-break-input" type="number" min="1" max="120" required />
        </label>
      </div>
      <div class="x-underclass-actions">
        <button type="button" class="primary" data-action="start">Start Focus</button>
        <button type="button" class="primary" data-action="start-break">Start Break</button>
        <button type="button" data-action="pause">Pause</button>
        <button type="button" data-action="resume">Resume</button>
        <button type="button" class="text" data-action="stop">Stop Session</button>
      </div>
      <p class="x-underclass-feedback" role="status" aria-live="polite"></p>
      <p class="x-underclass-hint">Stay focused. You can relax post AGI</p>
    </div>
    <div class="x-underclass-settings-panel hidden">
      <div class="x-underclass-settings-header">
        <h2>Shortcuts</h2>
        <button type="button" class="x-underclass-settings-close" aria-label="Close settings">×</button>
      </div>
      <div class="x-underclass-settings-content">
        <div class="x-underclass-shortcuts-list"></div>
        <div class="x-underclass-shortcut-form">
          <input type="text" class="x-underclass-shortcut-name" placeholder="Name" />
          <input type="url" class="x-underclass-shortcut-url" placeholder="URL" />
          <button type="button" class="x-underclass-add-shortcut">Add Shortcut</button>
        </div>
      </div>
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
    settingsBtn: overlay.querySelector(".x-underclass-settings-btn"),
    settingsPanel: overlay.querySelector(".x-underclass-settings-panel"),
    settingsClose: overlay.querySelector(".x-underclass-settings-close"),
    shortcutsList: overlay.querySelector(".x-underclass-shortcuts-list"),
    shortcutNameInput: overlay.querySelector(".x-underclass-shortcut-name"),
    shortcutUrlInput: overlay.querySelector(".x-underclass-shortcut-url"),
    addShortcutBtn: overlay.querySelector(".x-underclass-add-shortcut"),
    status: overlay.querySelector(".x-underclass-status"),
    countdown: overlay.querySelector(".x-underclass-countdown"),
    focusInput: overlay.querySelector("#x-underclass-focus-input"),
    breakInput: overlay.querySelector("#x-underclass-break-input"),
    feedback: overlay.querySelector(".x-underclass-feedback"),
    startButton: overlay.querySelector('[data-action="start"]'),
    startBreakButton: overlay.querySelector('[data-action="start-break"]'),
    pauseButton: overlay.querySelector('[data-action="pause"]'),
    resumeButton: overlay.querySelector('[data-action="resume"]'),
    stopButton: overlay.querySelector('[data-action="stop"]')
  };
}

function attachEventHandlers() {
  if (!overlayElements) return;

  overlayElements.settingsBtn.addEventListener("click", () => {
    toggleSettingsPanel();
  });

  overlayElements.settingsClose.addEventListener("click", () => {
    toggleSettingsPanel();
  });

  overlayElements.addShortcutBtn.addEventListener("click", async () => {
    await addShortcut();
  });

  overlayElements.closeButton.addEventListener("click", () => {
    if (latestState &&
        ((latestState.status === "running" && latestState.phase === "focus") ||
         latestState.status === "paused")) {
      return;
    }
    userOverlayActive = false;
    removeOverlay();
  });

  overlayElements.focusInput.addEventListener("change", async () => {
    await saveDurations();
  });

  overlayElements.breakInput.addEventListener("change", async () => {
    await saveDurations();
  });

  overlayElements.startButton.addEventListener("click", async () => {
    await startSession();
  });

  overlayElements.startBreakButton.addEventListener("click", async () => {
    await beginBreak();
  });

  overlayElements.pauseButton.addEventListener("click", async () => {
    if (isActionInProgress) return;
    isActionInProgress = true;
    setButtonsDisabled(true);

    const state = await dispatch("PAUSE_SESSION");
    if (state) {
      latestState = state;
      renderState(state);
      renderCountdown(state);
    }

    isActionInProgress = false;
    setButtonsDisabled(false);
  });

  overlayElements.resumeButton.addEventListener("click", async () => {
    if (isActionInProgress) return;
    isActionInProgress = true;
    setButtonsDisabled(true);

    const state = await dispatch("RESUME_SESSION");
    if (state) {
      latestState = state;
      renderState(state);
      renderCountdown(state);
    }

    isActionInProgress = false;
    setButtonsDisabled(false);
  });

  overlayElements.stopButton.addEventListener("click", async () => {
    if (isActionInProgress) return;
    isActionInProgress = true;
    setButtonsDisabled(true);

    const state = await dispatch("STOP_SESSION");
    if (state) {
      latestState = state;
      userOverlayActive = false;
      removeOverlay();
    }

    isActionInProgress = false;
    setButtonsDisabled(false);
  });
}

function renderState(state) {
  if (!overlayElements) return;

  updateInput(overlayElements.focusInput, state.focusMinutes);
  updateInput(overlayElements.breakInput, state.breakMinutes);

  overlayElements.status.textContent = describeState(state);

  const isRunningFocus =
    state.status === "running" && state.phase === "focus";
  const isBreakRunning = state.status === "running" && state.phase === "break";
  const isBreakReady = state.status === "break_ready";
  const isPaused = state.status === "paused";
  const isIdle = state.status === "idle";

  toggleHidden(overlayElements.startButton, !isIdle);
  toggleHidden(overlayElements.startBreakButton, !isBreakReady);
  toggleHidden(overlayElements.pauseButton, !isRunningFocus);
  toggleHidden(overlayElements.resumeButton, !isPaused);
  toggleHidden(overlayElements.stopButton, isIdle && !isBreakReady && !isBreakRunning);
  toggleHidden(overlayElements.closeButton, isRunningFocus || isPaused || isBreakReady);
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

  if (state.status === "break_ready") {
    return "Focus complete - you may goon";
  }

  return "Idle";
}

function toggleHidden(element, hidden) {
  if (!element) return;
  element.classList.toggle("hidden", Boolean(hidden));
}

function setButtonsDisabled(disabled) {
  if (!overlayElements) return;
  const buttons = [
    overlayElements.startButton,
    overlayElements.startBreakButton,
    overlayElements.pauseButton,
    overlayElements.resumeButton,
    overlayElements.stopButton
  ];
  buttons.forEach(btn => {
    if (btn) btn.disabled = disabled;
  });
}

function updateInput(input, value) {
  if (!input) return;
  if (document.activeElement === input) return;
  input.value = value;
}

async function saveDurations() {
  if (isActionInProgress) return;
  isActionInProgress = true;
  setButtonsDisabled(true);

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

  isActionInProgress = false;
  setButtonsDisabled(false);
}

async function startSession() {
  if (isActionInProgress) return;
  isActionInProgress = true;
  setButtonsDisabled(true);

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

  isActionInProgress = false;
  setButtonsDisabled(false);
}

async function beginBreak() {
  if (isActionInProgress) return;
  isActionInProgress = true;
  setButtonsDisabled(true);

  const state = await dispatch("START_BREAK");
  if (state) {
    latestState = state;
    userOverlayActive = false;
    updateOverlay(state);
    renderBreakBadge(state);
  }

  isActionInProgress = false;
  setButtonsDisabled(false);
}

function sanitizeMinutes(value, fallback) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed);
  }
  return fallback ?? DEFAULT_FALLBACK_STATE.focusMinutes;
}

function renderCountdown(state) {
  renderBreakBadge(state);
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

  if (state.status === "break_ready") {
    const remaining = state.remainingMs ?? toMs(state.breakMinutes ?? DEFAULT_FALLBACK_STATE.breakMinutes);
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

  if (feedbackTimer) {
    clearTimeout(feedbackTimer);
  }

  feedbackTimer = setTimeout(() => {
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

function renderBreakBadge(state) {
  if (!state || state.status !== "running" || state.phase !== "break") {
    removeBreakBadge();
    return;
  }

  const badge = ensureBreakBadge();
  const countdownText = formatRemaining(state);
  const countdownEl = badge.querySelector(".x-underclass-badge-countdown");
  if (countdownEl) {
    countdownEl.textContent = countdownText;
  }

  // Update shortcuts list
  const shortcutsContainer = badge.querySelector(".x-underclass-badge-shortcuts");
  if (shortcutsContainer) {
    if (shortcuts.length === 0) {
      shortcutsContainer.innerHTML = '<p class="x-underclass-badge-no-shortcuts">No shortcuts yet</p>';
    } else {
      shortcutsContainer.innerHTML = shortcuts.map(shortcut => `
        <a href="${escapeHtml(shortcut.url)}"
           class="x-underclass-badge-shortcut-link"
           title="${escapeHtml(shortcut.url)}">
          ${escapeHtml(shortcut.name)}
        </a>
      `).join("");
    }
  }
}

function ensureBreakBadge() {
  let badge = document.getElementById(BREAK_BADGE_ID);
  if (badge) return badge;

  badge = document.createElement("div");
  badge.id = BREAK_BADGE_ID;
  badge.innerHTML = `
    <div class="x-underclass-badge-header">
      <span class="x-underclass-badge-label">Break</span>
      <span class="x-underclass-badge-countdown">--:--</span>
    </div>
    <div class="x-underclass-badge-shortcuts"></div>
  `;

  document.body.appendChild(badge);
  return badge;
}

function removeBreakBadge() {
  const badge = document.getElementById(BREAK_BADGE_ID);
  if (badge) {
    badge.remove();
  }
}

function applyBlockedStyles() {
  document.documentElement.classList.add("x-underclass-muted");
  document.body.classList.add("x-underclass-blocked");
}

function clearBlockedStyles() {
  document.documentElement.classList.remove("x-underclass-muted");
  document.body.classList.remove("x-underclass-blocked");
}

function toMs(minutes) {
  const parsed = Number(minutes);
  return Math.max(1, Math.round(parsed || 0)) * 60 * 1000;
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

async function loadShortcuts() {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: "GET_SHORTCUTS" }, response => {
        if (chrome.runtime.lastError) {
          resolve([]);
          return;
        }
        resolve(response?.shortcuts ?? []);
      });
    } catch (error) {
      resolve([]);
    }
  });
}

async function saveShortcutsToStorage(newShortcuts) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage({ type: "SAVE_SHORTCUTS", shortcuts: newShortcuts }, response => {
        if (chrome.runtime.lastError) {
          resolve([]);
          return;
        }
        resolve(response?.shortcuts ?? []);
      });
    } catch (error) {
      resolve([]);
    }
  });
}

function toggleSettingsPanel() {
  if (!overlayElements) return;

  settingsPanelVisible = !settingsPanelVisible;
  overlayElements.settingsPanel.classList.toggle("hidden", !settingsPanelVisible);

  if (settingsPanelVisible) {
    renderShortcutsList();
  }
}

async function addShortcut() {
  if (!overlayElements) return;

  const name = overlayElements.shortcutNameInput.value.trim();
  const url = overlayElements.shortcutUrlInput.value.trim();

  if (!name || !url) {
    showFeedback("Please enter both name and URL");
    return;
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    showFeedback("Please enter a valid URL");
    return;
  }

  shortcuts.push({ name, url });
  const saved = await saveShortcutsToStorage(shortcuts);
  shortcuts = saved;

  overlayElements.shortcutNameInput.value = "";
  overlayElements.shortcutUrlInput.value = "";

  renderShortcutsList();
  renderBreakBadge(latestState);
  showFeedback("Shortcut added");
}

async function deleteShortcut(index) {
  shortcuts.splice(index, 1);
  const saved = await saveShortcutsToStorage(shortcuts);
  shortcuts = saved;

  renderShortcutsList();
  renderBreakBadge(latestState);
  showFeedback("Shortcut deleted");
}

function renderShortcutsList() {
  if (!overlayElements?.shortcutsList) return;

  if (shortcuts.length === 0) {
    overlayElements.shortcutsList.innerHTML = '<p class="x-underclass-no-shortcuts">No shortcuts yet. Add one below!</p>';
    return;
  }

  overlayElements.shortcutsList.innerHTML = shortcuts.map((shortcut, index) => `
    <div class="x-underclass-shortcut-item">
      <div class="x-underclass-shortcut-info">
        <span class="x-underclass-shortcut-item-name">${escapeHtml(shortcut.name)}</span>
        <span class="x-underclass-shortcut-item-url">${escapeHtml(shortcut.url)}</span>
      </div>
      <button type="button" class="x-underclass-delete-shortcut" data-index="${index}" aria-label="Delete shortcut">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
          <path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
        </svg>
      </button>
    </div>
  `).join("");

  // Attach delete handlers
  const deleteButtons = overlayElements.shortcutsList.querySelectorAll(".x-underclass-delete-shortcut");
  deleteButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const index = parseInt(btn.getAttribute("data-index"), 10);
      deleteShortcut(index);
    });
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
