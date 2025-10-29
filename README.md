# X Underclass Preventer

A Chrome extension that blocks X (Twitter) during focus sessions with an inescapable Pomodoro countdown. The overlay fades the page to keep you on task and disappears only when your break begins.

## Features

- Manual focus sessions kicked off from the toolbar icon while you are on X/Twitter.
- Full-screen overlay with built-in controls to adjust durations, start, pause/resume, and stop.
- Countdown timer managed by a background service worker using `chrome.alarms`.
- Overlay automatically dismisses during breaks so you can use the site when it is allowed.

## Getting Started

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** and select this project folder.
4. Open a tab on `https://x.com` or `https://twitter.com`.
5. Click the "X Underclass Preventer" toolbar icon—an overlay appears with the timer and controls.
6. Set your focus/break durations and press **Start Focus**. The overlay locks the page until the break begins (or you pause/stop).

## Overlay Controls

- **Focus/Break durations**: Adjust the lengths (minutes) directly in the modal and hit **Save Durations**.
- **Start Focus**: Begins a new focus cycle using the current durations.
- **Pause / Resume**: Temporarily halt the timer; resuming continues the countdown where you left off.
- **Stop Session**: Return to idle and remove the overlay.
- Close the overlay manually while idle/breaking if you just want to tweak settings without starting.

## Notes

- The timer keeps running even if Chrome is closed, using the `chrome.alarms` API.
- The overlay only appears on X/Twitter during focus sessions unless you explicitly open it for configuration.
- Extend the project by editing `background.js` or `content-script.js` to add features like site lists, statistics, or reminders.
