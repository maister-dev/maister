import { describe, expect, it } from "vitest";

import {
  SendPromptRequestSchema,
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
  executor: { agent: "claude", model: "claude-sonnet-4-6" },
} as const;

describe("StartSessionRequestSchema", () => {
  it("accepts a canonical request", () => {
    expect(StartSessionRequestSchema.safeParse(validRequest).success).toBe(
      true,
    );
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

  it("rejects runId with path traversal segment", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      runId: "../../../etc",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["runId"]);
    }
  });

  it("rejects runId with forward slash", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      runId: "run/with/slash",
    });

    expect(result.success).toBe(false);
  });

  it("rejects stepId with path traversal segment", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      stepId: "../../etc/passwd",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["stepId"]);
    }
  });

  it("rejects stepId with null byte", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      stepId: `step${String.fromCharCode(0)}evil`,
    });

    expect(result.success).toBe(false);
  });

  it("rejects runId longer than 128 chars", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      runId: "a".repeat(129),
    });

    expect(result.success).toBe(false);
  });

  it("accepts runId/stepId with dots, dashes, underscores", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      runId: "run_abc.1-2",
      stepId: "step.plan_v2-final",
    });

    expect(result.success).toBe(true);
  });

  it("rejects relative worktreePath", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      worktreePath: "relative/path",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["worktreePath"]);
    }
  });

  it("rejects worktreePath with .. segment", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      worktreePath: "/repos/../etc",
    });

    expect(result.success).toBe(false);
  });

  it("accepts absolute worktreePath without traversal", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      worktreePath: "/repos/myapp-wt",
    });

    expect(result.success).toBe(true);
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

  it("rejects resumeSessionId with path traversal segment", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      resumeSessionId: "../../../tmp/foo",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["resumeSessionId"]);
    }
  });

  it("rejects resumeSessionId longer than 128 chars", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      resumeSessionId: "a".repeat(129),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["resumeSessionId"]);
    }
  });

  it("rejects projectSlug longer than 64 chars", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      projectSlug: "a".repeat(65),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["projectSlug"]);
    }
  });

  it("accepts server-derived capability launch fields", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      capabilityProfilePath:
        "/repos/x/.maister/capabilities/run-1/profile.json",
      adapterLaunch: {
        env: { MAISTER_CAPABILITY_INSTRUCTIONS_PATH: "/repos/x/i.md" },
        preArgs: ["--profile"],
        postArgs: ["--after"],
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts a versioned platform runner payload alongside legacy executor", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      runner: {
        version: 1,
        runnerId: "claude-code",
        adapter: "claude",
        capabilityAgent: "claude",
        model: "sonnet",
        provider: { kind: "anthropic" },
        permissionPolicy: "default",
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects capabilityProfilePath outside worktreePath", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      capabilityProfilePath: "/tmp/profile.json",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["capabilityProfilePath"]);
    }
  });

  it("rejects unknown start-session fields", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      prompt: "not accepted",
    });

    expect(result.success).toBe(false);
  });
});

describe("SendPromptRequestSchema", () => {
  it("accepts a canonical request", () => {
    expect(
      SendPromptRequestSchema.safeParse({ stepId: "plan", prompt: "go" })
        .success,
    ).toBe(true);
  });

  it("rejects prompt longer than 1_000_000 chars", () => {
    const result = SendPromptRequestSchema.safeParse({
      stepId: "plan",
      prompt: "a".repeat(1_000_001),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["prompt"]);
    }
  });

  it("rejects empty stepId", () => {
    const result = SendPromptRequestSchema.safeParse({
      stepId: "",
      prompt: "ok",
    });

    expect(result.success).toBe(false);
  });

  it("rejects stepId with path traversal", () => {
    const result = SendPromptRequestSchema.safeParse({
      stepId: "../etc",
      prompt: "ok",
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
