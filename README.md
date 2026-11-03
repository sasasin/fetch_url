# @sasasin/fetch-url

A [pi](https://github.com/earendil-works/pi) coding-agent extension that adds a `fetch_url` tool:
it fetches many web pages **at the same time** by driving Playwright directly —
one Chromium process, one isolated `BrowserContext` per URL.
No MCP, no API billing, no external service.

## Why a separate tool

MCP-based URL readers usually go through a single browser tab
(`browser_navigate` → `browser_snapshot`), so fetches are serialized and often guarded by a
process-wide browser lock. On a 10-URL burst that single tab mostly times out.

`fetch_url` launches its **own** Chromium and gives every URL a fresh context, so navigation is
genuinely concurrent.

| | MCP `read_url` style | `fetch_url` |
|---|---|---|
| Path | `browser_navigate` → `browser_snapshot` | `playwright-core` → `chromium.launch()` |
| Browser | shared MCP Chromium, 1 tab | private Chromium, **one context per URL** |
| Concurrency | serialized by a lock | worker pool (default 4, max 8, 16 URLs per call) |
| Output | accessibility snapshot | `aria` (same shape) / `text` (innerText) / `html` (source) |
| Cost | none | none |

Measured on Linux + system Google Chrome, 4 URLs (1 SPA, 2 static, 1 bad DNS):

| concurrency | wall time | sum of per-URL time |
|---|---|---|
| 1 (serialized) | 5493 ms | 5493 ms |
| 4 | 2865 ms | 7432 ms |

## Install

```bash
# from npm
pi install npm:@sasasin/fetch-url

# or straight from this repository (updated by `pi update --extensions`)
pi install git:github.com/sasasin/fetch_url
```

Both sources install the extension's `dependencies` (`playwright-core`) automatically.
Restart pi, or run `/reload` in a running session.

> If you previously dropped this folder into `~/.pi/agent/extensions/fetch-url`,
> remove that copy first — loading both registers the tool name `fetch_url` twice.

### Browser requirement

`playwright-core` ships **without** browser binaries. The extension launches, in order:

1. system Google Chrome (`channel: "chrome"`)
2. Microsoft Edge (`channel: "msedge"`)
3. Playwright's bundled Chromium (`channel: "chromium"`) — install it with
   `npx playwright install chromium` run inside the package folder

If none is available you get `browser launch failed: could not launch a browser (tried …)`.

## Usage

```ts
fetch_url({
  urls: ["https://a.example", "https://b.example", "https://c.example"],
  mode: "text",              // default aria
  concurrency: 6,            // 1-8, default 4
  max_chars_per_page: 12000, // default 8000
  timeout_ms: 45000          // default 30000
})
```

Up to **16 URLs per call**; extras are reported as skipped. Results come back in input order:

```
--- https://example.com/ ---
[HTTP 200 | title: Example Domain | 170 chars]
# Example Domain
...
```

The header carries the HTTP status, the final URL when a redirect happened, the page title and
the character count.

## Behaviour

- **Permanent failures stop after one attempt** (`ERR_NAME_NOT_RESOLVED`, invalid URL,
  certificate errors, …). Transient ones retry once in a brand-new context (2 attempts by default).
- **Aborting a tool call** stops every worker within ~1.5 s; untouched URLs are reported as
  `cancelled (aborted)`.
- The Chromium instance is **reused** and closed after 3 idle minutes, on `session_shutdown`,
  and after a crash it is relaunched on the next call.
- SIGINT/SIGTERM/SIGHUP handlers are not installed by Playwright, so Ctrl-C in pi does not
  take the browser down with it.

## Configuration (environment variables)

| Variable | Effect |
|---|---|
| `PI_FETCH_URL_HEADLESS=0` | run headed (default: headless) |
| `PI_FETCH_URL_CHANNEL=chrome\|msedge\|chromium` | force one channel; `""` = embedded Chromium only |
| `PI_FETCH_URL_NO_SANDBOX=1` | `chromiumSandbox: false` (some containers / distros) |
| `PI_FETCH_URL_DIR=<path>` | override where `/fetch-url-update` runs `npm install` (default: this package's folder) |

## Keeping `playwright-core` current

`package.json` pins a range (`^1.64.1`).

- Installed via `pi install npm:` / `git:` → `pi update --extensions` reconciles the package,
  and for git sources Playwright itself is reinstalled.
- Placed as a local extension → pi does not touch local dependencies. Use the bundled slash
  command instead: `/fetch-url-update` runs `npm install` in the package folder and drops the
  running browser plus the module cache, so the next `fetch_url` call uses the new version.
  No `/reload` needed.

## Self-test without pi

The core is importable on its own:

```bash
npm install --omit=dev
node selftest.mjs --concurrency 4 --mode text https://news.ycombinator.com/ https://quotes.toscrape.com/js/
node selftest.mjs --abort-after 1500 --concurrency 2 https://httpbin.org/delay/8 https://example.com/
```

## Development

```bash
npm install      # devDependencies (typescript, pi types) are not published
npm run typecheck
```

Layout: `index.ts` is the thin pi tool-registration layer, `fetch-core.ts` holds the Playwright
lifecycle and the worker pool.

## 日本語

pi に `fetch_url` ツールを追加する拡張です。MCP 経由の URL 取得（タブ 1 個を直列）と違い、
専用の Chromium を起動して **URL ごとに独立した BrowserContext** を切るため、最大 16 URL を
既定 4（最大 8）ワーカーで同時並列に取得できます。課金なし・外部サービスなし。

インストールは `pi install npm:@sasasin/fetch-url`、またはこのリポジトリを直接
`pi install git:github.com/sasasin/fetch_url`（`pi update --extensions` で追随）。
`playwright-core` にはブラウザバイナリが含まれないため、システムの Chrome / Edge が無い場合は
パッケージフォルダで `npx playwright install chromium` が必要です。
出力は `aria`（アクセシビリティスナップショット）/ `text`（innerText）/ `html`（生 HTML）。
挙動・環境変数・`/fetch-url-update` による依存追随の詳細は上の各節を参照してください。

## License

MIT
