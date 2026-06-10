import type { FlowContext } from "@/lib/flows/types";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCliStep } from "@/lib/flows/runner-cli";

let workDir: string;
let worktreePath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "runner-cli-test-"));
  worktreePath = await mkdtemp(join(tmpdir(), "runner-cli-worktree-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(worktreePath, { recursive: true, force: true });
});

const ctxBase = (overrides: Partial<FlowContext> = {}): FlowContext => ({
  task: { id: "t1", title: "T", prompt: "hi", attemptNumber: 1 },
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

  it("AbortSignal timeout marks step failed with PRECONDITION", async () => {
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
          task: { id: "t", title: "T", prompt: "tmpl-out", attemptNumber: 1 },
        }),
        timeoutMs: 5_000,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("tmpl-out");
  });

  it("writes a pre-guard metric to guards.jsonl on success", async () => {
    await runCliStep(
      {
        id: "echo",
        type: "cli",
        command: "echo ok",
        pre_guards: [{ cost: 1000 }],
      },
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

    const file = join(
      workDir,
      ".maister",
      "demo",
      "runs",
      "r1",
      "guards.jsonl",
    );
    const raw = await readFile(file, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);

    expect(lines.length).toBeGreaterThanOrEqual(1);
    const pre = lines
      .map((l) => JSON.parse(l))
      .find((o) => o.kind === "pre" && o.stepId === "echo");

    expect(pre).toBeDefined();
  });

  it("post-guard regex match is recorded in guards.jsonl", async () => {
    await runCliStep(
      {
        id: "errecho",
        type: "cli",
        command: "echo ERROR-marker",
        post_guards: [{ regex: "ERROR" }],
      },
      {
        runtimeRoot: workDir,
        projectSlug: "demo",
        runId: "r1",
        stepId: "errecho",
        worktreePath,
        context: ctxBase(),
        timeoutMs: 5_000,
      },
    );

    const file = join(
      workDir,
      ".maister",
      "demo",
      "runs",
      "r1",
      "guards.jsonl",
    );
    const raw = await readFile(file, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const post = lines
      .map((l) => JSON.parse(l))
      .find((o) => o.kind === "post" && o.stepId === "errecho");

    expect(post).toBeDefined();
    expect(post.regexMatched).toBe(true);
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

  it("leaves the child env untouched when attempt is not provided (no transport provisioning)", async () => {
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

  it("keeps inheriting the parent env when the transport is armed", async () => {
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

  it("post-guard time cap exceeded is recorded with capExceeded=true", async () => {
    await runCliStep(
      {
        id: "tinyguard",
        type: "cli",
        command: "echo done",
        post_guards: [{ time: 0 }],
      },
      {
        runtimeRoot: workDir,
        projectSlug: "demo",
        runId: "r1",
        stepId: "tinyguard",
        worktreePath,
        context: ctxBase(),
        timeoutMs: 5_000,
      },
    );

    const file = join(
      workDir,
      ".maister",
      "demo",
      "runs",
      "r1",
      "guards.jsonl",
    );
    const raw = await readFile(file, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const post = lines
      .map((l) => JSON.parse(l))
      .find((o) => o.kind === "post" && o.stepId === "tinyguard");

    expect(post).toBeDefined();
    expect(post.capExceeded).toBe(true);
  });
});
