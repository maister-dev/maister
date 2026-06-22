import { describe, expect, it } from "vitest";

import {
  SendPromptRequestSchema,
  StartSessionRequestSchema,
  SupervisorDiagnosticsResponseSchema,
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

  it("accepts a safe nodeAttemptId attribution field", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      nodeAttemptId: "node.attempt_1",
    });

    expect(result.success).toBe(true);
  });

  it("rejects nodeAttemptId with path traversal", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      nodeAttemptId: "../node-attempt",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["nodeAttemptId"]);
    }
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

  it("accepts designed Gemini, OpenCode, and MiMo runner payloads", () => {
    const geminiResult = StartSessionRequestSchema.safeParse({
      ...validRequest,
      executor: { agent: "gemini", model: "gemini-3-pro" },
      runner: {
        version: 1,
        runnerId: "gemini-cli",
        adapter: "gemini",
        capabilityAgent: "gemini",
        model: "gemini-3-pro",
        provider: { kind: "google_gemini", apiKeyEnv: "GEMINI_API_KEY" },
        permissionPolicy: "default",
      },
    });
    const opencodeResult = StartSessionRequestSchema.safeParse({
      ...validRequest,
      executor: { agent: "opencode", model: "opencode-default" },
      runner: {
        version: 1,
        runnerId: "opencode-native",
        adapter: "opencode",
        capabilityAgent: "opencode",
        model: "opencode-default",
        provider: { kind: "agent_native" },
        permissionPolicy: "default",
      },
    });
    const mimoResult = StartSessionRequestSchema.safeParse({
      ...validRequest,
      executor: { agent: "mimo", model: "mimo-native" },
      runner: {
        version: 1,
        runnerId: "mimo-code-native",
        adapter: "mimo",
        capabilityAgent: "mimo",
        model: "mimo-native",
        provider: { kind: "agent_native" },
        permissionPolicy: "default",
      },
    });

    expect(geminiResult.success).toBe(true);
    expect(opencodeResult.success).toBe(true);
    expect(mimoResult.success).toBe(true);
  });

  it("rejects env-prefixed Google provider secret names at the supervisor boundary", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      executor: { agent: "gemini", model: "gemini-3-pro" },
      runner: {
        version: 1,
        runnerId: "gemini-cli",
        adapter: "gemini",
        capabilityAgent: "gemini",
        model: "gemini-3-pro",
        provider: { kind: "google_gemini", apiKeyEnv: "env:GEMINI_API_KEY" },
        permissionPolicy: "default",
      },
    });

    expect(result.success).toBe(false);
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

describe("SupervisorDiagnosticsResponseSchema", () => {
  it("accepts diagnostics entries for all adapter ids", () => {
    const result = SupervisorDiagnosticsResponseSchema.safeParse({
      status: "ready",
      version: "0.0.1",
      checkedAt: "2026-06-11T12:00:00.000Z",
      adapters: [
        {
          id: "claude",
          binary: "claude-agent-acp",
          source: "path",
          path: "/bin/claude-agent-acp",
          available: true,
          version: null,
          error: null,
          smoke: {
            status: "not_required",
            reason: null,
            checkedAt: null,
            protocolVersion: null,
          },
        },
        {
          id: "codex",
          binary: "codex-acp",
          source: "path",
          path: "/bin/codex-acp",
          available: true,
          version: null,
          error: null,
          smoke: {
            status: "not_required",
            reason: null,
            checkedAt: null,
            protocolVersion: null,
          },
        },
        {
          id: "gemini",
          binary: "gemini",
          source: "path",
          path: null,
          available: false,
          version: null,
          error: "adapter binary not found on PATH: gemini",
          smoke: {
            status: "pending",
            reason: "gemini ACP compatibility smoke has not been cached",
            checkedAt: null,
            protocolVersion: null,
          },
        },
        {
          id: "opencode",
          binary: "opencode",
          source: "path",
          path: null,
          available: false,
          version: null,
          error: "adapter binary not found on PATH: opencode",
          smoke: {
            status: "pending",
            reason: "opencode ACP compatibility smoke has not been cached",
            checkedAt: null,
            protocolVersion: null,
          },
        },
        {
          id: "mimo",
          binary: "mimo",
          source: "path",
          path: null,
          available: false,
          version: null,
          error: "adapter binary not found on PATH: mimo",
          smoke: {
            status: "pending",
            reason: "mimo ACP compatibility smoke has not been cached",
            checkedAt: null,
            protocolVersion: null,
          },
        },
      ],
      sidecars: [],
      envRefs: [],
    });

    expect(result.success).toBe(true);
  });
});

describe("SendPromptRequestSchema", () => {
  it("accepts a canonical request", () => {
    expect(
      SendPromptRequestSchema.safeParse({ stepId: "plan", prompt: "go" })
        .success,
    ).toBe(true);
  });

  it("rejects unknown top-level request keys instead of stripping them", () => {
    const result = SendPromptRequestSchema.safeParse({
      stepId: "plan",
      prompt: "go",
      requestId: "smuggled",
    });

    expect(result.success).toBe(false);
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

  it("accepts a safe nodeAttemptId attribution field", () => {
    const result = SendPromptRequestSchema.safeParse({
      stepId: "plan",
      nodeAttemptId: "node-attempt.1",
      prompt: "ok",
    });

    expect(result.success).toBe(true);
  });

  it("rejects nodeAttemptId with path traversal", () => {
    const result = SendPromptRequestSchema.safeParse({
      stepId: "plan",
      nodeAttemptId: "../node-attempt",
      prompt: "ok",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["nodeAttemptId"]);
    }
  });

  it("accepts and retains an optional structured content block array (T5.4 A)", () => {
    const result = SendPromptRequestSchema.safeParse({
      stepId: "scratch-dialog",
      prompt: "review these",
      contentBlocks: [
        { type: "text", text: "review these" },
        {
          type: "resource_link",
          uri: "file:///repos/x/notes.txt",
          name: "notes.txt",
          mimeType: "text/plain",
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contentBlocks).toHaveLength(2);
      expect(result.data.contentBlocks?.[1]).toMatchObject({
        type: "resource_link",
        uri: "file:///repos/x/notes.txt",
        name: "notes.txt",
      });
    }
  });

  it("rejects a content block with an unknown type", () => {
    const result = SendPromptRequestSchema.safeParse({
      stepId: "plan",
      prompt: "go",
      contentBlocks: [{ type: "bogus", text: "x" }],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a resource_link content block missing the uri", () => {
    const result = SendPromptRequestSchema.safeParse({
      stepId: "plan",
      prompt: "go",
      contentBlocks: [{ type: "resource_link", name: "notes.txt" }],
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
