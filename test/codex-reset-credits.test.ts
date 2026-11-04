import assert from "node:assert/strict";
import test from "node:test";
import {
	CODEX_RESET_CREDITS_CONSUME_URL,
	CODEX_RESET_CREDITS_URL,
	codexResetAskReason,
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

test("only known paid plans may spend credits; free, unknown, and new plan types never do", () => {
	for (const plan of ["pro", "plus", "go", "prolite", "promax", "team", "business", "enterprise", "ent26", "self_serve_business_usage_based", "enterprise_cbp_automation"])
		assert.equal(isPaidCodexPlan(plan), true, plan);
	for (const plan of ["free", "free_workspace", "guest", "unknown", "some_future_plan", "", undefined])
		assert.equal(isPaidCodexPlan(plan), false, String(plan));
	assert.equal(normalizeCodexResetCreditsMode("auto"), "auto");
	assert.equal(normalizeCodexResetCreditsMode("ask"), "ask");
	assert.equal(normalizeCodexResetCreditsMode(true), "off");
	assert.equal(normalizeCodexResetCreditsMode(undefined), "off");
});

test("auto spends only when the natural reset is far; otherwise it asks", () => {
	const base = { mode: "auto" as const, minNaturalResetMs: 6 * HOUR, now: NOW };
	assert.equal(codexResetAskReason({ ...base, naturalResetAt: NOW + 7 * HOUR }), undefined);
	assert.equal(codexResetAskReason({ ...base, naturalResetAt: NOW + 5 * HOUR }), "natural reset is near");
	assert.equal(codexResetAskReason({ ...base, naturalResetAt: undefined }), "natural reset time unknown");
	assert.equal(codexResetAskReason({ ...base, mode: "ask", naturalResetAt: NOW + 100 * HOUR }), "codexResetCredits is ask");
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
