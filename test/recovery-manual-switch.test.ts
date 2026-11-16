import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

// After automatic recovery on a smaller window fails, the owner's explicit switch to a
// model with a large window must not inherit the small-destination payload guard.
const dir = mkdtempSync(join(tmpdir(), "pm-recovery-manual-switch-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
process.env.PI_NO_LOCAL_LLM = "1";
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { getApiProvider, registerApiProvider } = await import("@earendil-works/pi-ai/compat");
const { default: multiAccount } = await import("../index.ts");
const supported = typeof (SessionManager.inMemory(dir) as any).buildSessionProjection === "function";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test("an explicit switch to a large window after failed recovery dispatches the request", { skip: !supported }, async () => {
	// A: large source, out of quota. B: small automatic fallback whose summaries are invalid.
	// C: large window that the owner selects explicitly.
	const [a, b, c] = ["openai-codex-account-2", "openai-codex-account-4", "openai-codex-account-5"];
	const models = [a, b, c].map(provider => ({ provider, id: "gpt-6-sol", name: provider,
		api: "openai-codex-responses" as const, baseUrl: "http://127.0.0.1:1", reasoning: false,
		input: ["text" as const], contextWindow: provider === b ? 64000 : 400000, maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: Object.fromEntries(models.map(model => [model.provider, { modelOverrides: { [model.id]: { contextWindow: model.contextWindow } } }])) }));
	writeFileSync(join(dir, "auth.json"), JSON.stringify(Object.fromEntries(models.map((m, i) => [m.provider,
		{ type: "oauth", access: `synthetic-${i}`, refresh: `synthetic-refresh-${i}`, accountId: `owned-${i}`, expires: 4102444800000 }]))));
	writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({ childProxy: false, autoDiscoverModels: false,
		showUsage: false, autoContinue: true, onlyActive: false, followLastSuccessfulModel: false,
		includeOtherProviders: false, fallbacks: [a, b], preferredModels: { "openai-codex": ["gpt-6-sol"] },
		pinnedModels: { "openai-codex": "gpt-6-sol" }, includeCursor: false }));
	const realFetch = globalThis.fetch, realApi = getApiProvider("openai-codex-responses");
	globalThis.fetch = (async () => { throw new Error("RECOVERY_TEST_EXTERNAL_REQUEST_FORBIDDEN"); }) as typeof fetch;
	const blocked: string[] = [], answered: string[] = [], errors: any[] = [];
	function stream(model: any, context: any, options: any = {}) {
		const s = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			let message: any = { role: "assistant", provider: model.provider, model: model.id, api: model.api,
				timestamp: Date.now(), usage, content: [], stopReason: "stop" };
			try {
				// The production registration wrapper runs its admission check before dispatch.
				await options.onPayload?.({ messages: context.messages, tools: context.tools ?? [] }, model);
				if (model.provider === a) throw new Error("You have hit your ChatGPT usage limit (plus plan). Try again in ~147 min.");
				if (JSON.stringify(context).includes("Prepare a coherent current-work handoff")) message.content = [{ type: "text", text: " " }];
				else { answered.push(model.provider); message.content = [{ type: "text", text: "OWNED_SWITCH_OK" }]; }
			} catch (error) {
				message = { ...message, stopReason: "error", errorMessage: String(error) };
				if (String(error).includes("destination admission")) blocked.push(model.provider);
			}
			if (message.stopReason === "error") s.push({ type: "error", reason: "error", error: message });
			else s.push({ type: "done", reason: message.stopReason, message });
			s.end(message);
		}); return s;
	}
	registerApiProvider({ api: "openai-codex-responses", stream, streamSimple: stream } as any);
	const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: true, reserveTokens: 8192, keepRecentTokens: 4096 }, retry: { enabled: false }, ...({ cacheWarming: "off" } as Record<string, unknown>) });
	const manager = SessionManager.create(dir, join(dir, "sessions"));
	// About 360 KB of history: above every recovery byte budget (at most 262,144), far below C's window.
	for (let i = 0; i < 80; i++) {
		manager.appendMessage({ role: "user", content: `historical note ${i}: ${"background ".repeat(400)}`, timestamp: i * 2 });
		manager.appendMessage({ role: "assistant", provider: a, model: models[0].id, api: models[0].api,
			content: [{ type: "text", text: `Noted ${i}` }], stopReason: "stop", usage, timestamp: i * 2 + 1 });
	}
	const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
		extensionFactories: [async pi => { await multiAccount(pi); }, (pi: any) => {
			pi.on("session_start", (_event: any, ctx: any) => {
				for (const model of models) {
					const config = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
					ctx.modelRegistry.registerProvider(model.provider, { ...config, apiKey: "owned-no-network", models: [model] });
				}
			});
		}] });
	let session: any;
	try {
		await loader.reload();
		const result = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager: settings, resourceLoader: loader,
			sessionManager: manager, model: models[0], thinkingLevel: "off" });
		assert.deepEqual(result.extensionsResult.errors, []); session = result.session;
		await session.bindExtensions({ mode: "print", onError: (e: any) => errors.push(e) });
		await session.prompt("FIRST_REQUEST");
		await session.waitForIdle();
		assert.ok(blocked.includes(b), `the small fallback is guarded: ${JSON.stringify({ blocked, answered })}`);
		assert.deepEqual(answered, [], "failed recovery produces no answer");
		await session.prompt(`/multi-account switch ${c}/gpt-6-sol`);
		await session.waitForIdle();
		assert.equal(session.model?.provider, c);
		await session.prompt("SECOND_REQUEST");
		await session.waitForIdle();
		assert.deepEqual(errors, []);
		assert.equal(blocked.includes(c), false, `the large owner-selected window is not guarded: ${JSON.stringify({ blocked, answered })}`);
		assert.deepEqual(answered, [c]);
		assert.equal(session.getLastAssistantText(), "OWNED_SWITCH_OK");
	} finally {
		if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
		if (realApi) registerApiProvider(realApi);
		globalThis.fetch = realFetch;
	}
});
