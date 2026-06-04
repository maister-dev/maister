import type {
  Run as RunRow,
  StepRun as StepRunRow,
  Task as TaskRow,
} from "@/lib/db/schema";

import { describe, expect, it } from "vitest";

import { buildContext } from "@/lib/flows/context";

const task: Pick<TaskRow, "id" | "title" | "prompt" | "attemptNumber"> = {
  id: "task-1",
  title: "Demo",
  prompt: "Do the thing",
  attemptNumber: 2,
};

const run: Pick<RunRow, "id"> = { id: "run-1" };

const executor = {
  id: "exec-1",
  agent: "claude",
  model: "claude-sonnet-4-6",
  router: null,
} as const;

function makeStepRun(
  partial: Partial<StepRunRow> & { stepId: string; attempt: number },
): StepRunRow {
  return {
    id: `${partial.stepId}-${partial.attempt}`,
    runId: "run-1",
    stepType: "cli",
    mode: null,
    status: "Succeeded",
    acpSessionId: null,
    stdout: null,
    vars: {},
    exitCode: null,
    errorCode: null,
    startedAt: new Date(),
    endedAt: null,
    ...partial,
  } as StepRunRow;
}

describe("buildContext — FlowContext builder", () => {
  it("returns the full shape with expected fields", () => {
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: { PATH: "/usr/bin" },
    });

    expect(ctx.task).toEqual({
      id: "task-1",
      title: "Demo",
      prompt: "Do the thing",
      attemptNumber: 2,
    });
    expect(ctx.run).toEqual({
      id: "run-1",
      attemptNumber: 2,
      projectSlug: "demo",
    });
    expect(ctx.executor).toEqual({
      id: "exec-1",
      agent: "claude",
      model: "claude-sonnet-4-6",
      router: undefined,
    });
    expect(ctx.steps).toEqual({});
    expect(ctx.env).toEqual({ PATH: "/usr/bin" });
  });

  it("env includes PATH but excludes ANTHROPIC_AUTH_TOKEN/DB_URL/*_TOKEN/*_KEY", () => {
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {
        PATH: "/usr/bin",
        ANTHROPIC_AUTH_TOKEN: "leak",
        DB_URL: "postgres://x",
        GITHUB_TOKEN: "ghp_xxx",
        SOMETHING_KEY: "abc",
        HOME: "/home/u",
      },
    });

    expect(ctx.env).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
    expect(Object.values(ctx.env).some((v) => v.includes("leak"))).toBe(false);
    expect("ANTHROPIC_AUTH_TOKEN" in ctx.env).toBe(false);
    expect("DB_URL" in ctx.env).toBe(false);
    expect("GITHUB_TOKEN" in ctx.env).toBe(false);
    expect("SOMETHING_KEY" in ctx.env).toBe(false);
  });

  it("custom envWhitelist adds CUSTOM_FOO to env", () => {
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: { CUSTOM_FOO: "bar", BAR: "skipped" },
      envWhitelist: [/^CUSTOM_/],
    });

    expect(ctx.env.CUSTOM_FOO).toBe("bar");
    expect("BAR" in ctx.env).toBe(false);
  });

  it("steps keyed by stepId; multiple attempts resolve to highest attempt", () => {
    const stepRuns: StepRunRow[] = [
      makeStepRun({
        stepId: "plan",
        attempt: 1,
        stdout: "old plan stdout",
      }),
      makeStepRun({
        stepId: "plan",
        attempt: 2,
        stdout: "new plan stdout",
        exitCode: 0,
      }),
      makeStepRun({ stepId: "impl", attempt: 1, stdout: "impl stdout" }),
    ];
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns,
      projectSlug: "demo",
      envSource: {},
    });

    expect(ctx.steps.plan.output).toBe("new plan stdout");
    expect(ctx.steps.plan.exitCode).toBe(0);
    expect(ctx.steps.impl.output).toBe("impl stdout");
  });

  it("output is truncated to outputTruncationBytes (default 8 KiB)", () => {
    const big = "x".repeat(20_000);
    const stepRuns: StepRunRow[] = [
      makeStepRun({ stepId: "big", attempt: 1, stdout: big }),
    ];
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns,
      projectSlug: "demo",
      envSource: {},
    });

    expect(ctx.steps.big.output.length).toBe(8 * 1024);
  });

  it("vars from jsonb pass through as-is", () => {
    const stepRuns: StepRunRow[] = [
      makeStepRun({
        stepId: "x",
        attempt: 1,
        vars: { foo: "bar", num: 42 },
      }),
    ];
    const ctx = buildContext({
      task,
      run,
      executor,
      stepRuns,
      projectSlug: "demo",
      envSource: {},
    });

    expect(ctx.steps.x.vars).toEqual({ foo: "bar", num: 42 });
  });

  it("executor.router is undefined when not set on the row", () => {
    const ctx = buildContext({
      task,
      run,
      executor: { ...executor, router: null },
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
    });

    expect(ctx.executor.router).toBeUndefined();
  });

  it("propagates task.attemptNumber to ctx.task and ctx.run", () => {
    const ctx = buildContext({
      task: { ...task, attemptNumber: 5 },
      run,
      executor,
      stepRuns: [],
      projectSlug: "demo",
      envSource: {},
    });

    expect(ctx.task.attemptNumber).toBe(5);
    expect(ctx.run.attemptNumber).toBe(5);
  });
});
