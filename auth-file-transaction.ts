/** Pi-compatible cross-process auth lock and crash-safe OAuth shadow publication. */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AuthBlob } from "./slot-proxy-auth.ts";

const require = createRequire(import.meta.url);
type Auth = Record<string, AuthBlob>;
type Plan = { auth: Auth; sidecar: Auth; changed: boolean };

function read(path: string): Auth {
  if (!existsSync(path)) return {};
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("auth storage is not an object");
  return value;
}

function atomicWrite(path: string, data: Auth): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, "\t")}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

function ensureAuthFile(authPath: string): void {
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  if (!existsSync(authPath)) {
    try { writeFileSync(authPath, "{}\n", { mode: 0o600, flag: "wx" }); }
    catch (error: any) { if (error?.code !== "EEXIST") throw error; }
  }
}

// Pi's FileAuthStorageBackend value: the lock's staleness and how long a waiter keeps trying.
const AUTH_LOCK_STALE_MS = 30_000;
// Pi's sync lock path (constructor reload) uses proper-lockfile's default 10 s staleness, so the
// holder must refresh the lock's mtime well inside that, not at the default stale / 2 = 15 s.
const AUTH_LOCK_UPDATE_MS = 5_000;

/** Acquire auth.json's lock with the path, staleness and retry deadline Pi's backend uses. */
async function acquireAuthLock(
  authPath: string,
  signal: AbortSignal | undefined,
  onCompromised: ((error: Error) => void) | undefined,
): Promise<() => Promise<void>> {
  const lockfile = require("proper-lockfile") as {
    lock(path: string, options: object): Promise<() => Promise<void>>;
  };
  const deadline = Date.now() + AUTH_LOCK_STALE_MS;
  for (let retry = 0; ; retry++) {
    signal?.throwIfAborted();
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(authPath, {
        realpath: false,
        retries: 0,
        stale: AUTH_LOCK_STALE_MS,
        update: AUTH_LOCK_UPDATE_MS,
        // proper-lockfile's default throws from a timer, which would crash Pi. A compromise can
        // be noticed mid-exchange; modify() still writes the rotated token (re-reading the file
        // first) because dropping it would lose the only live credential.
        onCompromised: (error: Error) => {
          try { onCompromised?.(error); } catch { /* never throw from proper-lockfile's timer */ }
        },
      });
    } catch (error: any) {
      const remainingMs = deadline - Date.now();
      if (error?.code !== "ELOCKED" || remainingMs <= 0) throw error;
      const baseDelayMs = Math.min(10 * 2 ** retry, 1_000);
      await sleep(Math.min(Math.round(baseDelayMs * (1 + Math.random())), remainingMs), undefined, { signal });
      continue;
    }
    if (signal?.aborted) {
      await release().catch(() => {});
      signal.throwIfAborted();
    }
    return release;
  }
}

/**
 * Pi >= 0.87 no longer exposes its AuthStorage to extensions. This is the same locked
 * read-modify-write Pi performs on auth.json, so an extension refresh and one in Pi core or
 * another Pi window never spend the same one-use refresh token at once.
 */
export function lockedAuthFileStorage(authPath: string, onCompromised?: (error: Error) => void) {
  return {
    async modify(
      provider: string,
      fn: (current: AuthBlob | undefined) => AuthBlob | undefined | Promise<AuthBlob | undefined>,
      options?: { signal?: AbortSignal },
    ): Promise<AuthBlob | undefined> {
      ensureAuthFile(authPath);
      const release = await acquireAuthLock(authPath, options?.signal, onCompromised);
      try {
        const current = read(authPath)[provider];
        const next = await fn(current);
        if (next === undefined) return current;
        // Re-read after the (possibly slow) callback so a writer that ignores the lock, such as
        // a window still running older code, keeps its changes to every other entry.
        atomicWrite(authPath, { ...read(authPath), [provider]: next });
        return next;
      } finally {
        await release().catch(() => {});
      }
    },
    /** Remove one entry under the same lock, keeping every other entry from the latest file. */
    async delete(provider: string, options?: { signal?: AbortSignal }): Promise<void> {
      ensureAuthFile(authPath);
      const release = await acquireAuthLock(authPath, options?.signal, onCompromised);
      try {
        const { [provider]: removed, ...rest } = read(authPath);
        if (removed !== undefined) atomicWrite(authPath, rest);
      } finally {
        await release().catch(() => {});
      }
    },
  };
}

export function mutateProxyAuth(
  authPath: string,
  sidecarPath: string,
  transform: (auth: Auth, sidecar: Auth) => Plan,
  mode: "shadow" | "restore",
  write: (path: string, data: Auth) => void = atomicWrite,
): boolean {
  ensureAuthFile(authPath);
  // Same package and lock path as Pi FileAuthStorageBackend. Never read a snapshot before locking.
  // Pi's async lock refreshes its mtime only every 15 s, so the default 10 s staleness would
  // delete a live lock mid-refresh; use the async lock's 30 s instead.
  const lockfile = require("proper-lockfile") as { lockSync(path: string, options: object): () => void };
  const release = lockfile.lockSync(authPath, { realpath: false, stale: AUTH_LOCK_STALE_MS });
  try {
    const plan = transform(read(authPath), read(sidecarPath));
    if (!plan.changed) return false;
    if (mode === "shadow") {
      // Persist the only recoverable OAuth copy BEFORE replacing auth with a placeholder.
      write(sidecarPath, plan.sidecar);
      write(authPath, plan.auth);
    } else {
      // Restore the real credential BEFORE removing its recovery copy.
      write(authPath, plan.auth);
      write(sidecarPath, plan.sidecar);
    }
    return true;
  } finally { release(); }
}
