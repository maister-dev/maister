import { describe, expect, it } from "vitest";

import {
  smokeDiagnosticForAdapter,
  type AdapterSmokeCacheRead,
} from "../adapter-smoke-cache";

const checkedAt = "2026-07-07T09:00:00.000Z";

describe("adapter smoke diagnostics", () => {
  it("surfaces nested read-only-session evidence from the cache", () => {
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
          },
        } as never,
      },
      error: null,
    };

    expect(smokeDiagnosticForAdapter("opencode", cache)).toEqual({
      status: "ok",
      reason: null,
      checkedAt,
      protocolVersion: 1,
      readOnlySession: {
        status: "ok",
        reason: null,
        checkedAt,
        protocolVersion: 1,
      },
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
    };

    expect(
      smokeDiagnosticForAdapter("opencode", cache).readOnlySession,
    ).toEqual({
      status: "pending",
      reason: "opencode read-only-session smoke has not been cached",
      checkedAt: null,
      protocolVersion: null,
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
    };

    expect(
      smokeDiagnosticForAdapter("opencode", cache).readOnlySession,
    ).toEqual({
      status: "skipped",
      reason:
        "opencode read-only-session smoke ignored because adapter ACP compatibility smoke is skipped: binary missing",
      checkedAt,
      protocolVersion: null,
    });
  });
});
