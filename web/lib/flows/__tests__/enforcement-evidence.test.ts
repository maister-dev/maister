import type { AiCodingSettings } from "@/lib/config.schema";
import type { SupervisorDiagnosticsStatus } from "@/lib/execution-host";

import { describe, expect, it, vi } from "vitest";

import { isMaisterError } from "@/lib/errors";
import { assertEnforcementEvidence } from "@/lib/flows/enforcement-evidence";

// ADR-130 T3.3: the async launch evidence gate. Refuses a strict tools/mcps launch
// unless the resolved adapter's capabilityEnforcement smoke === "ok", the runner is
// not skip-permissions, and diagnostics are reachable.

function diagnostics(
  capEnforcement: "ok" | "pending" | "error" | undefined,
): () => Promise<SupervisorDiagnosticsStatus> {
  return async () =>
    ({
      kind: "ready",
      diagnostics: {
        adapters: [
          {
            id: "claude",
            smoke: {
              capabilityEnforcement: capEnforcement
                ? { status: capEnforcement, reason: null }
                : undefined,
            },
          },
        ],
      },
    }) as unknown as SupervisorDiagnosticsStatus;
}

const strictTools = {
  tools: { claude: ["Read"] },
  enforcement: { tools: "strict" },
} as unknown as AiCodingSettings;

async function capture(fn: () => Promise<void>): Promise<unknown> {
  try {
    await fn();

    return null;
  } catch (e) {
    return e;
  }
}

describe("assertEnforcementEvidence", () => {
  it("passes (no diagnostics call) when the node enforces no strict tools/mcps", async () => {
    const check = vi.fn(diagnostics("ok"));

    await assertEnforcementEvidence({
      settings: { tools: { claude: ["Read"] } } as AiCodingSettings, // instruct default
      agent: "claude",
      permissionPolicy: "default",
      checkDiagnostics: check,
    });

    expect(check).not.toHaveBeenCalled();
  });

  it("passes when the adapter's capabilityEnforcement smoke is ok", async () => {
    await expect(
      assertEnforcementEvidence({
        settings: strictTools,
        agent: "claude",
        permissionPolicy: "default",
        checkDiagnostics: diagnostics("ok"),
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses EXECUTOR_UNAVAILABLE when the smoke is pending", async () => {
    const err = await capture(() =>
      assertEnforcementEvidence({
        settings: strictTools,
        agent: "claude",
        permissionPolicy: "default",
        checkDiagnostics: diagnostics("pending"),
      }),
    );

    expect(isMaisterError(err) && err.code).toBe("EXECUTOR_UNAVAILABLE");
    expect((err as Error).message).toMatch(
      /capabilityEnforcement smoke is pending/,
    );
  });

  it("refuses EXECUTOR_UNAVAILABLE when the smoke evidence is missing", async () => {
    const err = await capture(() =>
      assertEnforcementEvidence({
        settings: strictTools,
        agent: "claude",
        permissionPolicy: "default",
        checkDiagnostics: diagnostics(undefined),
      }),
    );

    expect(isMaisterError(err) && err.code).toBe("EXECUTOR_UNAVAILABLE");
  });

  it("refuses EXECUTOR_UNAVAILABLE for a skip-permissions runner (before diagnostics)", async () => {
    const check = vi.fn(diagnostics("ok"));

    const err = await capture(() =>
      assertEnforcementEvidence({
        settings: strictTools,
        agent: "claude",
        permissionPolicy: "dangerously_skip_permissions",
        checkDiagnostics: check,
      }),
    );

    expect(isMaisterError(err) && err.code).toBe("EXECUTOR_UNAVAILABLE");
    expect((err as Error).message).toMatch(/skip_permissions/);
    expect(check).not.toHaveBeenCalled();
  });

  it("refuses EXECUTOR_UNAVAILABLE when diagnostics are unavailable", async () => {
    const err = await capture(() =>
      assertEnforcementEvidence({
        settings: strictTools,
        agent: "claude",
        permissionPolicy: "default",
        checkDiagnostics: async () => ({
          kind: "unavailable",
          reason: "http",
          message: "boom",
        }),
      }),
    );

    expect(isMaisterError(err) && err.code).toBe("EXECUTOR_UNAVAILABLE");
  });
});
