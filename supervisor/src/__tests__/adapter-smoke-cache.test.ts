import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  READ_ONLY_SMOKE_PROBE_VERSION,
  invalidateAdapterReadOnlySmokeCache,
  readAdapterSmokeCache,
  smokeDiagnosticForAdapter,
  writeAdapterSmokeCache,
  type AdapterSmokeCacheRead,
} from "../adapter-smoke-cache";
import { withAdapterSmokeCacheLock } from "../adapter-smoke-cache-lock";

const checkedAt = "2026-07-07T09:00:00.000Z";
const evaluatedAt = new Date("2026-07-11T09:00:00.000Z");
const here = dirname(fileURLToPath(import.meta.url));
const supervisorRoot = resolve(here, "../..");
const lockHolderFixture = join(
  here,
  "fixtures",
  "hold-adapter-smoke-cache-lock.ts",
);

async function waitForLockHolder(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  await new Promise<void>((resolveHolder, reject) => {
    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => {
      reject(new Error(`cache lock holder did not start: ${output}`));
    }, 5_000);

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("acquired\n")) {
        clearTimeout(timeout);
        resolveHolder();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString();
    });
    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `cache lock holder exited before acquiring (code=${code}, signal=${signal}): ${output}${errorOutput}`,
        ),
      );
    });
  });
}

describe("adapter smoke diagnostics", () => {
  it("releases the cache mutex when a holder process is killed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "maister-smoke-cache-"));
    const cachePath = join(directory, "adapter-smoke-cache.json");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", lockHolderFixture, cachePath],
      { cwd: supervisorRoot, stdio: ["pipe", "pipe", "pipe"] },
    );

    try {
      await waitForLockHolder(child);
      child.kill("SIGKILL");
      await once(child, "exit");

      await expect(
        withAdapterSmokeCacheLock(cachePath, async () => "reacquired"),
      ).resolves.toBe("reacquired");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);

  it("serializes a read-only invalidation and write against a generic smoke result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "maister-smoke-cache-"));
    const cachePath = join(directory, "adapter-smoke-cache.json");
    let releaseFirst: (() => void) | undefined;
    let firstEntered: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstEnteredGate = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    await writeAdapterSmokeCache(cachePath, [
      {
        adapter: "opencode",
        status: "ok",
        readOnlySession: { status: "ok" },
      },
    ]);

    const readOnlySmoke = withAdapterSmokeCacheLock(cachePath, async () => {
      await invalidateAdapterReadOnlySmokeCache(cachePath, "opencode");
      firstEntered?.();
      await firstGate;
      await writeAdapterSmokeCache(cachePath, [
        {
          adapter: "opencode",
          status: "ok",
          readOnlySession: { status: "ok" },
        },
      ]);
    });

    await firstEnteredGate;
    let genericSmokeEntered = false;
    const genericSmoke = withAdapterSmokeCacheLock(cachePath, async () => {
      genericSmokeEntered = true;
      await writeAdapterSmokeCache(cachePath, [
        {
          adapter: "opencode",
          status: "error",
          reason: "generic probe failed",
        },
      ]);
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(genericSmokeEntered).toBe(false);

    releaseFirst?.();
    await Promise.all([readOnlySmoke, genericSmoke]);

    const cache = await readAdapterSmokeCache(cachePath);

    expect(cache.entries.opencode).toMatchObject({
      status: "error",
      reason: "generic probe failed",
    });
    expect(cache.entries.opencode?.readOnlySession).toBeUndefined();
  });

  it("surfaces nested read-only-session and capability-enforcement evidence from the cache", () => {
    const cache: AdapterSmokeCacheRead = {
      entries: {
        opencode: {
          status: "ok",
          checkedAt,
          protocolVersion: 1,
          readOnlySession: {
            status: "ok",
            checkedAt,
            protocolVersion: 1,
            probeVersion: READ_ONLY_SMOKE_PROBE_VERSION,
          },
          capabilityEnforcement: {
            status: "ok",
            checkedAt,
            protocolVersion: 1,
          },
        } as never,
      },
      error: null,
      cacheVersion: 2,
    };

    expect(smokeDiagnosticForAdapter("opencode", cache, evaluatedAt)).toEqual({
      status: "ok",
      reason: null,
      checkedAt,
      protocolVersion: 1,
      readOnlySession: {
        status: "ok",
        reason: null,
        checkedAt,
        protocolVersion: 1,
        probeVersion: READ_ONLY_SMOKE_PROBE_VERSION,
        staleReason: null,
      },
      capabilityEnforcement: {
        status: "ok",
        reason: null,
        checkedAt,
        protocolVersion: 1,
      },
    });
  });

  it("surfaces capability-enforcement evidence for claude (generic smoke not_required)", () => {
    const cache: AdapterSmokeCacheRead = {
      entries: {
        claude: {
          status: "ok",
          checkedAt,
          protocolVersion: 1,
          capabilityEnforcement: {
            status: "ok",
            checkedAt,
            protocolVersion: 1,
          },
        } as never,
      },
      error: null,
    };

    const diag = smokeDiagnosticForAdapter("claude", cache);

    // claude's generic + read-only-session dimensions are not_required, but
    // capability-enforcement is required for every adapter (ADR-130).
    expect(diag.status).toBe("not_required");
    expect(diag.readOnlySession.status).toBe("not_required");
    expect(diag.capabilityEnforcement).toEqual({
      status: "ok",
      reason: null,
      checkedAt,
      protocolVersion: 1,
    });
  });

  it("reports pending capability-enforcement evidence when it is not cached", () => {
    const cache: AdapterSmokeCacheRead = {
      entries: {
        opencode: {
          status: "ok",
          checkedAt,
          protocolVersion: 1,
        },
      },
      error: null,
    };

    expect(
      smokeDiagnosticForAdapter("opencode", cache).capabilityEnforcement,
    ).toEqual({
      status: "pending",
      reason: "opencode capability-enforcement smoke has not been cached",
      checkedAt: null,
      protocolVersion: null,
    });
  });

  it("does not accept capability-enforcement ok evidence when generic adapter smoke was skipped", () => {
    const cache: AdapterSmokeCacheRead = {
      entries: {
        opencode: {
          status: "skipped",
          reason: "binary missing",
          checkedAt,
          capabilityEnforcement: {
            status: "ok",
            checkedAt,
            protocolVersion: 1,
          },
        } as never,
      },
      error: null,
    };

    expect(
      smokeDiagnosticForAdapter("opencode", cache).capabilityEnforcement,
    ).toEqual({
      status: "skipped",
      reason:
        "opencode capability-enforcement smoke ignored because adapter ACP compatibility smoke is skipped: binary missing",
      checkedAt,
      protocolVersion: null,
    });
  });

  it("reports pending read-only-session evidence when a required adapter lacks it", () => {
    const cache: AdapterSmokeCacheRead = {
      entries: {
        opencode: {
          status: "ok",
          checkedAt,
          protocolVersion: 1,
        },
      },
      error: null,
      cacheVersion: 2,
    };

    expect(
      smokeDiagnosticForAdapter("opencode", cache, evaluatedAt).readOnlySession,
    ).toEqual({
      status: "pending",
      reason: "opencode read-only-session smoke has not been cached",
      checkedAt: null,
      protocolVersion: null,
      probeVersion: null,
      staleReason: null,
    });
  });

  it("does not accept read-only-session ok evidence when generic adapter smoke was skipped", () => {
    const cache: AdapterSmokeCacheRead = {
      entries: {
        opencode: {
          status: "skipped",
          reason: "binary missing",
          checkedAt,
          readOnlySession: {
            status: "ok",
            checkedAt,
            protocolVersion: 1,
          },
        } as never,
      },
      error: null,
      cacheVersion: 2,
    };

    expect(
      smokeDiagnosticForAdapter("opencode", cache, evaluatedAt).readOnlySession,
    ).toEqual({
      status: "skipped",
      reason:
        "opencode read-only-session smoke ignored because adapter ACP compatibility smoke is skipped: binary missing",
      checkedAt,
      protocolVersion: null,
      probeVersion: null,
      staleReason: null,
    });
  });

  it.each([
    ["cache v1", undefined, checkedAt],
    ["probe mismatch", READ_ONLY_SMOKE_PROBE_VERSION + 1, checkedAt],
    [
      "future timestamp",
      READ_ONLY_SMOKE_PROBE_VERSION,
      "2026-07-12T09:00:00.000Z",
    ],
    [
      "seven-day boundary",
      READ_ONLY_SMOKE_PROBE_VERSION,
      "2026-07-04T09:00:00.000Z",
    ],
  ])(
    "derives stale read-only evidence for %s",
    (caseName, probeVersion, evidenceAt) => {
      const cache: AdapterSmokeCacheRead = {
        entries: {
          opencode: {
            status: "ok",
            checkedAt,
            protocolVersion: 1,
            readOnlySession: {
              status: "ok",
              checkedAt: evidenceAt,
              protocolVersion: 1,
              ...(probeVersion === undefined ? {} : { probeVersion }),
            },
          } as never,
        },
        error: null,
        cacheVersion: caseName === "cache v1" ? 1 : 2,
      };

      expect(
        smokeDiagnosticForAdapter("opencode", cache, evaluatedAt)
          .readOnlySession,
      ).toMatchObject({
        status: "stale",
        probeVersion: probeVersion ?? null,
        staleReason:
          caseName === "cache v1" || caseName === "probe mismatch"
            ? "probe_contract"
            : "freshness",
      });
    },
  );

  it("keeps cache-v1 nested read-only error evidence as an error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "maister-smoke-cache-"));
    const cachePath = join(directory, "adapter-smoke-cache.json");

    try {
      await writeFile(
        cachePath,
        JSON.stringify({
          version: 1,
          adapters: {
            opencode: {
              status: "ok",
              checkedAt,
              protocolVersion: 1,
              readOnlySession: {
                status: "error",
                reason: "permission probe denied unexpectedly",
                checkedAt,
              },
            },
          },
        }),
        "utf8",
      );

      const cache = await readAdapterSmokeCache(cachePath);

      expect(
        smokeDiagnosticForAdapter("opencode", cache, evaluatedAt)
          .readOnlySession,
      ).toEqual({
        status: "error",
        reason: "permission probe denied unexpectedly",
        checkedAt,
        protocolVersion: null,
        probeVersion: null,
        staleReason: null,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes cache v2 with the current read-only probe version", async () => {
    const directory = await mkdtemp(join(tmpdir(), "maister-smoke-cache-"));
    const cachePath = join(directory, "adapter-smoke-cache.json");

    await writeAdapterSmokeCache(cachePath, [
      {
        adapter: "opencode",
        status: "ok",
        protocolVersion: 1,
        readOnlySession: { status: "ok", protocolVersion: 1 },
      },
    ]);

    const written = JSON.parse(await readFile(cachePath, "utf8")) as {
      readonly version: number;
      readonly adapters: {
        readonly opencode: {
          readonly readOnlySession: { readonly probeVersion: number };
        };
      };
    };

    expect(written.version).toBe(2);
    expect(written.adapters.opencode.readOnlySession.probeVersion).toBe(
      READ_ONLY_SMOKE_PROBE_VERSION,
    );
  });

  it("invalidates old read-only ok evidence before a new probe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "maister-smoke-cache-"));
    const cachePath = join(directory, "adapter-smoke-cache.json");

    await writeAdapterSmokeCache(cachePath, [
      {
        adapter: "opencode",
        status: "ok",
        protocolVersion: 1,
        readOnlySession: { status: "ok", protocolVersion: 1 },
      },
    ]);
    await invalidateAdapterReadOnlySmokeCache(cachePath, "opencode");

    const cache = JSON.parse(await readFile(cachePath, "utf8")) as {
      readonly adapters: {
        readonly opencode: {
          readonly readOnlySession: { readonly status: string };
        };
      };
    };

    expect(cache.adapters.opencode.readOnlySession.status).toBe("error");
  });

  it.each([
    ["invalid JSON", "{", "cannot be read"],
    [
      "schema-invalid v2",
      JSON.stringify({
        version: 2,
        adapters: { opencode: { status: "ok" } },
      }),
      "malformed",
    ],
  ])(
    "fails closed for %s cache content",
    async (_caseName, content, expectedReason) => {
      const directory = await mkdtemp(join(tmpdir(), "maister-smoke-cache-"));
      const cachePath = join(directory, "adapter-smoke-cache.json");

      await writeFile(cachePath, content, "utf8");

      const cache = await readAdapterSmokeCache(cachePath);

      expect(cache.entries).toEqual({});
      expect(cache.error).toContain(expectedReason);

      const diagnostic = smokeDiagnosticForAdapter(
        "opencode",
        cache,
        evaluatedAt,
      );

      expect(diagnostic).toMatchObject({
        status: "error",
        reason: cache.error,
        readOnlySession: {
          status: "error",
          reason: cache.error,
        },
      });
    },
  );
});
