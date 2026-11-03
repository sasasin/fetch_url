#!/usr/bin/env node
/**
 * pi と同じ jiti 経由で拡張をロードし、登録内容が生きていることを確認する。
 *   node tests/test-load.mjs
 * pi と同じ jiti 経路で読むので、ブラウザを起動せずに登録内容だけ確認できる
 * （selftest.mjs は .ts を直接 import するため型ストリッピング可能な Node 22.19+ が要る）。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// このスクリプトは tests/ にあるので、パッケージルートは親ディレクトリ
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });

const mod = await jiti.import(resolve(root, "index.ts"));
if (typeof mod.default !== "function") {
	console.error("index.ts must default-export an extension factory");
	process.exit(1);
}

const tools = [];
const commands = [];
const events = [];
mod.default({
	registerTool: (tool) => tools.push(tool?.name),
	registerCommand: (name) => commands.push(name),
	on: (event) => events.push(event),
	exec: async () => ({ code: 0, stdout: "", stderr: "" }),
});

const core = await jiti.import(resolve(root, "fetch-core.ts"));

// 拡張が実際に依存を解決できるか（インストール状態の妥当性チェック）
let playwrightResolvable = false;
try {
	const pw = await jiti.import("playwright-core");
	playwrightResolvable = Boolean(pw?.chromium);
} catch {}

const checks = [
	["fetch_url tool registered", tools.includes("fetch_url")],
	["registers no slash commands (updates go through pi update --extensions)", commands.length === 0],
	["session_shutdown handler registered", events.includes("session_shutdown")],
	["packageDir() resolves to this folder", resolve(core.packageDir()) === root],
	["playwright-core is resolvable from the extension", playwrightResolvable],
];

let failed = false;
for (const [label, ok] of checks) {
	if (!ok) failed = true;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
}
console.log(`node=${process.version} tools=${JSON.stringify(tools)} commands=${JSON.stringify(commands)}`);
process.exit(failed ? 1 : 0);
