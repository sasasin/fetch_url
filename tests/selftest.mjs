#!/usr/bin/env node
/**
 * 自己テスト: pi の拡張 runtime を使わず fetch-core.ts を直接叩く。
 *   node tests/selftest.mjs [--concurrency N] [--mode aria|text|html] [--max-chars N] <url...>
 * 並列度 1（read_url 相当の直列）と 4 を同じ URL 群で比べるため、
 * 実行のたびに --concurrency を変えて 2 回流すと差が見える。
 */
import { fetchPages, closeBrowser } from "../fetch-core.ts";

const args = process.argv.slice(2);
let concurrency = 4;
let mode = "aria";
let maxChars = 8000;
let timeoutMs;
let abortAfter;
const urls = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--concurrency") concurrency = Number(args[++i]);
	else if (args[i] === "--mode") mode = args[++i];
	else if (args[i] === "--max-chars") maxChars = Number(args[++i]);
	else if (args[i] === "--timeout") timeoutMs = Number(args[++i]);
	else if (args[i] === "--abort-after") abortAfter = Number(args[++i]);
	else urls.push(args[i]);
}

const controller = new AbortController();
if (abortAfter) setTimeout(() => controller.abort(), abortAfter).unref?.();

const started = Date.now();
const results = await fetchPages(urls, {
	concurrency,
	mode,
	maxCharsPerPage: maxChars,
	...(timeoutMs ? { navTimeoutMs: timeoutMs } : {}),
},{ signal: controller.signal });
const total = Date.now() - started;

for (const result of results) {
	console.log(
		[
			result.ok ? "ok   " : "fail ",
			result.url,
			`attempt=${result.attempts}`,
			`ms=${result.ms}`,
			result.status ? `status=${result.status}` : "",
			result.finalUrl && result.finalUrl !== result.url ? `final=${result.finalUrl}` : "",
			`chars=${result.characters}`,
			result.title ? `title=${JSON.stringify(result.title)}` : "",
			result.note ? `note=${result.note}` : "",
		]
			.filter(Boolean)
			.join(" ")
	);
	console.log(`  head: ${result.body.slice(0, 120).replace(/\s+/g, " ")}`);
}
console.log(`\nconcurrency=${concurrency} mode=${mode} urls=${urls.length} wall=${total}ms sum=${results.reduce((a, r) => a + r.ms, 0)}ms`);
await closeBrowser();
