import type { FlowContext } from "@/lib/flows/types";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCliStep, type RunCliStepCtx } from "@/lib/flows/runner-cli";

let workDir: string;
let worktreePath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "runner-cli-test-"));
  worktreePath = await mkdtemp(join(tmpdir(), "runner-cli-worktree-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workDir, { recursive: true, force: true });
  await rm(worktreePath, { recursive: true, force: true });
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

const ctxBase = (overrides: Partial<FlowContext> = {}): FlowContext => ({
  task: {
    id: "t1",
    title: "T",
    prompt: "hi",
    effectivePrompt: "hi",
    clarifications: [],
    attemptNumber: 1,
  },
  run: { id: "r1", attemptNumber: 1, projectSlug: "demo" },
  executor: { id: "e1", agent: "claude", model: "claude-sonnet-4-6" },
  steps: {},
  env: {},
  artifacts: {},
  ...overrides,
});

describe("runCliStep", () => {
  it("succeeds when bash command exits 0 and captures stdout", async () => {
    const result = await runCliStep(
      { id: "echo", type: "cli", command: "echo hello" },
      {
        runtimeRoot: workDir,
        projectSlug: "demo",
        runId: "r1",
        stepId: "echo",
        worktreePath,
        context: ctxBase(),
        timeoutMs: 5_000,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.errorCode).toBeUndefined();
  });

  it("maps non-zero exit to ok=false + errorCode=PRECONDITION", async () => {
    const result = await runCliStep(
      { id: "fail", type: "cli", command: "exit 7" },
      {
        runtimeRoot: workDir,
        projectSlug: "demo",
        runId: "r1",
        stepId: "fail",
        worktreePath,
        context: ctxBase(),
        timeoutMs: 5_000,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.errorCode).toBe("PRECONDITION");
  });

  it("timeout marks step failed with PRECONDITION", async () => {
    const result = await runCliStep(
      { id: "slow", type: "cli", command: "sleep 5" },
      {
        runtimeRoot: workDir,
        projectSlug: "demo",
        runId: "r1",
        stepId: "slow",
        worktreePath,
        context: ctxBase(),
        timeoutMs: 200,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("PRECONDITION");
    expect(result.durationMs ?? 0).toBeLessThan(2000);
  });

  it("clamps the requested timeout to the MAISTER_MAX_CLI_TIMEOUT_MS ceiling", async () => {
    vi.stubEnv("MAISTER_MAX_CLI_TIMEOUT_MS", "200");

    const result = await runCliStep(
      { id: "ceil", type: "cli", command: "sleep 5" },
      {
        runtimeRoot: workDir,
        projectSlug: "demo",
        runId: "r1",
        stepId: "ceil",
        worktreePath,
        context: ctxBase(),
        timeoutMs: 60_000,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("PRECONDITION");
    expect(result.durationMs ?? 0).toBeLessThan(2_000);
  });

  it("kills the whole process group on timeout — grandchildren do not survive", async () => {
    const result = await runCliStep(
      {
        id: "tree",
        type: "cli",
        // The background sleep is bash's CHILD (a grandchild of the runner);
        // its stdio is detached from the pipe so the exec promise settles on
        // bash's death even when the grandchild survives.
        command: 'sleep 30 >/dev/null 2>&1 & echo "gc:$!"; wait',
      },
      {
        runtimeRoot: workDir,
        projectSlug: "demo",
        runId: "r1",
        stepId: "tree",
        worktreePath,
        context: ctxBase(),
        timeoutMs: 300,
      },
    );

    expect(result.ok).toBe(false);

    const grandchildPid = Number(/gc:(\d+)/.exec(result.stdout)?.[1]);

    expect(grandchildPid).toBeGreaterThan(0);
    await expect
      .poll(() => isProcessAlive(grandchildPid), { timeout: 3_000 })
      .toBe(false);
  });

  it("renders the command template before execution", async () => {
    const result = await runCliStep(
      { id: "echo", type: "cli", command: "echo {{ task.prompt }}" },
      {
        runtimeRoot: workDir,
        projectSlug: "demo",
        runId: "r1",
        stepId: "echo",
        worktreePath,
        context: ctxBase({
          task: {
            id: "t",
            title: "T",
            prompt: "tmpl-out",
            effectivePrompt: "tmpl-out",
            clarifications: [],
            attemptNumber: 1,
          },
        }),
        timeoutMs: 5_000,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("tmpl-out");
  });

  it("injects MAISTER_OUTPUT_FILE with the per-attempt filename when attempt is provided (M26)", async () => {
    const result = await runCliStep(
      {
        id: "outstep",
        type: "cli",
        command: 'printf "of:%s" "$MAISTER_OUTPUT_FILE"',
      },
      {
        runtimeRoot: workDir,
        projectSlug: "demo",
        runId: "r1",
        stepId: "outstep",
        worktreePath,
        context: ctxBase(),
        timeoutMs: 5_000,
        attempt: 3,
      },
    );

    const expected = join(
      workDir,
      ".maister",
      "demo",
      "runs",
      "r1",
      "output-outstep-3.json",
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain(`of:${expected}`);
  });

  it("does not arm the transport when the step id is not a valid filename segment", async () => {
    const result = await runCliStep(
      {
        id: "badid",
        type: "cli",
        command: 'echo "of:${MAISTER_OUTPUT_FILE:-unset}"',
      },
      {
        runtimeRoot: workDir,
        projectSlug: "demo",
        runId: "r1",
        stepId: "x/../../secrets/y",
        worktreePath,
        context: ctxBase(),
        timeoutMs: 5_000,
        attempt: 1,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("of:unset");
  });

  it("does not inject MAISTER_OUTPUT_FILE when attempt is not provided (no transport provisioning)", async () => {
    const result = await runCliStep(
      {
        id: "noout",
        type: "cli",
        command: 'echo "of:${MAISTER_OUTPUT_FILE:-unset}"',
      },
      {
        runtimeRoot: workDir,
        projectSlug: "demo",
        runId: "r1",
        stepId: "noout",
        worktreePath,
        context: ctxBase(),
        timeoutMs: 5_000,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("of:unset");
  });

  it("keeps allow-listed parent env (PATH) when the transport is armed", async () => {
    const result = await runCliStep(
      {
        id: "envkeep",
        type: "cli",
        command: 'test -n "$PATH" && echo "path-ok"',
      },
      {
        runtimeRoot: workDir,
        projectSlug: "demo",
        runId: "r1",
        stepId: "envkeep",
        worktreePath,
        context: ctxBase(),
        timeoutMs: 5_000,
        attempt: 1,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("path-ok");
  });

  describe("child env isolation (ADR-153)", () => {
    const SENTINEL = "WEB_TIER_SENTINEL_SECRET";

    beforeEach(() => {
      vi.stubEnv(SENTINEL, "leak-me");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const run = (command: string, attempt?: number) =>
      runCliStep(
        { id: "envstep", type: "cli", command },
        {
          runtimeRoot: workDir,
          projectSlug: "demo",
          runId: "r1",
          stepId: "envstep",
          worktreePath,
          context: ctxBase(),
          timeoutMs: 5_000,
          ...(attempt !== undefined ? { attempt } : {}),
        },
      );

    it("withholds a web-tier secret env var from the child", async () => {
      const result = await run('echo "s:${WEB_TIER_SENTINEL_SECRET:-absent}"');

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("s:absent");
    });

    it("withholds the secret when the output transport is armed, keeping MAISTER_OUTPUT_FILE", async () => {
      const result = await run(
        'echo "s:${WEB_TIER_SENTINEL_SECRET:-absent} of:${MAISTER_OUTPUT_FILE:-unset}"',
        1,
      );

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("s:absent");
      expect(result.stdout).not.toContain("of:unset");
    });

    it("passes allow-listed vars (PATH, HOME) without the transport armed", async () => {
      const result = await run(
        'test -n "$PATH" && test -n "$HOME" && echo allow-ok',
      );

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("allow-ok");
    });

    it("MAISTER_CLI_INHERIT_ENV=1 restores full env inheritance (compat)", async () => {
      vi.stubEnv("MAISTER_CLI_INHERIT_ENV", "1");

      const result = await run('echo "s:${WEB_TIER_SENTINEL_SECRET:-absent}"');

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("s:leak-me");
    });
  });

  describe("flow install dir (ADR-154)", () => {
    const run = (command: string, extra: Partial<RunCliStepCtx> = {}) =>
      runCliStep(
        { id: "fdstep", type: "cli", command },
        {
          runtimeRoot: workDir,
          projectSlug: "demo",
          runId: "r1",
          stepId: "fdstep",
          worktreePath,
          context: ctxBase(),
          timeoutMs: 5_000,
          ...extra,
        },
      );

    it("injects MAISTER_FLOW_DIR when ctx.flowInstallPath is set", async () => {
      const result = await run('echo "fd:${MAISTER_FLOW_DIR:-unset}"', {
        flowInstallPath: "/opt/maister/flows/env-e2e@v1",
      });

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("fd:/opt/maister/flows/env-e2e@v1");
    });

    it("omits MAISTER_FLOW_DIR when ctx.flowInstallPath is unset (gate/probe path)", async () => {
      const result = await run('echo "fd:${MAISTER_FLOW_DIR:-unset}"');

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("fd:unset");
    });

    it("coexists with the armed MAISTER_OUTPUT_FILE transport", async () => {
      const result = await run(
        'echo "fd:${MAISTER_FLOW_DIR:-unset} of:${MAISTER_OUTPUT_FILE:-unset}"',
        { flowInstallPath: "/opt/pkg", attempt: 2 },
      );

      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("fd:/opt/pkg");
      expect(result.stdout).not.toContain("of:unset");
    });
  });

  it("creates the run dir when armed so the command can write $MAISTER_OUTPUT_FILE", async () => {
    const result = await runCliStep(
      {
        id: "writer",
        type: "cli",
        command: 'echo \'{"k":"v"}\' > "$MAISTER_OUTPUT_FILE"',
      },
      {
        runtimeRoot: workDir,
        projectSlug: "demo",
        runId: "r1",
        stepId: "writer",
        worktreePath,
        context: ctxBase(),
        timeoutMs: 5_000,
        attempt: 1,
      },
    );

    expect(result.ok).toBe(true);
    const written = await readFile(
      join(workDir, ".maister", "demo", "runs", "r1", "output-writer-1.json"),
      "utf8",
    );

    expect(JSON.parse(written)).toEqual({ k: "v" });
  });
});
