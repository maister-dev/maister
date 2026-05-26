import { describe, expect, it } from "vitest";

import {
  StartSessionRequestSchema,
  SupervisorError,
  httpStatusForCode,
  isSupervisorError,
} from "../types";

const validRequest = {
  runId: "run-1",
  projectSlug: "my-project",
  worktreePath: "/repos/x",
  stepId: "plan",
  prompt: "go",
  executor: { agent: "claude", model: "claude-sonnet-4-6" },
} as const;

describe("StartSessionRequestSchema", () => {
  it("accepts a canonical request", () => {
    expect(StartSessionRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it("accepts executor.env and router=ccr", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      executor: {
        agent: "codex",
        model: "gpt-5-codex",
        env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
        router: "ccr",
      },
      resumeSessionId: "uuid-abc",
    });

    expect(result.success).toBe(true);
  });

  it("rejects empty runId", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      runId: "",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["runId"]);
    }
  });

  it("rejects non-kebab projectSlug", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      projectSlug: "My_Project",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown agent", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      executor: { agent: "cursor", model: "x" },
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown router", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      executor: { agent: "claude", model: "x", router: "litellm" },
    });

    expect(result.success).toBe(false);
  });
});

describe("SupervisorError", () => {
  it("constructs with code + message", () => {
    const err = new SupervisorError("PRECONDITION", "bad");

    expect(err.code).toBe("PRECONDITION");
    expect(err.message).toBe("bad");
    expect(err.name).toBe("SupervisorError");
    expect(err).toBeInstanceOf(Error);
    expect(isSupervisorError(err)).toBe(true);
  });

  it("isSupervisorError returns false for plain Error", () => {
    expect(isSupervisorError(new Error("nope"))).toBe(false);
    expect(isSupervisorError("string")).toBe(false);
    expect(isSupervisorError(null)).toBe(false);
  });
});

describe("httpStatusForCode", () => {
  it("maps PRECONDITION to 409", () => {
    expect(httpStatusForCode("PRECONDITION")).toBe(409);
  });

  it("maps EXECUTOR_UNAVAILABLE to 503", () => {
    expect(httpStatusForCode("EXECUTOR_UNAVAILABLE")).toBe(503);
  });

  it("maps SPAWN/ACP_PROTOCOL/CHECKPOINT/CRASH to 500", () => {
    expect(httpStatusForCode("SPAWN")).toBe(500);
    expect(httpStatusForCode("ACP_PROTOCOL")).toBe(500);
    expect(httpStatusForCode("CHECKPOINT")).toBe(500);
    expect(httpStatusForCode("CRASH")).toBe(500);
  });
});
