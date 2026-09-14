/**
 * `UT-NTF-10` (ADR-173 D11) — missing VAPID configuration DEGRADES.
 *
 * Web push is an optional capability of a self-hosted deployment. A missing
 * optional key must not take the web process down, and the way that guarantee
 * is usually broken is a module-scope `throw` or a top-level
 * `webpush.setVapidDetails(...)` that runs at import time. So this asserts the
 * shape, not just the happy path: resolution is a FUNCTION returning a
 * discriminated result, it never throws, and importing the module with nothing
 * set is harmless.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Importing the module is itself part of the assertion: `NTF-10` is broken by a
// module-scope `throw` or a top-level `setVapidDetails`, and with none of the
// three variables set this import must still be harmless.
import {
  isPushConfigured,
  publicVapidKey,
  resolveVapidConfig,
  VAPID_ENV_VARS,
} from "@/lib/notifications/vapid";

const SAVED: Record<string, string | undefined> = {};

// A syntactically valid pair — `web-push` validates the key lengths, so a
// placeholder string would fail for the wrong reason.
const PUBLIC_KEY =
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkFZAvmiCpg1ylVzFGhDBkIQ5D0n0xmfT2lP0s8Cr3C7TQ2pP5W1bVo";
const PRIVATE_KEY = "dGhpcy1pcy1hLWZha2UtcHJpdmF0ZS1rZXktMzItYnl0ZXMh";

beforeEach(() => {
  for (const name of VAPID_ENV_VARS) {
    SAVED[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of VAPID_ENV_VARS) {
    if (SAVED[name] === undefined) delete process.env[name];
    else process.env[name] = SAVED[name];
  }
});

describe("UT-NTF-10 resolveVapidConfig", () => {
  it("names exactly three environment variables", () => {
    expect(VAPID_ENV_VARS).toHaveLength(3);
  });

  it("reports push unavailable with nothing set, and does not throw", () => {
    const result = resolveVapidConfig();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.missing).toEqual([...VAPID_ENV_VARS]);
    expect(isPushConfigured()).toBe(false);
  });

  it("names every missing variable, not just the first", () => {
    process.env[VAPID_ENV_VARS[0]] = PUBLIC_KEY;

    const result = resolveVapidConfig();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.missing).toEqual([
      VAPID_ENV_VARS[1],
      VAPID_ENV_VARS[2],
    ]);
  });

  it("treats a blank value as unset rather than as configuration", () => {
    process.env[VAPID_ENV_VARS[0]] = "   ";
    process.env[VAPID_ENV_VARS[1]] = PRIVATE_KEY;
    process.env[VAPID_ENV_VARS[2]] = "mailto:ops@example.com";

    const result = resolveVapidConfig();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.missing).toEqual([VAPID_ENV_VARS[0]]);
  });

  it("resolves when all three are present", () => {
    process.env[VAPID_ENV_VARS[0]] = PUBLIC_KEY;
    process.env[VAPID_ENV_VARS[1]] = PRIVATE_KEY;
    process.env[VAPID_ENV_VARS[2]] = "mailto:ops@example.com";

    const result = resolveVapidConfig();

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.config.publicKey).toBe(PUBLIC_KEY);
    expect(result.ok === true && result.config.subject).toBe(
      "mailto:ops@example.com",
    );
    expect(isPushConfigured()).toBe(true);
  });

  it("never returns the private key to a caller asking what is public", () => {
    process.env[VAPID_ENV_VARS[0]] = PUBLIC_KEY;
    process.env[VAPID_ENV_VARS[1]] = PRIVATE_KEY;
    process.env[VAPID_ENV_VARS[2]] = "mailto:ops@example.com";

    // The browser needs the PUBLIC key to subscribe; nothing else may cross.
    expect(JSON.stringify(publicVapidKey())).not.toContain(PRIVATE_KEY);
    expect(publicVapidKey()).toBe(PUBLIC_KEY);
  });
});
