import { describe, expect, it } from "vitest";

import {
  smokeDiagnosticForAdapter,
  type AdapterSmokeCacheRead,
} from "../adapter-smoke-cache";

const checkedAt = "2026-07-07T09:00:00.000Z";

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
          },
          capabilityEnforcement: {
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
    // capability-enforcement is required for every adapter (ADR-129).
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
