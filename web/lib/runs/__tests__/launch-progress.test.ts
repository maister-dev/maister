import { describe, expect, it } from "vitest";

import {
  LAUNCH_STAGES,
  formatLaunchErrorFrame,
  formatLaunchProgressFrame,
  formatLaunchResultFrame,
  launchProgress,
  readLaunchStream,
} from "@/lib/runs/launch-progress";

describe("scratch launch-progress frame helpers", () => {
  it("orders the FR-F1 stages canonically", () => {
    expect(LAUNCH_STAGES).toEqual([
      "precondition",
      "worktree_created",
      "materializing",
      "spawning",
      "session_ready",
    ]);
  });

  it("builds a progress event with an optional adapter", () => {
    expect(launchProgress("worktree_created")).toEqual({
      type: "scratch.launch_progress",
      stage: "worktree_created",
    });
    expect(launchProgress("materializing", "codex")).toEqual({
      type: "scratch.launch_progress",
      stage: "materializing",
      adapter: "codex",
    });
    expect(
      launchProgress("session_ready", undefined, {
        runId: "run-1",
        dialogUrl: "/scratch-runs/run-1",
      }),
    ).toEqual({
      type: "scratch.launch_progress",
      stage: "session_ready",
      runId: "run-1",
      dialogUrl: "/scratch-runs/run-1",
    });
  });

  it("frames a progress event as a synthetic SSE line (no id:)", () => {
    const frame = formatLaunchProgressFrame(
      launchProgress("materializing", "codex"),
    );

    // Synthetic (not in run.events.jsonl) → MUST NOT carry an `id:` line,
    // mirroring the run-stream timeout event.
    expect(frame.startsWith("id:")).toBe(false);
    expect(frame).toBe(
      `data: ${JSON.stringify({
        type: "scratch.launch_progress",
        stage: "materializing",
        adapter: "codex",
      })}\n\n`,
    );
  });

  it("frames the terminal launch result", () => {
    const frame = formatLaunchResultFrame({ runId: "run-1", dialogUrl: "/x" });

    expect(frame.startsWith("id:")).toBe(false);
    expect(frame).toBe(
      `data: ${JSON.stringify({
        type: "scratch.launch_result",
        result: { runId: "run-1", dialogUrl: "/x" },
      })}\n\n`,
    );
  });

  it("frames a typed error with its MaisterError code", () => {
    const frame = formatLaunchErrorFrame(
      "EXECUTOR_UNAVAILABLE",
      "supervisor down",
    );

    expect(frame).toBe(
      `data: ${JSON.stringify({
        type: "error",
        code: "EXECUTOR_UNAVAILABLE",
        message: "supervisor down",
      })}\n\n`,
    );
  });

  it("preserves a consensus role error through SSE without unrelated details", async () => {
    const details = {
      reason: "consensus_runner_unresolved",
      slotKey: "consensus:plan_consensus:synthesizer",
      label: "plan_consensus · synthesizer",
    };
    const frame = formatLaunchErrorFrame("CONFIG", "ambiguous runner", {
      ...details,
      provider: { authToken: "private-provider-value" },
    });
    const result = await readLaunchStream(new Response(frame), () => {});

    expect(result.error).toEqual({
      code: "CONFIG",
      message: "ambiguous runner",
      details,
    });
    expect(frame).not.toContain("private-provider-value");
  });
});
