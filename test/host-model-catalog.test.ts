/**
 * Pi's extension loader (jiti) gives this module a `require` that resolves
 * `@earendil-works/pi-ai` to the host's already-loaded copy. Numbered Claude slots must take
 * their canonical model metadata from there instead of loading this package's own pi-ai, which
 * re-evaluates the whole provider catalog and cost every Pi startup about 0.15s. Plain Node
 * ESM has no `require`, so the lookup must still fall back to the package's own copy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INDEX = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");

const DRIVER = `import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const agent = mkdtempSync(join(tmpdir(), "pmacct-hostcat-agent-"));
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_CURSOR_PROVIDER_ROOT = join(agent, "no-cursor");
writeFileSync(join(agent, "auth.json"), JSON.stringify({
	"anthropic-account-2": { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3600e3 },
}));
let hostCalls = 0;
if (process.argv[3] === "host") globalThis.require = (id) => {
	if (id !== "@earendil-works/pi-ai") throw new Error("unexpected require " + id);
	return { getModel: (provider, model) => (hostCalls++, provider === "anthropic"
		? { id: model, name: "host:" + model, api: "anthropic-messages", provider, baseUrl: "https://api.anthropic.com",
			reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 }
		: undefined) };
};
const mod = await import(process.argv[2]);
const providers = [];
mod.default({
	registerProvider: (name, cfg) => providers.push({ name, cfg }),
	registerCommand: () => {},
	on: () => {},
	setModel: async () => true,
	sendUserMessage: () => {},
	continueAgent: async () => {},
	appendEntry: () => {},
	getThinkingLevel: () => "high",
	setThinkingLevel: () => {},
});
const slot = providers.find((p) => p.name === "anthropic-account-2");
console.log("__RESULT__" + JSON.stringify({ models: slot?.cfg?.models?.map((m) => m.name) ?? [], hostCalls }));
`;

function run(mode: "host" | "own"): { models: string[]; hostCalls: number } {
	const root = mkdtempSync(join(tmpdir(), "pmacct-hostcat-"));
	try {
		const driver = join(root, "driver.mjs");
		writeFileSync(driver, DRIVER);
		const stdout = execFileSync(process.execPath, [driver, INDEX, mode], { encoding: "utf8" });
		const line = stdout.split("\n").find((l) => l.startsWith("__RESULT__"));
		assert.ok(line, `driver produced no result:\n${stdout}`);
		return JSON.parse(line.slice("__RESULT__".length));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("numbered Claude slots take model metadata from the host's pi-ai when the loader provides it", () => {
	const result = run("host");
	assert.ok(result.hostCalls > 0);
	assert.ok(result.models.length > 0);
	assert.ok(result.models.every((name) => name.startsWith("host:")), result.models.join(", "));
});

test("without a loader require, the package's own pi-ai still supplies the metadata", () => {
	const result = run("own");
	assert.equal(result.hostCalls, 0);
	assert.ok(result.models.length > 0);
	assert.ok(result.models.every((name) => !name.startsWith("host:")), result.models.join(", "));
});
