# Changelog

## 0.1.0

Initial public release.

- `fetch_url` tool: fetch up to 16 URLs in one call through a single Chromium
  using one isolated `BrowserContext` per URL (default 4 concurrent workers, max 8).
- Output modes: `aria` (accessibility snapshot), `text` (rendered innerText), `html` (page source).
- Per-page headers with HTTP status, redirect target, title and character count.
- Retries transient navigation failures once in a fresh context; permanent failures
  (DNS, invalid URL, certificate errors) stop after a single attempt.
- Browser pick order `chrome` → `msedge` → embedded `chromium`, overridable with
  `PI_FETCH_URL_CHANNEL`.
- Idle browser reuse with a 3-minute auto-close, closed on `session_shutdown`.
- `/fetch-url-update` slash command to bump `playwright-core` inside the declared range.
- Requires Node 22.19+ (the same floor as `@earendil-works/pi-coding-agent`); Node 20 is end-of-life since 2026-04-30 and is not tested.
