import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockedAuthFileStorage, mutateProxyAuth } from "../auth-file-transaction.ts";
import { applyRestoreAll, applyShadowAll, mergeParentAuth } from "../slot-proxy-auth.ts";

const lockfile = createRequire(import.meta.url)("proper-lockfile");
const slot = "openai-codex-account-2";
const token = { type: "oauth", access: "fixture-access", refresh: "fixture-refresh" };

test("shadow and restore keep a recoverable token across each interrupted write", () => {
  const root = mkdtempSync(join(tmpdir(), "auth-transaction-"));
  const auth = join(root, "auth.json"), sidecar = join(root, "sidecar.json");
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  try {
    writeFileSync(auth, JSON.stringify({ [slot]: token }));
    let writes = 0;
    const interrupted = (path: string, data: object) => {
      if (++writes === 2) throw new Error("simulated crash");
      writeFileSync(path, JSON.stringify(data));
    };
    assert.throws(() => mutateProxyAuth(auth, sidecar,
      (a, s) => applyShadowAll([slot], a, s), "shadow", interrupted), /simulated crash/);
    assert.deepEqual(read(auth)[slot], token);
    assert.deepEqual(read(sidecar)[slot], token);
    mutateProxyAuth(auth, sidecar, (a, s) => applyShadowAll([slot], a, s), "shadow");
    assert.deepEqual(mergeParentAuth(read(auth), read(sidecar))[slot], token);
    writes = 0;
    assert.throws(() => mutateProxyAuth(auth, sidecar, applyRestoreAll, "restore", interrupted), /simulated crash/);
    assert.deepEqual(read(auth)[slot], token);
    assert.deepEqual(read(sidecar)[slot], token);
    mutateProxyAuth(auth, sidecar, applyRestoreAll, "restore");
    assert.deepEqual(read(sidecar), {});
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi's auth lock blocks shadow mutation and the later transaction preserves concurrent login", () => {
  const root = mkdtempSync(join(tmpdir(), "auth-lock-"));
  const auth = join(root, "auth.json"), sidecar = join(root, "sidecar.json");
  try {
    writeFileSync(auth, JSON.stringify({ [slot]: token }));
    const release = lockfile.lockSync(auth, { realpath: false });
    let called = false;
    try {
      assert.throws(() => mutateProxyAuth(auth, sidecar, (a, s) => {
        called = true; return applyShadowAll([slot], a, s);
      }, "shadow"), /already being held/);
      assert.equal(called, false);
      writeFileSync(auth, JSON.stringify({ [slot]: token, concurrent: { type: "api_key", key: "fixture-new" } }));
    } finally { release(); }
    mutateProxyAuth(auth, sidecar, (a, s) => applyShadowAll([slot], a, s), "shadow");
    assert.equal(JSON.parse(readFileSync(auth, "utf8")).concurrent.key, "fixture-new");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a refresh holding the auth lock past 10 s is not broken by Pi's sync lock path", async () => {
  // Pi's AuthStorage constructor takes the lock with lockSync's default 10 s staleness. A holder
  // that refreshes the lock's mtime only every 15 s would have it deleted mid-refresh. Wait 12 s:
  // proper-lockfile may stamp a new lock's mtime up to 1 s ahead.
  const root = mkdtempSync(join(tmpdir(), "auth-lock-stale-"));
  const auth = join(root, "auth.json");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    writeFileSync(auth, JSON.stringify({ [slot]: token }));
    const holder = lockedAuthFileStorage(auth).modify(slot, async () => { await gate; return undefined; });
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    assert.throws(() => lockfile.lockSync(auth, { realpath: false }), { code: "ELOCKED" });
    release();
    await holder;
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("locked delete waits for Pi's auth lock and removes only its entry from the latest file", async () => {
  const root = mkdtempSync(join(tmpdir(), "auth-delete-"));
  const auth = join(root, "auth.json");
  try {
    writeFileSync(auth, JSON.stringify({ [slot]: token, kept: { type: "api_key", key: "fixture-kept" } }));
    const release = lockfile.lockSync(auth, { realpath: false });
    const pending = lockedAuthFileStorage(auth).delete(slot);
    // A login lands while the lock is held; the delete must not overwrite it.
    writeFileSync(auth, JSON.stringify({ ...JSON.parse(readFileSync(auth, "utf8")), concurrent: { type: "api_key", key: "fixture-new" } }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(JSON.parse(readFileSync(auth, "utf8"))[slot], "delete must wait for the lock");
    release();
    await pending;
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(auth, "utf8"))).sort(), ["concurrent", "kept"]);
    await lockedAuthFileStorage(auth).delete("absent");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(auth, "utf8"))).sort(), ["concurrent", "kept"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
