import assert from "node:assert/strict";
import test from "node:test";
import {
	CODEX_RESET_CREDITS_CONSUME_URL,
	CODEX_RESET_CREDITS_URL,
	codexExhaustion,
	decideCodexReset,
	fetchCodexResetCredits,
	isPaidCodexPlan,
	normalizeCodexResetCreditsMode,
	parseCodexResetCreditList,
	redeemCodexResetCredit,
	soonestExpiringCredit,
} from "../codex-reset-credits.ts";

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

const LIST_BODY = {
	credits: [
		{ id: "late", reset_type: "codex_rate_limits", status: "available", expires_at: "2026-12-01T22:24:17Z", title: "Full reset" },
		{ id: "never", reset_type: "codex_rate_limits", status: "available", expires_at: null },
		{ id: "soonest", reset_type: "codex_rate_limits", status: "available", expires_at: "2026-11-06T23:19:05.806973Z" },
		{ id: "spent", reset_type: "codex_rate_limits", status: "redeemed", expires_at: "2026-10-02T00:00:00Z" },
		{ id: "expired", reset_type: "codex_rate_limits", status: "available", expires_at: "2026-09-01T00:00:00Z" },
		{ id: "other", reset_type: "something_else", status: "available", expires_at: "2026-10-02T00:00:00Z" },
	],
	available_count: 4,
};

test("the soonest-expiring usable credit is chosen; non-expiring credits go last", () => {
	const list = parseCodexResetCreditList(LIST_BODY);
	assert.equal(list.availableCount, 4);
	assert.equal(soonestExpiringCredit(list, NOW)?.id, "soonest");
	const onlyNever = parseCodexResetCreditList({ credits: [LIST_BODY.credits[1]], available_count: 1 });
	assert.equal(soonestExpiringCredit(onlyNever, NOW)?.id, "never");
	assert.equal(soonestExpiringCredit(parseCodexResetCreditList({}), NOW), undefined);
});

test("only paid plans may spend credits; an unknown plan never does", () => {
	for (const plan of ["pro", "plus", "team", "business", "enterprise"]) assert.equal(isPaidCodexPlan(plan), true, plan);
	for (const plan of ["free", "free_workspace", "guest", "", undefined]) assert.equal(isPaidCodexPlan(plan), false, String(plan));
	assert.equal(normalizeCodexResetCreditsMode("auto"), "auto");
	assert.equal(normalizeCodexResetCreditsMode("ask"), "ask");
	assert.equal(normalizeCodexResetCreditsMode(true), "off");
	assert.equal(normalizeCodexResetCreditsMode(undefined), "off");
});

test("exhaustion uses the latest maxed window as the natural reset", () => {
	assert.deepEqual(
		codexExhaustion({
			primary: { usedPercent: 100, resetAt: NOW + 2 * HOUR },
			secondary: { usedPercent: 100, resetAt: NOW + 72 * HOUR },
		}, NOW),
		{ exhausted: true, naturalResetAt: NOW + 72 * HOUR },
	);
	assert.deepEqual(
		codexExhaustion({ primary: { usedPercent: 88, resetAt: NOW + HOUR } }, NOW),
		{ exhausted: false },
	);
	// limit_reached with a rounded-down window still counts, using that window's reset.
	assert.deepEqual(
		codexExhaustion({ serviceable: false, primary: { usedPercent: 99, resetAt: NOW + 30 * HOUR } }, NOW),
		{ exhausted: true, naturalResetAt: NOW + 30 * HOUR },
	);
	assert.deepEqual(codexExhaustion({ serviceable: false }, NOW), { exhausted: true, naturalResetAt: undefined });
	assert.deepEqual(
		codexExhaustion({ serviceable: true, primary: { usedPercent: 100, resetAt: NOW + HOUR } }, NOW),
		{ exhausted: false },
	);
});

test("auto spends only when the natural reset is far; otherwise it asks", () => {
	const credit = { id: "c", resetType: "codex_rate_limits", status: "available" };
	const base = { mode: "auto" as const, plan: "pro", exhausted: true, credit, minNaturalResetMs: 6 * HOUR, now: NOW };
	assert.deepEqual(decideCodexReset({ ...base, naturalResetAt: NOW + 7 * HOUR }), { action: "redeem" });
	assert.equal(decideCodexReset({ ...base, naturalResetAt: NOW + 5 * HOUR }).action, "ask");
	assert.equal(decideCodexReset({ ...base, naturalResetAt: undefined }).action, "ask");
	assert.equal(decideCodexReset({ ...base, mode: "ask", naturalResetAt: NOW + 100 * HOUR }).action, "ask");
	assert.equal(decideCodexReset({ ...base, mode: "off", naturalResetAt: NOW + 100 * HOUR }).action, "skip");
	assert.equal(decideCodexReset({ ...base, plan: "free", naturalResetAt: NOW + 100 * HOUR }).action, "skip");
	assert.equal(decideCodexReset({ ...base, exhausted: false, naturalResetAt: NOW + 100 * HOUR }).action, "skip");
	assert.equal(decideCodexReset({ ...base, credit: undefined, naturalResetAt: NOW + 100 * HOUR }).action, "skip");
});

test("list and consume speak Codex's wire contract", async () => {
	const calls: Array<{ url: string; method?: string; headers: Headers; body?: any }> = [];
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		calls.push({
			url,
			method: init?.method,
			headers: new Headers(init?.headers),
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		const body = url === CODEX_RESET_CREDITS_URL ? LIST_BODY : { code: "reset", windows_reset: 2, credit: { id: "soonest" } };
		return new Response(JSON.stringify(body), { status: 200 });
	}) as typeof fetch;
	const credential = { access: "tok", accountId: "acct" };
	const list = await fetchCodexResetCredits(credential, { fetchImpl });
	const result = await redeemCodexResetCredit(credential, { redeemRequestId: "req-1", creditId: soonestExpiringCredit(list, NOW)?.id }, { fetchImpl });
	assert.deepEqual(result, { code: "reset", windowsReset: 2 });
	assert.equal(calls[0].method, "GET");
	assert.equal(calls[0].headers.get("authorization"), "Bearer tok");
	assert.equal(calls[0].headers.get("chatgpt-account-id"), "acct");
	assert.equal(calls[1].url, CODEX_RESET_CREDITS_CONSUME_URL);
	assert.equal(calls[1].method, "POST");
	assert.deepEqual(calls[1].body, { redeem_request_id: "req-1", credit_id: "soonest" });
});

test("an unknown consume outcome retries once with the same idempotency key; a 4xx never retries", async () => {
	const bodies: any[] = [];
	let failNext = true;
	const flaky = (async (_url: string, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)));
		if (failNext) {
			failNext = false;
			return new Response("upstream", { status: 502 });
		}
		return new Response(JSON.stringify({ code: "already_redeemed" }), { status: 200 });
	}) as typeof fetch;
	const result = await redeemCodexResetCredit({ access: "tok" }, { redeemRequestId: "same-key" }, { fetchImpl: flaky });
	assert.equal(result.code, "already_redeemed");
	assert.deepEqual(bodies.map((body) => body.redeem_request_id), ["same-key", "same-key"]);

	let attempts = 0;
	const refused = (async () => {
		attempts++;
		return new Response("nope", { status: 403 });
	}) as typeof fetch;
	await assert.rejects(redeemCodexResetCredit({ access: "tok" }, { redeemRequestId: "k" }, { fetchImpl: refused }), /HTTP 403/);
	assert.equal(attempts, 1);
});
