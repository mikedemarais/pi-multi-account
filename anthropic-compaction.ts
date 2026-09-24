/**
 * Anthropic native (signed) compaction, adapted from pi-anthropic-compat 0.0.5
 * (MIT License, Copyright (c) 2026 Kaan Ozdokmeci).
 *
 * On compaction, ask Anthropic to summarize the discarded range (`compact-2026-09-04`) and
 * store its signed `compaction` block with Pi's compaction entry. The block's plain-text
 * content is the entry's summary, so every other model and account keeps reading ordinary
 * text. On later requests from the same provider slot and model, the summary message is
 * replaced by the signed block. Any failure leaves Pi's ordinary text compaction in charge.
 *
 * Loaded lazily from index.ts (only when the feature is on) because it needs Pi's
 * `convertToLlm`; the rest of the extension avoids value imports from Pi packages.
 */
import { createHash } from "node:crypto";
import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import { convertToLlm, type CompactionEntry, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

export const COMPACTION_BETA = "compact-2026-09-04";
// A non-streamed summary of a large context can take minutes; match the Codex deadline.
const TIMEOUT_MS = 300_000;
// Models Anthropic documents for on-demand compaction (per pi-anthropic-compat 0.0.5).
const MODELS = new Set([
	"claude-fable-5-1", "claude-fable-5", "claude-mythos-5-1", "claude-mythos-5", "claude-mythos-preview",
	"claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
	"claude-sonnet-5", "claude-sonnet-4-6",
]);

type Json = Record<string, any>;
type Model = { provider: string; id: string; api: string; baseUrl: string; maxTokens: number };
export type NativeCheckpoint = { version: 1; provider: string; model: string; block: Json; summaryHash: string; firstKeptEntryId: string };

const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
// Match pi-ai's wire sanitizer: drop lone surrogates, keep valid pairs.
const wireText = (text: string) => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
const withBeta = (payload: Json): Json => ({ ...payload, betas: [...new Set([...(Array.isArray(payload.betas) ? payload.betas : []), COMPACTION_BETA])] });
/** Put the signed block first: at the head of a leading assistant turn, else as its own turn. */
function leadWith(messages: Json[], block: Json): Json[] {
	const [first, ...rest] = messages;
	return first?.role === "assistant" && Array.isArray(first.content)
		? [{ ...first, content: [block, ...first.content] }, ...rest]
		: [{ role: "assistant", content: [block] }, ...messages];
}

export function eligible(model: Model | undefined): model is Model {
	if (!model || model.api !== "anthropic-messages" || !/^anthropic(?:-account-[1-9]\d*)?$/.test(model.provider)) return false;
	try { return new URL(model.baseUrl).origin === "https://api.anthropic.com" && MODELS.has(model.id); } catch { return false; }
}

export function newestCompaction(ctx: ExtensionContext): CompactionEntry | undefined {
	return ctx.sessionManager.getBranch().filter((entry) => entry.type === "compaction").at(-1) as CompactionEntry | undefined;
}

function signedBlock(value: unknown): Json {
	if (!isRecord(value) || value.type !== "compaction" || typeof value.content !== "string" || !value.content.trim()
		|| typeof value.signature !== "string" || !value.signature) throw new Error("no signed compaction block");
	return value;
}

/** The checkpoint on `entry`, only if it belongs to this provider slot and model. */
export function checkpointFor(entry: CompactionEntry | undefined, model: Model): NativeCheckpoint | undefined {
	const native = isRecord(entry?.details) ? entry.details.anthropicNative : undefined;
	if (!entry || !isRecord(native) || native.version !== 1 || native.provider !== model.provider || native.model !== model.id
		|| native.firstKeptEntryId !== entry.firstKeptEntryId || native.summaryHash !== hash(entry.summary)) return undefined;
	try { signedBlock(native.block); } catch { return undefined; }
	return native as NativeCheckpoint;
}

function summaryMessageText(summary: string): string {
	const [message] = convertToLlm([{ role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 } as any]);
	const content = (message as any).content;
	return wireText(typeof content === "string" ? content : content.map((part: any) => part.text ?? "").join(""));
}

/**
 * Replace Pi's text summary message with the signed block. Returns undefined (leave the
 * payload alone) unless exactly one matching summary message exists. The block joins the
 * following assistant turn when one comes next; otherwise it is its own assistant turn.
 */
export function replayCheckpoint(payload: unknown, entry: CompactionEntry | undefined, model: Model): Json | undefined {
	const native = checkpointFor(entry, model);
	if (!native || !isRecord(payload) || payload.model !== model.id || !Array.isArray(payload.messages)) return undefined;
	const text = summaryMessageText(entry!.summary);
	const matches = payload.messages.flatMap((message: Json, index: number) => {
		const content = message?.content;
		const body = typeof content === "string" ? content
			: Array.isArray(content) && content.length === 1 && content[0]?.type === "text" ? content[0].text : undefined;
		return message?.role === "user" && body === text ? [index] : [];
	});
	if (matches.length !== 1) return undefined;
	const at = matches[0];
	const messages = [...payload.messages.slice(0, at), ...leadWith(payload.messages.slice(at + 1), native.block)];
	return withBeta({ ...payload, messages });
}

/** Turn a captured turn request into an on-demand summary request. */
export function summaryPayload(payload: Json, maxTokens: number, instructions?: string): Json {
	const result: Json = { ...payload, stream: false, max_tokens: maxTokens };
	// Betas travel as the anthropic-beta header on the captured request.
	for (const key of ["betas", "context_management", "stop_sequences", "tool_choice", "output_config", "thinking", "fallbacks"]) delete result[key];
	// Keep the selected effort and adaptive thinking; drop structured output and budgets.
	const effort = isRecord(payload.output_config) ? payload.output_config.effort : undefined;
	if (typeof effort === "string") result.output_config = { effort };
	if (isRecord(payload.thinking) && payload.thinking.type === "adaptive") result.thinking = payload.thinking;
	const custom = instructions?.trim();
	if (custom && custom.length > 16_000) throw new Error("compaction instructions exceed 16,000 characters");
	result.compaction = { type: "summarize", instructions: [
		"Write a concise continuation summary. Preserve the user's goals, constraints, decisions, file paths,",
		"completed work, outstanding tasks, and facts needed to continue. Do not call tools. Respond with text only.",
		custom ?? "",
	].join(" ").trim() };
	return result;
}

function tokens(value: unknown): number {
	if (value === undefined || value === null) return 0;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("invalid usage");
	return value;
}

/** Validate the summary response and total the usage of every sampling iteration. */
export function parseSummary(response: Json, modelId: string) {
	if (response.stop_reason !== "compaction") throw new Error(`no summary (${typeof response.stop_reason === "string" ? response.stop_reason : "invalid response"})`);
	if (response.model !== modelId) throw new Error("unexpected summary model");
	if (!Array.isArray(response.content) || response.content.length !== 1) throw new Error("expected one compaction block");
	const block = signedBlock(response.content[0]);
	const iterations = Array.isArray(response.usage?.iterations) ? response.usage.iterations : [];
	if (!iterations.some((item: Json) => item?.type === "compaction")) throw new Error("missing compaction usage");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, totalTokens: 0 };
	for (const item of iterations) {
		usage.input += tokens(item.input_tokens);
		usage.output += tokens(item.output_tokens);
		usage.cacheRead += tokens(item.cache_read_input_tokens);
		usage.cacheWrite += tokens(item.cache_creation_input_tokens);
		usage.cacheWrite1h += tokens(item.cache_creation?.ephemeral_1h_input_tokens);
	}
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return { summary: block.content as string, block, usage };
}

/**
 * Summarize `preparation`'s discarded range natively. Throws on any failure; the caller
 * falls back to Pi's text compaction. The request is serialized by the provider slot's own
 * transport (auth, subscription shaping, cache markers) and captured before transmission.
 */
export async function nativeCompaction(event: SessionBeforeCompactEvent, ctx: ExtensionContext, tools: unknown[], fetcher: typeof fetch = fetch) {
	const model = ctx.model as unknown as Model;
	if (!eligible(model)) throw new Error("model not eligible");
	const signal = AbortSignal.any([event.signal, AbortSignal.timeout(TIMEOUT_MS)]);
	const { preparation } = event;
	const leaf = ctx.sessionManager.getLeafId();
	const previous = newestCompaction(ctx);
	const prior = previous?.summary === preparation.previousSummary ? checkpointFor(previous, model) : undefined;
	const history = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
	if (!history.length) throw new Error("nothing to summarize");
	// A compatible prior checkpoint continues natively; otherwise the prior summary is text.
	const lead = !prior && preparation.previousSummary
		? [{ role: "compactionSummary", summary: preparation.previousSummary, tokensBefore: 0, timestamp: 0 } as any] : [];
	let captured: Request | undefined;
	await ctx.modelRegistry.streamSimple(model as any, {
		systemPrompt: ctx.getSystemPrompt(),
		messages: convertToLlm([...lead, ...history]),
		tools: tools as any,
	}, {
		signal, maxRetries: 0,
		...(ctx.thinkingLevel && ctx.thinkingLevel !== "off" ? { reasoning: ctx.thinkingLevel } : {}),
		// Runs before the slot's own shaping, so billing metadata covers the final messages.
		onPayload: (payload: any) => prior ? { ...payload, messages: leadWith(payload.messages, prior.block) } : undefined,
		fetch: async (input: any, init: any) => {
			captured = new Request(input, init);
			throw new Error("captured without transmission");
		},
	} as any).result();
	signal.throwIfAborted();
	if (!captured) throw new Error("could not serialize request");
	const url = new URL(captured.url);
	if (url.origin !== "https://api.anthropic.com") throw new Error("unexpected endpoint");
	const reserve = Math.floor(0.8 * (preparation.settings?.reserveTokens ?? 16_384));
	const body = summaryPayload(await captured.json(), Math.max(1024, Math.min(reserve, model.maxTokens)), event.customInstructions);
	const headers = new Headers(captured.headers);
	headers.set("anthropic-beta", [...new Set([...(headers.get("anthropic-beta") ?? "").split(",").filter(Boolean), COMPACTION_BETA])].join(","));
	headers.delete("content-length");
	const response = await fetcher(url, { method: "POST", headers, body: JSON.stringify(body), signal, redirect: "error" });
	if (!response.ok) {
		// Never surface provider bodies: they can echo prompts.
		await response.body?.cancel().catch(() => {});
		throw new Error(`HTTP ${response.status}`);
	}
	let parsed: ReturnType<typeof parseSummary>;
	try { parsed = parseSummary(await response.json(), model.id); } catch (error) {
		throw new Error(error instanceof SyntaxError ? "invalid JSON response" : (error as Error).message);
	}
	signal.throwIfAborted();
	if (ctx.sessionManager.getLeafId() !== leaf || ctx.model?.id !== model.id || ctx.model?.provider !== model.provider) throw new Error("session changed");
	const anthropicNative: NativeCheckpoint = { version: 1, provider: model.provider, model: model.id, block: parsed.block,
		summaryHash: hash(parsed.summary), firstKeptEntryId: preparation.firstKeptEntryId };
	const usage: Usage = { ...parsed.usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	usage.cost = calculateCost(model as any, usage);
	return { compaction: { summary: parsed.summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore,
		usage, details: { anthropicNative } } };
}

/** Replay for the foreground request of `ctx`'s session, or undefined when not applicable. */
export function replay(payload: unknown, ctx: ExtensionContext | undefined): Json | undefined {
	const model = ctx?.model as unknown as Model | undefined;
	return ctx && eligible(model) ? replayCheckpoint(payload, newestCompaction(ctx), model) : undefined;
}
