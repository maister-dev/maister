// ADR-165 T2.1 — host identity + state store (H1–H7).
import { mkdtemp, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HostKeyConflictError,
  HostStateUnwritableError,
  HOST_KEY_PATTERN,
  openHostState,
} from "../host-state";

import {
  bootHost,
  cleanupRuntimeRoot,
  type BootedHost,
} from "./_fixtures/boot-host";

const booted: BootedHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const host of booted.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await cleanupRuntimeRoot(root);
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eh-identity-"));

  roots.push(root);

  return root;
}

describe("execution-host identity", () => {
  it("H1: a fresh state dir mints a key matching the pattern and /health reports it with a bootId", async () => {
    const host = await bootHost({ runtimeRoot: await tempRoot() });

    booted.push(host);
    const res = await fetch(`${host.url}/health`);
    const body = (await res.json()) as {
      host: { hostKey: string; bootId: string; protocolVersion: number };
    };

    expect(res.status).toBe(200);
    expect(body.host.hostKey).toMatch(HOST_KEY_PATTERN);
    expect(body.host.hostKey.startsWith("eh_")).toBe(true);
    expect(body.host.hostKey).toBe(host.hostState.hostKey);
    expect(body.host.bootId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.host.protocolVersion).toBe(1);
  });

  it("H2: reopening the same state dir keeps the key and mints a new bootId", async () => {
    const root = await tempRoot();
    const stateDir = join(root, "state");
    const first = openHostState({ stateDir });
    const firstKey = first.hostKey;
    const firstBoot = first.bootId;

    first.close();
    const second = openHostState({ stateDir });

    expect(second.hostKey).toBe(firstKey);
    expect(second.bootId).not.toBe(firstBoot);
    second.close();
  });

  it("H3: a pin on a fresh dir becomes the stored key", async () => {
    const root = await tempRoot();
    const state = openHostState({
      stateDir: join(root, "s"),
      pinnedKey: "eh_pinned_key_001",
    });

    expect(state.hostKey).toBe("eh_pinned_key_001");
    state.close();

    const reopened = openHostState({ stateDir: join(root, "s") });

    expect(reopened.hostKey).toBe("eh_pinned_key_001");
    reopened.close();
  });

  it("H4: a pin equal to the stored key boots", async () => {
    const root = await tempRoot();
    const state = openHostState({ stateDir: join(root, "s") });
    const key = state.hostKey;

    state.close();
    const reopened = openHostState({
      stateDir: join(root, "s"),
      pinnedKey: key,
    });

    expect(reopened.hostKey).toBe(key);
    reopened.close();
  });

  it("H5: a pin that conflicts with the stored key refuses to open, naming both prefixes", async () => {
    const root = await tempRoot();
    const state = openHostState({ stateDir: join(root, "s") });
    const stored = state.hostKey;

    state.close();

    let caught: unknown;

    try {
      openHostState({
        stateDir: join(root, "s"),
        pinnedKey: "eh_other_key_0002",
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HostKeyConflictError);
    const conflict = caught as HostKeyConflictError;

    expect(conflict.storedKeyPrefix).toBe(stored.slice(0, 8));
    expect(conflict.pinnedKeyPrefix).toBe("eh_other");
    expect(conflict.message).not.toContain(stored.slice(8));

    // The stored identity is untouched by the refused boot.
    const reopened = openHostState({ stateDir: join(root, "s") });

    expect(reopened.hostKey).toBe(stored);
    reopened.close();
  });

  it("H6: an unwritable state dir throws HostStateUnwritableError", async () => {
    if (process.getuid?.() === 0) return; // root ignores mode bits

    const root = await tempRoot();
    const locked = join(root, "locked");

    await mkdir(locked);
    await chmod(locked, 0o500);

    try {
      expect(() =>
        openHostState({ stateDir: join(locked, "execution-host") }),
      ).toThrow(HostStateUnwritableError);
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it("H7: /health carries no filesystem path and no state-dir string", async () => {
    const root = await tempRoot();
    const host = await bootHost({ runtimeRoot: root });

    booted.push(host);
    const text = await (await fetch(`${host.url}/health`)).text();

    expect(text).not.toContain(root);
    expect(text).not.toContain(host.stateDir);
    expect(text).not.toContain("/");
  });
});
