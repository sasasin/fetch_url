/**
 * fetch-url: 複数 URL を並列で取得する pi 拡張ツール。
 *
 * 実装は fetch-core.ts（playwright-core を直接操作）。このファイルは
 * ツール登録と結果レンダリングだけの薄い層。
 *
 * MCP 経由の URL 取得（タブ 1 個を直列に使う）に対して、
 * fetch_url は自分専用の Chromium を launch し、URL ごとに独立した
 * BrowserContext を開くので同時並列で取得できる。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	closeBrowser,
	DEFAULTS,
	installDir,
	MAX_CONCURRENCY,
	MAX_URLS,
	fetchPages,
	resetRuntime,
	type PageFetch,
} from "./fetch-core.ts";

function renderOne(result: PageFetch): string {
	const header = `--- ${result.url} ---`;
	if (!result.ok) {
		return `${header}\nFETCH FAILED (${result.ms}ms) ${result.note}`;
	}
	const meta = [
		result.status !== undefined ? `HTTP ${result.status}` : "",
		result.finalUrl && result.finalUrl !== result.url ? `redirected to ${result.finalUrl}` : "",
		result.title ? `title: ${result.title}` : "",
		`${result.characters} chars`,
		result.note,
	]
		.filter(Boolean)
		.join(" | ");
	return `${header}\n[${meta}]\n${result.body}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fetch_url",
		label: "Fetch URLs (parallel Playwright)",
		description:
			"Fetch several web pages at once by driving Playwright directly (no MCP, no API billing). " +
			"One Chromium serves an isolated BrowserContext per URL, so navigation runs concurrently " +
			"(default 4 workers, max 8) instead of being serialized through one shared browser tab. " +
			"Returns an accessibility snapshot per page by default; mode \"text\" gives rendered inner text.",
		promptSnippet: "Fetch multiple web pages concurrently via a local Playwright browser",
		promptGuidelines: [
			"Use fetch_url when you need several URLs at once: it fetches concurrently (up to 8 contexts), unlike single-tab MCP browser tools which serialize navigation.",
			"mode \"text\" is best for article prose, \"aria\" keeps structure and links, \"html\" returns raw markup; raise max_chars_per_page when output is trimmed.",
			"fetch_url launches its own Chromium and is independent of any Playwright MCP browser; set PI_FETCH_URL_HEADLESS=0 for headed browsing or PI_FETCH_URL_CHANNEL to pick another browser.",
		],
		parameters: Type.Object({
			urls: Type.Array(Type.String(), {
				description: `URLs to fetch concurrently. At most ${MAX_URLS} per call; extras are skipped.`,
			}),
			mode: Type.Optional(
				Type.Union([Type.Literal("aria"), Type.Literal("text"), Type.Literal("html")], {
					description:
						`"aria" (default) = accessibility snapshot YAML (same shape as Playwright MCP browser_snapshot), "text" = rendered innerText, "html" = page source.`,
				})
			),
			max_chars_per_page: Type.Optional(
				Type.Number({
					description: `Trim each page to this many characters (default ${DEFAULTS.maxCharsPerPage}).`,
				})
			),
			concurrency: Type.Optional(
				Type.Number({
					description: `How many pages to load at once (1-${MAX_CONCURRENCY}, default ${DEFAULTS.concurrency}).`,
				})
			),
			timeout_ms: Type.Optional(
				Type.Number({
					description: `Per-URL navigation timeout in milliseconds (default ${DEFAULTS.navTimeoutMs}).`,
				})
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const requested: string[] = params.urls ?? [];
			const urls = requested.slice(0, MAX_URLS);
			const startedAt = Date.now();
			let done = 0;

			const results = await fetchPages(
				urls,
				{
					mode: params.mode ?? DEFAULTS.mode,
					maxCharsPerPage: params.max_chars_per_page ?? DEFAULTS.maxCharsPerPage,
					concurrency: params.concurrency ?? DEFAULTS.concurrency,
					navTimeoutMs: params.timeout_ms ?? DEFAULTS.navTimeoutMs,
				},
				{
					signal,
					onPage: (result) => {
						done += 1;
						onUpdate?.({
							content: [
								{
									type: "text",
									text: `${result.ok ? "ok" : "failed"} ${done}/${urls.length}: ${result.url} (${result.ms}ms)`,
								},
							],
							details: {
								provider: "playwright",
								product: "chromium",
								mode: params.mode ?? DEFAULTS.mode,
								fetched: done,
								total: urls.length,
							},
						});
					},
				}
			);

			const sections = results.map(renderOne);
			if (requested.length > urls.length) {
				sections.push(`[skipped ${requested.length - urls.length} URLs: over the ${MAX_URLS} per-call limit]`);
			}
			const okCount = results.filter((result) => result.ok).length;

			return {
				content: [{ type: "text", text: sections.join("\n\n") || "No URLs were fetched." }],
				details: {
					provider: "playwright",
					product: "chromium",
					mode: params.mode ?? DEFAULTS.mode,
					concurrency: Math.min(params.concurrency ?? DEFAULTS.concurrency, MAX_CONCURRENCY),
					urls,
					ok: okCount,
					failed: results.length - okCount,
					ms: Date.now() - startedAt,
				},
			};
		},
	});

	/*
	 * 依存追随用。docs/packages.md の通り local 拡張は `pi install`/`pi update --extensions` の
	 * 対象外（「Local packages are not installed or modified, so their dependency tree remains
	 * the package author's responsibility」）なので、pi update では playwright-core が追随しない。
	 * package.json の range が ^1.64.1 なので、このコマンドがその range 内の最新に合わせる。
	 */
	pi.registerCommand("fetch-url-update", {
		description: "fetch_url の playwright-core を package.json の range 内の最新に更新する",
		handler: async (_args, ctx) => {
			const dir = installDir();
			// 古いライブラリで起動済みの Chromium と import cache を先に捨てる
			await closeBrowser();
			resetRuntime();

			const install = (await pi.exec("npm", [
				"--prefix",
				dir,
				"install",
				"--omit=dev",
				"--no-audit",
				"--no-fund",
			])) as { code?: number; stdout?: string; stderr?: string };

			if (install.code !== 0) {
				ctx.ui.notify(
					`fetch-url-update 失敗 (exit ${install.code}): ${String(install.stderr ?? install.stdout ?? "").replace(/\s+/g, " ").slice(0, 220)}`,
					"error"
				);
				return;
			}

			const listing = (await pi.exec("npm", ["--prefix", dir, "ls", "playwright-core", "--depth=0"])) as {
				stdout?: string;
			};
			const line =
				String(listing.stdout ?? "")
					.split("\n")
					.find((row) => row.includes("playwright-core"))
					?.trim() ?? "";
			ctx.ui.notify(`fetch_url 更新完了: ${line || "playwright-core"}（拡張の /reload 不要、次の呼び出しから新しい版を使う）`, "info");
		},
	});

	// reload / session 終了 / プロセス終了で Chromium を残さない。冪等。
	pi.on("session_shutdown", async () => {
		await closeBrowser();
	});
}
