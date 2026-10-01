import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Real Pi lifecycle with synthetic local providers. No network or personal credentials.
const dir = mkdtempSync(join(tmpdir(), "multi-account-quota-recovery-sdk-"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PI_OFFLINE = "1";
const {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
const { default: multiAccount } = await import("../index.ts");

const providers = ["quota-a", "quota-b", "quota-c"];
const models = providers.map((provider) => ({
	provider,
	id: "fixture-model",
	name: provider,
	api: "openai-completions" as const,
	baseUrl: "http://127.0.0.1:1",
	reasoning: false,
	input: ["text" as const],
	contextWindow: 100_000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}));

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for quota recovery chain");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

test("real Pi continues through two quota-limited fallbacks and completes on the third", async () => {
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify(
			Object.fromEntries(
				providers.map((provider) => [
					provider,
					{ type: "api_key", key: `fixture-only-${provider}` },
				]),
			),
		),
	);
	writeFileSync(
		join(dir, "provider-failover.json"),
		JSON.stringify({
			includeCursor: false,
			childProxy: false,
			autoDiscoverModels: false,
			showUsage: false,
			includeOtherProviders: true,
			fallbacks: providers,
			autoContinue: true,
			resumeAfterAllAccountsRecover: true,
		}),
	);

	const requests: string[] = [];
	const settings = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		extensionFactories: [
			(pi) => {
				for (const model of models) {
					pi.registerProvider(model.provider, {
						api: "openai-completions",
						baseUrl: model.baseUrl,
						apiKey: `fixture-only-${model.provider}`,
						models: [model],
						streamSimple: (selected: any) => {
							requests.push(selected.provider);
							const stream = createAssistantMessageEventStream();
							queueMicrotask(() => {
								const reject = selected.provider !== "quota-c";
								const message: any = {
									role: "assistant",
									content: reject ? [] : [{ type: "text", text: "OK" }],
									api: selected.api,
									provider: selected.provider,
									model: selected.id,
									stopReason: reject ? "error" : "stop",
									timestamp: Date.now(),
									...(reject
										? { errorMessage: "You exceeded your current quota" }
										: {}),
									usage: {
										input: 1,
										output: 1,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 2,
										cost: {
											input: 0,
											output: 0,
											cacheRead: 0,
											cacheWrite: 0,
											total: 0,
										},
									},
								};
								if (reject) stream.push({ type: "error", reason: "error", error: message });
								else stream.push({ type: "done", reason: "stop", message });
								stream.end();
							});
							return stream;
						},
					});
				}
			},
			multiAccount,
		],
	});
	await loader.reload();
	const result = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		resourceLoader: loader,
		settingsManager: settings,
		sessionManager: SessionManager.inMemory(dir),
		model: models[0],
		tools: [],
	});
	assert.deepEqual(result.extensionsResult.errors, []);
	const session = result.session;
	try {
		await session.bindExtensions({
			mode: "print",
			onError: (error: any) => {
				throw new Error(JSON.stringify(error));
			},
		});
		await session.prompt("Return OK after recovery");
		await waitFor(() => requests.length >= 3);
		await waitFor(() => session.model?.provider === "quota-c");
		assert.deepEqual(requests, providers);
		assert.equal(session.model?.provider, "quota-c");
		const state = JSON.parse(
			readFileSync(join(dir, "provider-failover-state.json"), "utf8"),
		);
		assert.equal(state.pendingFrom, undefined);
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});
