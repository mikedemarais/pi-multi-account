import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Real Pi lifecycle, synthetic local streams only. Never read personal auth or call an API.
const dir = mkdtempSync(join(tmpdir(), "multi-account-retry-sdk-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { default: multiAccount } = await import("../index.ts");

for (const scenario of [
	{ name: "host retry succeeds without an extra continuation", retry: true, terminal: false, injections: 0 },
	{ name: "disabled host retries still resume once after settling", retry: false, terminal: false, injections: 1 },
	{ name: "terminal fallback refusal is not retried by a stale handoff", retry: true, terminal: true, injections: 0 },
]) {
	test(`real Pi failover: ${scenario.name}`, { timeout: 10_000 }, async () => {
		const models = ["primary-fixture", "secondary-fixture"].map((provider) => ({
			provider, id: "fixture-model", name: provider, api: "openai-completions" as const,
			baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text" as const],
			contextWindow: 100_000, maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
		writeFileSync(join(dir, "auth.json"), JSON.stringify(Object.fromEntries(models.map((m) =>
			[m.provider, { type: "api_key", key: `fixture-only-${m.provider}` }]))));
		writeFileSync(join(dir, "provider-failover-state.json"), "{}");
		writeFileSync(join(dir, "provider-failover.json"), JSON.stringify({
			includeCursor: false, childProxy: false, autoDiscoverModels: false, showUsage: false,
			includeOtherProviders: true, contextGuard: false, continueAfterCompaction: false,
		}));
		const requests: string[] = [];
		const injected: string[] = [];
		const settings = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: scenario.retry, maxRetries: 1, baseDelayMs: 1 },
		});
		const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true,
			extensionFactories: [(pi) => {
				pi.on("input", (event) => { if (event.source === "extension") injected.push(event.text); });
				for (const model of models) pi.registerProvider(model.provider, {
					api: model.api, baseUrl: model.baseUrl, apiKey: `fixture-only-${model.provider}`, models: [model],
					streamSimple: (selected: any) => {
						requests.push(selected.provider);
						const error = selected.provider === "primary-fixture"
							? "Claude Code request failed (429): You've hit your session limit · resets 5pm (America/Los_Angeles)"
							: scenario.terminal ? "400 invalid_request_error: account action required" : undefined;
						const stream = createAssistantMessageEventStream();
						queueMicrotask(() => {
							const message: any = { role: "assistant", content: error ? [] : [{ type: "text", text: "OK" }],
								api: selected.api, provider: selected.provider, model: selected.id,
								stopReason: error ? "error" : "stop", timestamp: Date.now(), errorMessage: error,
								usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
							if (error) stream.push({ type: "error", reason: "error", error: message });
							else stream.push({ type: "done", reason: "stop", message });
							stream.end();
						});
						return stream;
					},
				});
			}, multiAccount],
		});
		await loader.reload();
		const result = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader,
			settingsManager: settings, sessionManager: SessionManager.inMemory(dir), model: models[0], tools: [] });
		assert.deepEqual(result.extensionsResult.errors, []);
		const session = result.session;
		try {
			await session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(JSON.stringify(error)); } });
			await session.prompt("Return OK");
			// sendUserMessage starts through async input handlers after agent_settled.
			await new Promise<void>((resolve) => setImmediate(resolve));
			await session.waitForIdle();
			assert.deepEqual(requests, ["primary-fixture", "secondary-fixture"], "one primary attempt and one fallback attempt only");
			assert.equal(injected.length, scenario.injections, "only inject when Pi did not already retry");
			assert.equal(session.model?.provider, "secondary-fixture");
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});
}
