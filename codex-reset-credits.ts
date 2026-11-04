/**
 * Codex rate-limit reset credits ("banked resets").
 *
 * ChatGPT grants Codex accounts one-shot credits that clear the account's current usage
 * windows. Codex CLI exposes them through `/usage → Redeem reset`; this module speaks the same
 * backend contract (openai/codex `backend-client/src/client/rate_limit_resets.rs`):
 *
 *   GET  {base}/wham/rate-limit-reset-credits          → { credits: [...], available_count }
 *   POST {base}/wham/rate-limit-reset-credits/consume  ← { redeem_request_id, credit_id? }
 *                                                      → { code, windows_reset }
 *
 * `redeem_request_id` is an idempotency key: retrying a request whose outcome is unknown with
 * the SAME key can never spend a second credit. The server answers `nothing_to_reset` instead of
 * spending a credit on an account whose limits are not exhausted.
 *
 * Spending a credit is irreversible, so everything here is a pure decision or a single request;
 * the policy of WHEN to spend lives in index.ts behind the `codexResetCredits` setting.
 */

export const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const CODEX_RESET_CREDITS_CONSUME_URL = `${CODEX_RESET_CREDITS_URL}/consume`;

/** `off` never spends; `ask` always confirms first; `auto` spends unless the natural reset is near. */
export type CodexResetCreditsMode = "off" | "ask" | "auto";

export type CodexResetCredit = {
	id: string;
	resetType: string;
	status: string;
	expiresAt?: number;
	title?: string;
};

export type CodexResetCreditList = {
	credits: CodexResetCredit[];
	availableCount: number;
};

export type CodexResetConsumeCode = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";

export type CodexResetConsumeResult = {
	code: CodexResetConsumeCode;
	windowsReset: number;
};

type Credential = { access?: string; accountId?: string };
type RequestOptions = { fetchImpl?: typeof fetch; timeoutMs?: number };

export class CodexResetCreditError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "CodexResetCreditError";
		this.status = status;
	}
}

export function normalizeCodexResetCreditsMode(value: unknown): CodexResetCreditsMode {
	return value === "auto" || value === "ask" ? value : "off";
}

/**
 * Only paid plans may spend a credit. Free accounts are the last-resort fallback and keep
 * their credits; an unknown plan is treated as free so a missing field can never spend one.
 */
export function isPaidCodexPlan(plan: string | undefined): boolean {
	return typeof plan === "string" && plan.trim() !== "" && !/free|guest/i.test(plan);
}

function timestampMs(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseCodexResetCreditList(body: unknown): CodexResetCreditList {
	const source = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
	const credits = (Array.isArray(source.credits) ? source.credits : []).flatMap((raw) => {
		const credit = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
		if (typeof credit.id !== "string" || !credit.id) return [];
		return [{
			id: credit.id,
			resetType: typeof credit.reset_type === "string" ? credit.reset_type : "unknown",
			status: typeof credit.status === "string" ? credit.status : "unknown",
			expiresAt: timestampMs(credit.expires_at),
			title: typeof credit.title === "string" && credit.title.trim() ? credit.title.trim() : undefined,
		}];
	});
	const count = Number(source.available_count);
	return { credits, availableCount: Number.isFinite(count) ? Math.max(0, count) : 0 };
}

/** The usable credit that expires first; credits without an expiry go last. */
export function soonestExpiringCredit(
	list: CodexResetCreditList,
	now = Date.now(),
): CodexResetCredit | undefined {
	return list.credits
		.filter((credit) =>
			credit.status === "available" &&
			credit.resetType === "codex_rate_limits" &&
			(credit.expiresAt === undefined || credit.expiresAt > now))
		.sort((a, b) => (a.expiresAt ?? Number.POSITIVE_INFINITY) - (b.expiresAt ?? Number.POSITIVE_INFINITY))[0];
}

type Window = { usedPercent: number; resetAt: number };

/**
 * Whether a fresh Codex usage reading shows the account spent, and when it reopens on its own.
 * The latest reset among the maxed windows is the natural recovery time, because every window is
 * a simultaneous constraint. A `limit_reached` verdict with no maxed window (rounding) falls
 * back to the latest future window reset.
 */
export function codexExhaustion(
	snapshot: { serviceable?: boolean; primary?: Window; secondary?: Window },
	now = Date.now(),
): { exhausted: boolean; naturalResetAt?: number } {
	const windows = [snapshot.primary, snapshot.secondary].filter(
		(window): window is Window => !!window && window.resetAt > now,
	);
	const maxed = windows.filter((window) => window.usedPercent >= 100);
	const exhausted = snapshot.serviceable === false || (snapshot.serviceable !== true && maxed.length > 0);
	if (!exhausted) return { exhausted };
	const pool = maxed.length > 0 ? maxed : windows;
	return {
		exhausted,
		naturalResetAt: pool.length > 0 ? Math.max(...pool.map((window) => window.resetAt)) : undefined,
	};
}

export type CodexResetDecision =
	| { action: "skip"; reason: string }
	| { action: "redeem" }
	| { action: "ask"; reason: string };

/**
 * Decide whether an exhausted account should spend a credit.
 *
 * `naturalResetAt` is when the blocking usage windows reopen on their own (undefined when the
 * account reports no usable reset time). A reset that is close makes a credit poor value, so
 * `auto` asks instead of spending; with no UI to ask, the caller treats `ask` as a refusal.
 */
export function decideCodexReset(input: {
	mode: CodexResetCreditsMode;
	plan: string | undefined;
	exhausted: boolean;
	credit: CodexResetCredit | undefined;
	naturalResetAt: number | undefined;
	minNaturalResetMs: number;
	now?: number;
}): CodexResetDecision {
	const now = input.now ?? Date.now();
	if (input.mode === "off") return { action: "skip", reason: "codexResetCredits is off" };
	if (!isPaidCodexPlan(input.plan)) return { action: "skip", reason: `plan ${input.plan ?? "unknown"} keeps its credits` };
	if (!input.exhausted) return { action: "skip", reason: "account is not exhausted" };
	if (!input.credit) return { action: "skip", reason: "no reset credit available" };
	if (input.mode === "ask") return { action: "ask", reason: "codexResetCredits is ask" };
	if (input.naturalResetAt === undefined) return { action: "ask", reason: "natural reset time unknown" };
	if (input.naturalResetAt - now < input.minNaturalResetMs) return { action: "ask", reason: "natural reset is near" };
	return { action: "redeem" };
}

function headers(credential: Credential): Record<string, string> {
	if (!credential.access) throw new CodexResetCreditError("Codex account has no OAuth access token");
	return {
		Authorization: `Bearer ${credential.access}`,
		Accept: "application/json",
		...(credential.accountId ? { "ChatGPT-Account-Id": credential.accountId } : {}),
	};
}

async function requestJson(
	url: string,
	init: RequestInit,
	options: RequestOptions,
): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
	try {
		const response = await (options.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
		if (!response.ok) throw new CodexResetCreditError(`reset credit endpoint returned HTTP ${response.status}`, response.status);
		return await response.json();
	} catch (error) {
		if (error instanceof CodexResetCreditError) throw error;
		if ((error as any)?.name === "AbortError") throw new CodexResetCreditError("reset credit request timed out");
		throw new CodexResetCreditError(`reset credit request failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		clearTimeout(timer);
	}
}

export async function fetchCodexResetCredits(
	credential: Credential,
	options: RequestOptions = {},
): Promise<CodexResetCreditList> {
	return parseCodexResetCreditList(
		await requestJson(CODEX_RESET_CREDITS_URL, { method: "GET", headers: headers(credential) }, options),
	);
}

const CONSUME_CODES = new Set<CodexResetConsumeCode>(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]);

export async function consumeCodexResetCredit(
	credential: Credential,
	request: { redeemRequestId: string; creditId?: string },
	options: RequestOptions = {},
): Promise<CodexResetConsumeResult> {
	if (!request.redeemRequestId) throw new CodexResetCreditError("redeemRequestId must not be empty");
	const body = await requestJson(
		CODEX_RESET_CREDITS_CONSUME_URL,
		{
			method: "POST",
			headers: { ...headers(credential), "Content-Type": "application/json" },
			body: JSON.stringify({
				redeem_request_id: request.redeemRequestId,
				...(request.creditId ? { credit_id: request.creditId } : {}),
			}),
		},
		options,
	);
	const source = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
	const code = source.code as CodexResetConsumeCode;
	if (!CONSUME_CODES.has(code)) throw new CodexResetCreditError(`reset credit endpoint returned unknown code ${String(source.code)}`);
	const windowsReset = Number(source.windows_reset);
	return { code, windowsReset: Number.isFinite(windowsReset) ? windowsReset : 0 };
}

/**
 * Spend one credit, retrying ONCE with the same idempotency key when the outcome is unknown
 * (network failure, timeout, 5xx). A definite 4xx answer is never retried.
 */
export async function redeemCodexResetCredit(
	credential: Credential,
	request: { redeemRequestId: string; creditId?: string },
	options: RequestOptions = {},
): Promise<CodexResetConsumeResult> {
	try {
		return await consumeCodexResetCredit(credential, request, options);
	} catch (error) {
		const status = error instanceof CodexResetCreditError ? error.status : undefined;
		if (status !== undefined && status < 500) throw error;
		return consumeCodexResetCredit(credential, request, options);
	}
}
