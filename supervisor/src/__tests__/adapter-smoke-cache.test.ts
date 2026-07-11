import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  READ_ONLY_SMOKE_PROBE_VERSION,
  invalidateAdapterReadOnlySmokeCache,
  readAdapterSmokeCache,
  smokeDiagnosticForAdapter,
  writeAdapterSmokeCache,
  type AdapterSmokeCacheRead,
} from "../adapter-smoke-cache";

const checkedAt = "2026-07-07T09:00:00.000Z";
const evaluatedAt = new Date("2026-07-11T09:00:00.000Z");

describe("adapter smoke diagnostics", () => {
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
      ).toMatchObject({ status: "stale", probeVersion: probeVersion ?? null });
    },
  );

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
