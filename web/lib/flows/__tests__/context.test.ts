import type {
  NodeAttempt,
  Run as RunRow,
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

function makeNodeAttempt(
  partial: Partial<NodeAttempt> & { nodeId: string; attempt: number },
): NodeAttempt {
  return {
    id: `${partial.nodeId}-${partial.attempt}`,
    runId: "run-1",
    nodeType: "cli",
    status: "Succeeded",
    acpSessionId: null,
    stdout: null,
    vars: {},
    exitCode: null,
    errorCode: null,
    startedAt: new Date(),
    endedAt: null,
    ...partial,
  } as NodeAttempt;
}

describe("buildContext — FlowContext builder", () => {
  it("returns the full shape with expected fields", () => {
    const ctx = buildContext({
      task,
      run,
      executor,
      nodeAttempts: [],
      projectSlug: "demo",
      effectivePrompt: "Do the thing\n\n## Human clarifications\n\nAnswer: production",
      clarifications: [
        {
          id: "clarification-1",
          seq: 1,
          question: "Which environment?",
          answer: { environment: "production" },
        },
      ],
      envSource: { PATH: "/usr/bin" },
    });

    expect(ctx.task).toEqual({
      id: "task-1",
      title: "Demo",
      prompt: "Do the thing",
      effectivePrompt: "Do the thing\n\n## Human clarifications\n\nAnswer: production",
      clarifications: [
        {
          id: "clarification-1",
          seq: 1,
          question: "Which environment?",
          answer: { environment: "production" },
        },
      ],
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
      nodeAttempts: [],
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
      nodeAttempts: [],
      projectSlug: "demo",
      envSource: { CUSTOM_FOO: "bar", BAR: "skipped" },
      envWhitelist: [/^CUSTOM_/],
    });

    expect(ctx.env.CUSTOM_FOO).toBe("bar");
    expect("BAR" in ctx.env).toBe(false);
  });

  it("steps namespace is keyed by nodeId and uses the highest attempt", () => {
    const nodeAttempts: NodeAttempt[] = [
      makeNodeAttempt({
        nodeId: "plan",
        attempt: 1,
        stdout: "old plan stdout",
      }),
      makeNodeAttempt({
        nodeId: "plan",
        attempt: 2,
        stdout: "new plan stdout",
        exitCode: 0,
      }),
      makeNodeAttempt({ nodeId: "impl", attempt: 1, stdout: "impl stdout" }),
    ];
    const ctx = buildContext({
      task,
      run,
      executor,
      nodeAttempts,
      projectSlug: "demo",
      envSource: {},
    });

    expect(ctx.steps.plan.output).toBe("new plan stdout");
    expect(ctx.steps.plan.exitCode).toBe(0);
    expect(ctx.steps.impl.output).toBe("impl stdout");
  });

  it("output is truncated to outputTruncationBytes (default 8 KiB)", () => {
    const big = "x".repeat(20_000);
    const nodeAttempts: NodeAttempt[] = [
      makeNodeAttempt({ nodeId: "big", attempt: 1, stdout: big }),
    ];
    const ctx = buildContext({
      task,
      run,
      executor,
      nodeAttempts,
      projectSlug: "demo",
      envSource: {},
    });

    expect(ctx.steps.big.output.length).toBe(8 * 1024);
  });

  it("vars from jsonb pass through as-is", () => {
    const nodeAttempts: NodeAttempt[] = [
      makeNodeAttempt({
        nodeId: "x",
        attempt: 1,
        vars: { foo: "bar", num: 42 },
      }),
    ];
    const ctx = buildContext({
      task,
      run,
      executor,
      nodeAttempts,
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
      nodeAttempts: [],
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
      nodeAttempts: [],
      projectSlug: "demo",
      envSource: {},
    });

    expect(ctx.task.attemptNumber).toBe(5);
    expect(ctx.run.attemptNumber).toBe(5);
  });
});
