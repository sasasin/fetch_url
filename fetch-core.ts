/**
 * fetch-url コア: MCP を使わず playwright-core を直接呼び、複数 URL を並列取得する。
 *
 * ── MCP 経由の URL 取得との違い ──
 *   Playwright MCP はブラウザ 1 個・タブ 1 個しか持たないため、navigation+snapshot を
 *   プロセス内で直列化するしかない（実測: 10 並列で 9 失敗、6 並列で 5 失敗）。
 *   ここでは自分自身で chromium.launch() し、URL ごとに BrowserContext を作るので
 *   1 browser / N context / N page で並列 navigation できる。
 *   context は cookie・localStorage・cache を共有しない独立性を持つ
 *   （「1 タブを順番に使い回す」という制約がない）。
 *
 * ── 並列設計 ──
 *   - URL リストは worker プール（既定 4、最大 8）で回す。
 *   - navigation 中の待機は I/O 待ちなので worker 数だけ同時に進行する。
 *   - 直列化はしない。ブラウザの再利用のみ getBrowser() で共有し、
 *     launch 直後の二重 launch は launching プロミスで束ねる。
 *   - 使わない間は IDLE_CLOSE_MS でブラウザを閉じる（pi が TUI で生きていても
 *     Chromium を常駐させない）。unref 済みタイマーなので process を留めない。
 *
 * ── 失敗処理 ──
 *   恒久的に失敗する URL（DNS 解決不可・不正 URL・証明書エラー等）は
 *   context を作り直しても無駄なので即打ち切る。
 *   一時的な失敗のみ、新しい context で 1 回だけ再試行する（既定 2 試行）。
 *   ブラウザがクラッシュして切断されている場合は getBrowser() が再接続（launch し直し）する。
 *
 * ── ブラウザバイナリ ──
 *   channel "chrome" でシステムの Google Chrome を使う。
 *   playwright-core 単体はブラウザをダウンロードしないため、無い環境では
 *   msedge → 内蔵 chromium にフォールバックし、それも無ければ
 *   `npx playwright install chromium` を案内する。
 *   env で上書き: PI_FETCH_URL_CHANNEL=chrome|msedge|chromium|"" ("" = 内蔵 chromium),
 *                 PI_FETCH_URL_HEADLESS=0 で headed,
 *                 PI_FETCH_URL_NO_SANDBOX=1 で chromiumSandbox: false。
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, Page } from "playwright-core";

export type Mode = "aria" | "text" | "html";

export const MAX_URLS = 16;
export const MAX_CONCURRENCY = 8;
export const NAV_ATTEMPTS = 2;
export const IDLE_CLOSE_MS = 3 * 60 * 1000;

export const DEFAULTS = {
	mode: "aria" as Mode,
	maxCharsPerPage: 8000,
	concurrency: 4,
	navTimeoutMs: 30000,
	settleMs: 600,
};

/** 作り直しても解決しない失敗（即打ち切る） */
const PERMANENT_NAV_ERROR =
	/net::ERR_(NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION_REFUSED|CONNECTION_RESET|ADDRESS_UNREACHABLE|UNREACHABLE_NETWORK|UNKNOWN_URL_SCHEME|INVALID_URL|CERT_|BLOCKED_BY|FILE_NOT_FOUND|ACCESS_DENIED|SCHEME_NOT_SUPPORTED)|ERR_(INVALID_URL|UNKNOWN_URL_SCHEME)|Cannot navigate to invalid URL/i;

function isPermanentFailure(message: string): boolean {
	return PERMANENT_NAV_ERROR.test(message);
}

function oneLine(message: string): string {
	return message.replace(/\s+/g, " ").slice(0, 240);
}

function messageOf(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

// ─────────────────────────── playwright / browser lifecycle ───────────────────────────

type PlaywrightModule = typeof import("playwright-core");

let pw: PlaywrightModule | null = null;
let browser: Browser | null = null;
let browserKey = "";
let launching: Promise<Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * このパッケージ自身のルートディレクトリ（エラー案内の文言に出す）。
 * ローカル拡張として ~/.pi/agent/extensions/ に置いても、
 * pi install された npm / git パッケージでも、import 元の位置から求める。
 */
export function packageDir(): string {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		return process.cwd();
	}
}

/** 重い依存の読み込みはツール実行時まで遅らせる（拡張の factory では何もしない） */
async function loadPlaywright(): Promise<PlaywrightModule> {
	if (pw) return pw;
	try {
		pw = await import("playwright-core");
	} catch (error) {
		throw new Error(
			`cannot import playwright-core (${oneLine(messageOf(error))}). ` +
				`Fix: npm install --omit=dev --prefix ${packageDir()}`
		);
	}
	return pw;
}

function headlessDefault(): boolean {
	return process.env.PI_FETCH_URL_HEADLESS !== "0";
}

function channelCandidates(): Array<string | undefined> {
	const fromEnv = process.env.PI_FETCH_URL_CHANNEL;
	if (fromEnv !== undefined) return [fromEnv === "" ? undefined : fromEnv];
	// playwright-core にはブラウザバイナリが同梱されないため、内蔵 chromium は最後に試す。
	return ["chrome", "msedge", "chromium"];
}

async function launchBrowser(headless: boolean): Promise<Browser> {
	const module = await loadPlaywright();
	const options = {
		headless,
		// 共通の launch 引数。AutomationControlled を伏せて bot 判定の足場を減らす。
		args: ["--disable-blink-features=AutomationControlled"],
		chromiumSandbox: process.env.PI_FETCH_URL_NO_SANDBOX !== "1",
		// pi プロセスの SIGINT/SIGTERM で Chromium を巻き込まない
		handleSIGINT: false,
		handleSIGTERM: false,
		handleSIGHUP: false,
	};

	const tried: string[] = [];
	let lastError = "";
	for (const channel of channelCandidates()) {
		tried.push(channel ?? "embedded chromium");
		try {
			return await module.chromium.launch({ ...options, channel });
		} catch (error) {
			lastError = oneLine(messageOf(error));
		}
	}
	throw new Error(
		`could not launch a browser (tried ${tried.join(", ")}): ${lastError}. ` +
			`Fallback: run \`npx playwright install chromium\` in ${packageDir()}, ` +
			`or point PI_FETCH_URL_CHANNEL at an installed browser.`
	);
}

function clearIdleTimer(): void {
	if (!idleTimer) return;
	clearTimeout(idleTimer);
	idleTimer = null;
}

function scheduleIdleClose(): void {
	clearIdleTimer();
	idleTimer = setTimeout(() => {
		void closeBrowser();
	}, IDLE_CLOSE_MS);
	idleTimer.unref?.();
}

/** 冪等。reload / session_shutdown / cancel が同じ経路に converge しても安全 */
export async function closeBrowser(): Promise<void> {
	clearIdleTimer();
	const current = browser;
	const pending = launching;
	browser = null;
	browserKey = "";
	launching = null;
	if (pending) {
		try {
			await pending;
		} catch {
			/* launch 失敗は握りつぶす */
		}
	}
	if (current) {
		try {
			await current.close();
		} catch {
			/* もう閉じている */
		}
	}
}

/**
 * ブラウザ共有。headless 設定が変わったら作り直す。
 * クラッシュで切断されている場合は launch し直す（MCP 版での tab reset 相当）。
 */
async function getBrowser(headless: boolean): Promise<Browser> {
	clearIdleTimer();
	const key = headless ? "headless" : "headed";
	if (browser && browserKey === key && browser.isConnected()) return browser;
	if (browser) await closeBrowser();
	if (!launching) {
		const started = launchBrowser(headless).then(
			(launched) => {
				browser = launched;
				browserKey = key;
				launching = null;
				scheduleIdleClose();
				return launched;
			},
			(error) => {
				launching = null;
				throw error;
			}
		);
		launching = started;
	}
	return launching;
}

/** headless Chromium の UA に HeadlessChrome と出て bot 判定されやすいので整える */
function userAgentFor(instance: Browser): string {
	const version = instance.version?.() ?? "";
	const major = version.split(".")[0] || "131";
	const platform =
		process.platform === "darwin"
			? "Macintosh; Intel Mac OS X 10_15_7"
			: process.platform === "win32"
				? "Windows NT 10.0; Win64; x64"
				: "X11; Linux x86_64";
	return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

// ─────────────────────────── fetch ───────────────────────────

export type PageFetch = {
	url: string;
	ok: boolean;
	status?: number;
	finalUrl?: string;
	title?: string;
	body: string;
	characters: number;
	attempts: number;
	note: string;
	ms: number;
};

type Resolved = typeof DEFAULTS & { signal?: AbortSignal };

async function extract(page: Page, mode: Mode): Promise<string> {
	if (mode === "html") return await page.content();
	if (mode === "text") {
		return await page.evaluate(() => document.body?.innerText ?? document.documentElement?.innerText ?? "");
	}
	// aria: Playwright 内蔵の accessibility ツリー YAML。MCP の browser_snapshot とほぼ同じ形。
	try {
		return await page.locator("body").ariaSnapshot();
	} catch {
		return await page.evaluate(() => document.body?.innerText ?? "");
	}
}

type SingleOutcome =
	| { ok: true; status?: number; finalUrl: string; title: string; body: string }
	| { ok: false; message: string };

/** 1 URL を独立した context で 1 回。context は最後に必ず閉じる（ページと storage が残らないようにする） */
async function fetchOnce(instance: Browser, url: string, o: Resolved): Promise<SingleOutcome> {
	const context = await instance.newContext({
		userAgent: userAgentFor(instance),
		viewport: null,
	});
	const page = await context.newPage();
	const signal = o.signal;
	const onAbort = () => {
		void page.close({ runBeforeUnload: false }).catch(() => {});
	};
	if (signal) {
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: o.navTimeoutMs });
		// SPA は domcontentloaded 時点では空なので load まで待つ（ハングしても落とさない）。
		await page.waitForLoadState("load", { timeout: Math.min(o.navTimeoutMs, 10000) }).catch(() => {});
		if (o.settleMs > 0) await page.waitForTimeout(o.settleMs).catch(() => {});
		const body = await extract(page, o.mode);
		const title = await page.title().catch(() => "");
		return {
			ok: true,
			status: response?.status(),
			finalUrl: page.url(),
			title,
			body,
		};
	} catch (error) {
		return { ok: false, message: oneLine(messageOf(error)) };
	} finally {
		if (signal) signal.removeEventListener("abort", onAbort);
		await context.close().catch(() => {});
	}
}

async function fetchOne(url: string, o: Resolved): Promise<PageFetch> {
	const startedAt = Date.now();
	const steps: string[] = [];
	let lastError = "";

	for (let attempt = 1; attempt <= NAV_ATTEMPTS; attempt++) {
		let instance: Browser;
		try {
			instance = await getBrowser(headlessDefault());
		} catch (error) {
			return {
				url,
				ok: false,
				body: "",
				characters: 0,
				attempts: attempt,
				note: `browser launch failed: ${oneLine(messageOf(error))}`,
				ms: Date.now() - startedAt,
			};
		}

		const outcome = await fetchOnce(instance, url, o);
		if (outcome.ok) {
			const characters = outcome.body.length;
			const body =
				characters > o.maxCharsPerPage
					? `${outcome.body.slice(0, o.maxCharsPerPage)}\n[trimmed: ${characters} characters total]`
					: outcome.body || "(empty page)";
			return {
				url,
				ok: true,
				status: outcome.status,
				finalUrl: outcome.finalUrl,
				title: outcome.title,
				body,
				characters,
				attempts: attempt,
				note: steps.length ? `recovered on attempt ${attempt}: ${steps.join(", ")}` : "",
				ms: Date.now() - startedAt,
			};
		}

		const aborted = Boolean(o.signal?.aborted);
		const permanent = isPermanentFailure(outcome.message) || aborted;
		if (permanent) {
			return {
				url,
				ok: false,
				body: "",
				characters: 0,
				attempts: attempt,
				note: aborted
					? "cancelled (aborted)"
					: `navigation failed (permanent, no retry): ${outcome.message}`,
				ms: Date.now() - startedAt,
			};
		}
		lastError = outcome.message;
		if (attempt < NAV_ATTEMPTS) steps.push(`fresh context (attempt ${attempt + 1})`);
	}

	return {
		url,
		ok: false,
		body: "",
		characters: 0,
		attempts: NAV_ATTEMPTS,
		note: `navigation failed after ${NAV_ATTEMPTS} attempts (${steps.join(" -> ") || "no retry"}): ${lastError}`,
		ms: Date.now() - startedAt,
	};
}

/** worker プール。結果は入力順のまま返す（完了順ではない） */
export async function fetchPages(
	urls: string[],
	options: Partial<typeof DEFAULTS> = {},
	hooks: {
		signal?: AbortSignal;
		onPage?: (result: PageFetch, index: number, total: number) => void;
	} = {}
): Promise<PageFetch[]> {
	const o: Resolved = { ...DEFAULTS, ...options, signal: hooks.signal };
	const total = urls.length;
	const results: Array<PageFetch | undefined> = new Array(total).fill(undefined);
	if (total === 0) return [];

	const limit = Math.max(1, Math.min(o.concurrency, MAX_CONCURRENCY, total));
	let cursor = 0;
	const worker = async () => {
		for (;;) {
			if (hooks.signal?.aborted) return;
			const index = cursor++;
			if (index >= total) return;
			const result = await fetchOne(urls[index], o);
			results[index] = result;
			hooks.onPage?.(result, index, total);
		}
	};
	await Promise.all(Array.from({ length: limit }, worker));

	return results.map(
		(result, index) =>
			result ?? {
				url: urls[index],
				ok: false,
				body: "",
				characters: 0,
				attempts: 0,
				note: "cancelled (aborted)",
				ms: 0,
			}
	);
}
