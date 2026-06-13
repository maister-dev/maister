import type {
  SupervisorDiagnostics,
  SupervisorDiagnosticsStatus,
} from "@/lib/supervisor-client";

import { describe, expect, it } from "vitest";

import { type AdapterId } from "@/lib/acp-runners/adapter-support";
import {
  summarizeAdapterReadiness,
  type RunnerReadinessRow,
} from "@/lib/acp-runners/readiness-summary";

type DiagAdapter = SupervisorDiagnostics["adapters"][number];

function diagAdapter(
  id: AdapterId,
  available: boolean,
  smokeStatus: DiagAdapter["smoke"]["status"] = "ok",
): DiagAdapter {
  return {
    id,
    binary: id,
    source: "path",
    path: null,
    available,
    version: null,
    error: null,
    smoke: {
      status: smokeStatus,
      reason: null,
      checkedAt: null,
      protocolVersion: null,
    },
  };
}

function readyDiag(adapters: DiagAdapter[]): SupervisorDiagnosticsStatus {
  return {
    kind: "ready",
    diagnostics: {
      status: "ready",
      version: "1.0.0",
      checkedAt: "2026-06-13T00:00:00.000Z",
      adapters,
      sidecars: [],
      envRefs: [],
    },
  };
}

function runner(
  adapter: AdapterId,
  enabled: boolean,
  readinessStatus: RunnerReadinessRow["readinessStatus"],
  readinessReasons: string[] | null = null,
): RunnerReadinessRow {
  return { adapter, enabled, readinessStatus, readinessReasons };
}

function findAdapter(
  result: ReturnType<typeof summarizeAdapterReadiness>,
  adapter: AdapterId,
) {
  const entry = result.find((item) => item.adapter === adapter);

  if (!entry) throw new Error(`no summary for ${adapter}`);

  return entry;
}

describe("summarizeAdapterReadiness", () => {
  it("returns one entry per supported adapter", () => {
    const result = summarizeAdapterReadiness({
      runners: [],
      diagnostics: null,
    });

    expect(result.map((item) => item.adapter)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
      "mimo",
    ]);
  });

  it("is green when the binary is available and an enabled runner is Ready", () => {
    const result = summarizeAdapterReadiness({
      runners: [runner("claude", true, "Ready")],
      diagnostics: readyDiag([diagAdapter("claude", true)]),
    });

    expect(findAdapter(result, "claude")).toMatchObject({
      state: "green",
      cause: "ready",
      detail: null,
    });
  });

  it("is amber 'no_runner' when available with no runners configured", () => {
    const result = summarizeAdapterReadiness({
      runners: [],
      diagnostics: readyDiag([diagAdapter("codex", true)]),
    });

    expect(findAdapter(result, "codex")).toMatchObject({
      state: "amber",
      cause: "no_runner",
    });
  });

  it("is amber 'all_disabled' when the only runner is disabled", () => {
    const result = summarizeAdapterReadiness({
      runners: [runner("gemini", false, "Ready")],
      diagnostics: readyDiag([diagAdapter("gemini", true)]),
    });

    expect(findAdapter(result, "gemini")).toMatchObject({
      state: "amber",
      cause: "all_disabled",
    });
  });

  it("is amber 'not_ready' and surfaces the first blocking reason", () => {
    const result = summarizeAdapterReadiness({
      runners: [
        runner("opencode", true, "NotReady", [
          "env ref is missing: OPENCODE_KEY",
        ]),
      ],
      diagnostics: readyDiag([diagAdapter("opencode", true)]),
    });

    expect(findAdapter(result, "opencode")).toMatchObject({
      state: "amber",
      cause: "not_ready",
      detail: "env ref is missing: OPENCODE_KEY",
    });
  });

  it("hides an adapter whose binary is unavailable even if a runner reads Ready", () => {
    const result = summarizeAdapterReadiness({
      runners: [runner("mimo", true, "Ready")],
      diagnostics: readyDiag([diagAdapter("mimo", false)]),
    });

    expect(findAdapter(result, "mimo")).toMatchObject({
      state: "hidden",
      cause: "binary_unavailable",
    });
  });

  it("hides an adapter missing from the diagnostics adapter list", () => {
    const result = summarizeAdapterReadiness({
      runners: [],
      diagnostics: readyDiag([diagAdapter("claude", true)]),
    });

    expect(findAdapter(result, "mimo").state).toBe("hidden");
  });

  describe("when supervisor diagnostics are unavailable", () => {
    const down: SupervisorDiagnosticsStatus = {
      kind: "unavailable",
      reason: "network",
      message: "supervisor down",
    };

    it("shows configured adapters as amber with the supervisor reason", () => {
      const result = summarizeAdapterReadiness({
        runners: [runner("claude", true, "Ready")],
        diagnostics: down,
      });

      expect(findAdapter(result, "claude")).toMatchObject({
        state: "amber",
        cause: "diagnostics_unavailable",
        detail: "network",
      });
    });

    it("hides adapters with no configured runner", () => {
      const result = summarizeAdapterReadiness({
        runners: [runner("claude", true, "Ready")],
        diagnostics: down,
      });

      expect(findAdapter(result, "codex").state).toBe("hidden");
    });

    it("treats a null diagnostics value like unavailable (no reason)", () => {
      const result = summarizeAdapterReadiness({
        runners: [runner("codex", true, "Ready")],
        diagnostics: null,
      });

      expect(findAdapter(result, "codex")).toMatchObject({
        state: "amber",
        cause: "diagnostics_unavailable",
        detail: null,
      });
    });
  });
});
