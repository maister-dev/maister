import { describe, expect, it } from "vitest";

import {
  buildCommandTarget,
  buildFlowRunTarget,
  normalizeSchedulerTargetDraft,
  summarizeSchedulerTarget,
} from "@/lib/scheduler/job-targets";

describe("scheduler job target model", () => {
  it("builds command targets from typed drafts", () => {
    expect(
      buildCommandTarget({
        commandKind: "http_ping",
        url: "https://example.com/healthz",
        timeoutMs: 5000,
      }),
    ).toEqual({
      commandKind: "http_ping",
      url: "https://example.com/healthz",
      timeoutMs: 5000,
    });

    expect(
      buildCommandTarget({
        commandKind: "console_ping",
        host: "example.com",
      }),
    ).toEqual({
      commandKind: "console_ping",
      host: "example.com",
    });
  });

  it("builds flow_run targets from typed drafts", () => {
    expect(
      buildFlowRunTarget({
        taskId: "task-1",
        runnerId: "codex-default",
        baseBranch: "main",
        targetBranch: "feature/scheduler",
      }),
    ).toEqual({
      taskId: "task-1",
      runnerId: "codex-default",
      baseBranch: "main",
      targetBranch: "feature/scheduler",
    });

    expect(
      buildFlowRunTarget({
        taskId: "task-1",
        runnerId: " ",
        baseBranch: "",
        targetBranch: undefined,
      }),
    ).toEqual({ taskId: "task-1" });
  });

  it("summarizes every scheduler job target without exposing raw JSON", () => {
    expect(
      summarizeSchedulerTarget({
        jobKind: "system_sweep",
        target: {},
      }),
    ).toBe("No target");
    expect(
      summarizeSchedulerTarget({
        jobKind: "command",
        target: {
          commandKind: "http_ping",
          url: "https://example.com/healthz",
          timeoutMs: 5000,
        },
      }),
    ).toBe("HTTP ping https://example.com/healthz · 5000ms");
    expect(
      summarizeSchedulerTarget({
        jobKind: "command",
        target: {
          commandKind: "console_ping",
          host: "example.com",
        },
      }),
    ).toBe("Host ping example.com");
    expect(
      summarizeSchedulerTarget({
        jobKind: "flow_run",
        target: {
          taskId: "task-1",
          runnerId: "codex-default",
        },
      }),
    ).toBe("Flow run task task-1 · runner codex-default");
    expect(
      summarizeSchedulerTarget({
        jobKind: "agent_tick",
        target: {},
      }),
    ).toBe("No target");
    expect(
      summarizeSchedulerTarget({
        jobKind: "run_schedule",
        target: {},
      }),
    ).toBe("No target");
    expect(
      summarizeSchedulerTarget({
        jobKind: "webhook_delivery",
        target: {},
      }),
    ).toBe("No target");
    expect(
      summarizeSchedulerTarget({
        jobKind: "domain_event_dispatch",
        target: {},
      }),
    ).toBe("No target");
  });

  it("normalizes target drafts by job kind", () => {
    expect(
      normalizeSchedulerTargetDraft({
        jobKind: "command",
        draft: {
          commandKind: "http_ping",
          url: "https://example.com/healthz",
          timeoutMs: 5000,
        },
      }),
    ).toEqual({
      commandKind: "http_ping",
      url: "https://example.com/healthz",
      timeoutMs: 5000,
    });

    expect(
      normalizeSchedulerTargetDraft({
        jobKind: "flow_run",
        draft: {
          taskId: "task-1",
          runnerId: "codex-default",
        },
      }),
    ).toEqual({
      taskId: "task-1",
      runnerId: "codex-default",
    });

    expect(
      normalizeSchedulerTargetDraft({
        jobKind: "run_schedule",
        draft: {},
      }),
    ).toEqual({});
  });

  it("rejects unknown target fields by job kind", () => {
    expect(() =>
      normalizeSchedulerTargetDraft({
        jobKind: "command",
        draft: {
          commandKind: "http_ping",
          url: "https://example.com/healthz",
          typo: true,
        },
      }),
    ).toThrow(/unknown.*typo/i);

    expect(() =>
      normalizeSchedulerTargetDraft({
        jobKind: "command",
        draft: {
          commandKind: "http_ping",
          url: "https://example.com/healthz",
          host: "example.com",
        },
      }),
    ).toThrow(/unknown.*host/i);

    expect(() =>
      normalizeSchedulerTargetDraft({
        jobKind: "command",
        draft: {
          commandKind: "console_ping",
          host: "example.com",
          url: "https://example.com/healthz",
        },
      }),
    ).toThrow(/unknown.*url/i);

    expect(() =>
      normalizeSchedulerTargetDraft({
        jobKind: "flow_run",
        draft: {
          taskId: "task-1",
          typo: true,
        },
      }),
    ).toThrow(/unknown.*typo/i);

    expect(() =>
      normalizeSchedulerTargetDraft({
        jobKind: "run_schedule",
        draft: { unused: true },
      }),
    ).toThrow(/unknown.*unused/i);
  });

  it("parses timeout strings strictly", () => {
    expect(
      buildCommandTarget({
        commandKind: "http_ping",
        url: "https://example.com",
        timeoutMs: " 5000 ",
      }),
    ).toEqual({
      commandKind: "http_ping",
      url: "https://example.com",
      timeoutMs: 5000,
    });

    expect(() =>
      buildCommandTarget({
        commandKind: "http_ping",
        url: "https://example.com",
        timeoutMs: "5s",
      }),
    ).toThrow(/timeout/i);

    expect(() =>
      buildCommandTarget({
        commandKind: "http_ping",
        url: "https://example.com",
        timeoutMs: Number.NaN,
      }),
    ).toThrow(/timeout/i);
  });

  it("fails loudly on invalid target drafts", () => {
    expect(() =>
      buildCommandTarget({
        commandKind: "http_ping",
        url: "",
      }),
    ).toThrow(/url/i);
    expect(() =>
      buildCommandTarget({
        commandKind: "console_ping",
        host: "-bad-host",
      }),
    ).toThrow(/host/i);
    expect(() =>
      buildCommandTarget({
        commandKind: "http_ping",
        url: "https://example.com",
        timeoutMs: 0,
      }),
    ).toThrow(/timeout/i);
    expect(() => buildFlowRunTarget({ taskId: "" })).toThrow(/task id/i);
    expect(() =>
      summarizeSchedulerTarget({
        jobKind: "command",
        target: { commandKind: "http_ping" },
      }),
    ).toThrow(/url/i);
  });
});
