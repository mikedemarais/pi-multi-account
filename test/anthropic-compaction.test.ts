import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { COMPACTION_BETA, eligible, nativeCompaction, parseSummary, replay } from "../anthropic-compaction.ts";

const base = getModel("anthropic", "claude-opus-5-5") as any;
const slot = { ...base, provider: "anthropic-account-2" };
const block = (content = "SIGNED SUMMARY") => ({ type: "compaction", content, signature: "sig" });
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], api: slot.api, provider: slot.provider, model: slot.id, stopReason: "stop", usage: zero, timestamp: 2 });
const reply = (content = "SIGNED SUMMARY", extra = {}) => new Response(JSON.stringify({ model: slot.id, stop_reason: "compaction", content: [block(content)],
	usage: { iterations: [{ type: "compaction", input_tokens: 100, output_tokens: 20 }, { type: "message", input_tokens: 1, cache_read_input_tokens: 5 }] }, ...extra }));

/** A session whose newest compaction carries a checkpoint, plus a context bound to `model`. */
function session(model = slot, native?: Record<string, unknown>) {
	const sm = SessionManager.inMemory("/tmp");
	sm.appendMessage({ role: "user", content: "old question", timestamp: 1 });
	const kept = sm.appendMessage(assistant("kept answer") as any);
	const summary = "SIGNED SUMMARY";
	sm.appendCompaction(summary, kept, 100, { anthropicNative: { version: 1, provider: slot.provider, model: slot.id, block: block(),
		summaryHash: createHash("sha256").update(summary).digest("hex"), firstKeptEntryId: kept, ...native } }, true);
	sm.appendMessage({ role: "user", content: "new question", timestamp: 3 });
	const ctx: any = { model, sessionManager: sm, getSystemPrompt: () => "SYSTEM", thinkingLevel: "high",
		modelRegistry: { streamSimple: (m: any, c: any, o: any) => streamSimple(m, c, { ...o, apiKey: "sk-ant-api-test" }) } };
	return { sm, ctx, kept };
}

/** The exact Anthropic request pi-ai sends for the session's next turn, after replay. */
async function turn(ctx: any) {
	let sent: any;
	await streamSimple(ctx.model, { systemPrompt: "SYSTEM", messages: convertToLlm(ctx.sessionManager.buildSessionContext().messages) }, {
		apiKey: "sk-ant-api-test", maxRetries: 0, onPayload: (payload: any) => replay(payload, ctx),
		fetch: async (url: any, init: any) => { sent = { headers: new Headers(init.headers), body: JSON.parse(init.body) }; return new Response("{}", { status: 400 }); },
	} as any).result();
	return sent;
}

test("eligibility: direct Claude API slots and documented models only", () => {
	assert(eligible(base) && eligible(slot));
	assert(!eligible({ ...slot, provider: "claude-code" }));
	assert(!eligible({ ...slot, baseUrl: "https://proxy.example.com" }));
	assert(!eligible({ ...slot, id: "claude-haiku-4-5" }));
});

test("replay swaps Pi's summary message for the signed block on the same slot and model", async () => {
	const { ctx } = session();
	const { headers, body } = await turn(ctx);
	assert.deepEqual(body.messages[0], { role: "assistant", content: [block(), { type: "text", text: "kept answer" }] }, "block leads the kept assistant turn");
	assert(!JSON.stringify(body.messages).includes("<summary>"), "text summary no longer sent");
	assert.match(headers.get("anthropic-beta") ?? "", new RegExp(COMPACTION_BETA));
});

test("replay leaves the text summary for another slot, model, edited summary or foreign checkpoint", async () => {
	for (const [label, model, native] of [
		["other slot", { ...slot, provider: "anthropic-account-3" }, undefined],
		["other model", { ...slot, id: "claude-opus-5" }, undefined],
		["edited summary", slot, { summaryHash: "0".repeat(64) }],
		["moved boundary", slot, { firstKeptEntryId: "elsewhere" }],
		["unsigned block", slot, { block: { type: "compaction", content: "x" } }],
	] as const) {
		const { ctx } = session(model as any, native as any);
		const { headers, body } = await turn(ctx);
		assert.equal(body.messages[0].content[0].text.includes("SIGNED SUMMARY"), true, label);
		assert(!(headers.get("anthropic-beta") ?? "").includes(COMPACTION_BETA), label);
	}
});

test("summary parsing requires one signed block and totals every iteration", async () => {
	const parsed = parseSummary(await reply().json(), slot.id);
	assert.equal(parsed.summary, "SIGNED SUMMARY");
	assert.deepEqual(parsed.usage, { input: 101, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 126 });
	for (const bad of [{ stop_reason: "end_turn" }, { model: "claude-opus-5" }, { content: [{ type: "compaction", content: "x" }] }, { usage: { iterations: [] } }]) {
		assert.throws(() => parseSummary({ ...(JSON.parse(JSON.stringify({ model: slot.id, stop_reason: "compaction", content: [block()], usage: { iterations: [{ type: "compaction" }] } }))), ...bad }, slot.id));
	}
});

test("native compaction sends the real prompt, tools and history with the summarize request", async () => {
	const { ctx, kept } = session();
	let request: any;
	const event: any = { signal: new AbortController().signal, customInstructions: "Keep exact identifiers",
		preparation: { firstKeptEntryId: kept, tokensBefore: 1000, previousSummary: "SIGNED SUMMARY", settings: { reserveTokens: 10_000 },
			messagesToSummarize: [{ role: "user", content: "discard me", timestamp: 5 }], turnPrefixMessages: [] } };
	const tools = [{ name: "lookup", description: "Synthetic", parameters: { type: "object", properties: {} } }];
	const result: any = await nativeCompaction(event, ctx, tools, async (url: any, init: any) => {
		request = { url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) };
		return reply("NEW SUMMARY");
	});
	assert.equal(request.url, "https://api.anthropic.com/v1/messages?beta=true");
	assert.match(request.headers.get("anthropic-beta"), new RegExp(COMPACTION_BETA));
	assert.equal(request.headers.get("x-api-key"), "sk-ant-api-test");
	assert.equal(request.body.stream, false);
	assert.equal(request.body.max_tokens, 8000);
	assert.equal(request.body.compaction.type, "summarize");
	assert.match(request.body.compaction.instructions, /Keep exact identifiers$/);
	assert.equal(request.body.system.at(-1).text, "SYSTEM");
	assert.equal(request.body.tools[0].name, "lookup");
	assert.deepEqual(request.body.messages[0].content[0], block(), "compatible prior checkpoint continues natively");
	assert(JSON.stringify(request.body.messages).includes("discard me"));
	assert.equal(result.compaction.summary, "NEW SUMMARY");
	assert.equal(result.compaction.firstKeptEntryId, kept);
	assert.equal(result.compaction.details.anthropicNative.provider, "anthropic-account-2");
	assert.equal(result.compaction.usage.totalTokens, 126);
	assert(result.compaction.usage.cost.total > 0);
});

test("native compaction throws (so Pi's summary runs) on HTTP errors, bad replies and session changes", async () => {
	const { ctx, kept } = session();
	const event: any = { signal: new AbortController().signal, preparation: { firstKeptEntryId: kept, tokensBefore: 1, settings: { reserveTokens: 16_384 },
		messagesToSummarize: [{ role: "user", content: "x", timestamp: 5 }], turnPrefixMessages: [] } };
	await assert.rejects(nativeCompaction(event, ctx, [], async () => new Response("secret prompt echo", { status: 500 })), /^Error: HTTP 500$/);
	await assert.rejects(nativeCompaction(event, ctx, [], async () => reply("x", { stop_reason: "end_turn" })), /no summary \(end_turn\)/);
	await assert.rejects(nativeCompaction(event, ctx, [], async () => new Response("not json")), /invalid JSON response/);
	await assert.rejects(nativeCompaction(event, ctx, [], async () => { ctx.sessionManager.appendMessage({ role: "user", content: "y", timestamp: 6 }); return reply(); }), /session changed/);
	await assert.rejects(nativeCompaction(event, { ...ctx, model: { ...slot, id: "claude-haiku-4-5" } }, [], async () => reply()), /not eligible/);
});
