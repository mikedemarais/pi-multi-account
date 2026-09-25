import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The weekly "Claude Code version check" workflow keeps CLAUDE_CODE_VERSION — which ships inside
// the Anthropic OAuth billing header — in sync with the latest Claude Code release. It failed
// silently for a month: it pushed a branch, then died on the PR-creation call because this repo
// forbids GitHub Actions from opening PRs. Nobody saw a PR, three orphan branches piled up, and
// the constant drifted 48 releases behind (2.1.172 while 2.1.220 was out).
//
// These tests lock the whole class of "the automation quietly edits nothing / lands nowhere":
// the workflow's own text-surgery must still match index.ts, and it must never again depend on
// the one call that cannot succeed here.

const read = (relative: string) =>
	readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const indexSource = read("../index.ts");
const workflow = read("../.github/workflows/claude-code-version-check.yml");

// Byte-for-byte the pattern the workflow greps with.
const WORKFLOW_GREP = `grep -oE 'CLAUDE_CODE_VERSION = "[^"]+"' index.ts`;
const EXTRACT = /CLAUDE_CODE_VERSION = "([^"]+)"/g;

test("the version-check workflow can still find the constant it is supposed to edit", () => {
	assert.ok(
		workflow.includes(WORKFLOW_GREP),
		"the workflow no longer greps with the pattern this test verifies — update both together",
	);

	const matches = [...indexSource.matchAll(EXTRACT)];
	assert.equal(
		matches.length,
		1,
		`expected exactly one CLAUDE_CODE_VERSION assignment in index.ts, found ${matches.length}: ` +
			"the workflow's grep|sed would extract the wrong one (or nothing) and no-op forever",
	);
	assert.match(
		matches[0]![1]!,
		/^\d+\.\d+\.\d+$/,
		"CLAUDE_CODE_VERSION must be a plain x.y.z release string",
	);
});

test("the maintainer bump can unambiguously rewrite the constant", () => {
	// Same substitution the workflow performs, applied here so a reformatted constant (extra
	// spaces, single quotes, a `satisfies` suffix) fails in CI instead of on a Monday at 09:00 UTC.
	const bumped = indexSource.replace(
		/CLAUDE_CODE_VERSION = "[^"]+"/,
		'CLAUDE_CODE_VERSION = "99.99.99"',
	);
	assert.notEqual(bumped, indexSource, "the substitution matched nothing");
	assert.ok(bumped.includes('const CLAUDE_CODE_VERSION = "99.99.99";'));
});

test("the bumped constant is the one that ships in the OAuth billing header", () => {
	// If CLAUDE_CODE_VERSION ever stops feeding the header, keeping it fresh is pointless work.
	assert.ok(
		indexSource.includes("newerClaudeCodeVersion(CLAUDE_CODE_VERSION, detected)") &&
			indexSource.includes("cc_version=${version}"),
		"CLAUDE_CODE_VERSION is no longer the floor of the billing header version",
	);
});

test("a newer locally installed Claude Code wins over the constant, never an older one", async () => {
	const { newerClaudeCodeVersion, parseClaudeCodeVersionOutput } = await import("../index.ts");
	assert.equal(parseClaudeCodeVersionOutput("2.1.290 (Claude Code)\n"), "2.1.290");
	assert.equal(parseClaudeCodeVersionOutput("command not found"), undefined);
	assert.equal(newerClaudeCodeVersion("2.1.281", "2.1.290"), "2.1.290");
	assert.equal(newerClaudeCodeVersion("2.1.281", "2.1.99"), "2.1.281");
	assert.equal(newerClaudeCodeVersion("2.1.281", "2.2.0"), "2.2.0");
	assert.equal(newerClaudeCodeVersion("2.1.281", undefined), "2.1.281");
	assert.equal(newerClaudeCodeVersion("2.1.281", "garbage"), "2.1.281");
});

test("the version check never again depends on GitHub Actions opening a pull request", () => {
	// Comments may name the old call — that is where the history is written down. Only what the
	// runner actually executes counts.
	const executable = workflow
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");

	assert.ok(
		!/gh pr create/.test(executable),
		"this repo forbids Actions from creating PRs — that call fails every run and strands a branch",
	);
	assert.ok(!executable.includes("git push"), "version checks must respect protected main");
	assert.ok(/gh issue create/.test(executable), "new drift needs an actionable tracker");
	assert.ok(/gh issue edit/.test(executable), "recurring drift must update the existing tracker");
	assert.ok(/gh issue list/.test(executable), "look for an existing tracker before creating one");
});
