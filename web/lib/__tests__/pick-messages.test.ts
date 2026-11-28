// CMSG-06 / CMSG-07 (ADR-225, docs/system-analytics/client-messages.md) —
// verifies `pickMessages` reference semantics, dotted-subtree merging, and
// unknown-path behavior across dev/test vs production.
import { afterEach, describe, expect, it, vi } from "vitest";

const { warnSpy, debugSpy } = vi.hoisted(() => ({
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
}));

vi.mock("pino", () => ({
  default: () => ({
    warn: warnSpy,
    debug: debugSpy,
    isLevelEnabled: () => false,
  }),
}));

import { pickMessages } from "@/i18n/pick-messages";

describe("pickMessages (CMSG-06 / CMSG-07)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    warnSpy.mockClear();
    debugSpy.mockClear();
  });

  it("CMSG-06 copies whole namespaces by reference and picks dotted subtrees without siblings", () => {
    const common = { save: "Save", cancel: "Cancel" };
    const runStatus = { running: "Running" };
    const reasons = { timeout: "Timed out" };
    const catalog = {
      common,
      unused: { secret: "not-for-client" },
      run: {
        runStatus,
        terminalCause: {
          reasons,
          otherNested: { drop: true },
        },
        sibling: { drop: true },
      },
    };

    const picked = pickMessages(catalog, [
      "common",
      "run.runStatus",
      "run.terminalCause.reasons",
    ]);

    expect(picked.common).toBe(common);
    expect(picked).not.toHaveProperty("unused");

    const run = picked.run as Record<string, unknown>;

    expect(Object.keys(run).sort()).toEqual(["runStatus", "terminalCause"]);
    expect(run.runStatus).toBe(runStatus);

    const terminalCause = run.terminalCause as Record<string, unknown>;

    expect(Object.keys(terminalCause)).toEqual(["reasons"]);
    expect(terminalCause.reasons).toBe(reasons);
  });

  it("CMSG-07 throws on an unknown path outside production", () => {
    vi.stubEnv("NODE_ENV", "test");
    const catalog = { common: { ok: "OK" } };

    expect(() => pickMessages(catalog, ["common", "does.not.exist"])).toThrow(
      /does\.not\.exist/,
    );
  });

  it("CMSG-07 omits an unknown path with a WARN in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const common = { ok: "OK" };
    const catalog = { common };

    const picked = pickMessages(catalog, ["common", "does.not.exist"]);

    expect(picked).toEqual({ common });
    expect(picked.common).toBe(common);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ path: "does.not.exist" }),
      expect.any(String),
    );
  });
});
