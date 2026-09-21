import { describe, expect, it } from "vitest";

import {
  AdoptWorkspacePayloadSchema,
  EnvRefsRequestSchema,
  errorBody,
  LEGACY_SESSION_PATH_FIELDS,
  legacySessionPathField,
  McpProbeRequestSchema,
  McpServerInputSchema,
  SendPromptRequestSchema,
  StartSessionRequestSchema,
  SupervisorDiagnosticsResponseSchema,
  SupervisorError,
  httpStatusForCode,
  isSupervisorError,
} from "../types";

const validRequest = {
  executionWorkspaceId: "ws_5f3a8a2b7e344f6d9d2c1d4e5f6a7b8c",
  stepId: "plan",
  executor: { agent: "claude", model: "claude-sonnet-4-6" },
} as const;

describe("StartSessionRequestSchema", () => {
  it("accepts a canonical request", () => {
    expect(StartSessionRequestSchema.safeParse(validRequest).success).toBe(
      true,
    );
  });

  it("accepts executor.env", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      executor: {
        agent: "codex",
        model: "gpt-5-codex",
        env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
      },
      resumeSessionId: "uuid-abc",
    });

    expect(result.success).toBe(true);
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

  it("accepts stepId with dots, dashes, underscores", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      stepId: "step.plan_v2-final",
    });

    expect(result.success).toBe(true);
  });

  it.each([".", ".."])(
    "rejects the bare directory reference %j as a stepId",
    (stepId) => {
      const result = StartSessionRequestSchema.safeParse({
        ...validRequest,
        stepId,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toEqual(["stepId"]);
      }
    },
  );

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

  // ADR-166 (strict): the handle is the ONLY workspace address; every former
  // path field is an unknown key to the schema and is refused by name by the
  // route guard (`legacy_field`) before the schema runs.
  it("requires executionWorkspaceId", () => {
    const result = StartSessionRequestSchema.safeParse({
      stepId: "plan",
      executor: { agent: "claude", model: "claude-sonnet-4-6" },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["executionWorkspaceId"]);
    }
  });

  it("rejects every legacy path field as an unknown key", () => {
    for (const field of LEGACY_SESSION_PATH_FIELDS) {
      const result = StartSessionRequestSchema.safeParse({
        ...validRequest,
        [field]: field === "contextMounts" ? [] : "/repos/x",
      });

      expect(result.success, field).toBe(false);
    }
  });

  it("legacySessionPathField names the first legacy field present, else null", () => {
    expect(legacySessionPathField(validRequest)).toBeNull();
    expect(legacySessionPathField(null)).toBeNull();
    expect(legacySessionPathField("nope")).toBeNull();
    expect(
      legacySessionPathField({ ...validRequest, worktreePath: "/repos/x" }),
    ).toBe("worktreePath");
    expect(
      legacySessionPathField({ runId: "r", projectSlug: "p", stepId: "s" }),
    ).toBe("runId");
    // `undefined` is absence, not presence.
    expect(
      legacySessionPathField({ ...validRequest, repoPath: undefined }),
    ).toBeNull();
  });

  it("rejects a malformed executionWorkspaceId", () => {
    const result = StartSessionRequestSchema.safeParse({
      executionWorkspaceId: "ws_short",
      stepId: "plan",
      executor: { agent: "claude", model: "claude-sonnet-4-6" },
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

  it("rejects unknown executor fields", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      executor: { agent: "claude", model: "x", unsupported: "value" },
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

  it("accepts opaque capability and output object bindings", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      capabilityProfileObjectId: "f7f4ea9b-598b-4f97-97b5-5ca52d46056e",
      capabilityInstructionsObjectId: "50ba2f75-bc42-4968-bbd0-1ac0a50ec840",
      outputObjects: [
        {
          objectId: "75cb17b1-ea05-45af-9209-15f181b10925",
          kind: "plan_review",
          logicalName: "plan-review.json",
          mimeType: "application/json",
          generation: 1,
          retentionClass: "run",
          envName: "MAISTER_PLAN_REVIEW_FILE",
        },
      ],
      adapterLaunch: {
        env: { MAISTER_PROFILE_MODE: "strict" },
        preArgs: ["--profile"],
        postArgs: ["--after"],
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects manager-derived runtime object environment names", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      adapterLaunch: {
        env: { MAISTER_CAPABILITY_INSTRUCTIONS_PATH: "/repos/x/i.md" },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual([
        "adapterLaunch",
        "env",
        "MAISTER_CAPABILITY_INSTRUCTIONS_PATH",
      ]);
    }
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

  // Runtime paths are never accepted by the session schema. The host resolves
  // opaque input and output object IDs into private paths after fencing.

  it("rejects unknown start-session fields", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      prompt: "not accepted",
    });

    expect(result.success).toBe(false);
  });

  // ADR-108 (M40): the supervisor must ACCEPT the resolved guardrail rule set
  // the web tier puts on POST /sessions. Enforcement lands in Phase 2; until
  // then the schema accepts-and-ignores so an armed run can still spawn.
  it("accepts a fully-resolved guardrail hooksConfig payload", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      hooksConfig: {
        repetition: { max: 5 },
        noProgress: { maxTurns: 15 },
        pathGuard: { allowedPaths: ["src/**", "tests/**"] },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts a sparse hooksConfig (only pathGuard)", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      hooksConfig: { pathGuard: { allowedPaths: ["**"] } },
    });

    expect(result.success).toBe(true);
  });

  it("rejects a hooksConfig with an unknown rule key (strict)", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      hooksConfig: { lifecycle: "pre_tool_call" },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a hooksConfig repetition.max below 1", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      hooksConfig: { repetition: { max: 0 } },
    });

    expect(result.success).toBe(false);
  });

  // The resolver always fills pathGuard.allowedPaths (>= ["**"]); the wire schema
  // mirrors the web authoring constraints so a malformed direct-POST is rejected.
  it("rejects a hooksConfig pathGuard with an empty allowedPaths array", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      hooksConfig: { pathGuard: { allowedPaths: [] } },
    });

    expect(result.success).toBe(false);
  });

  it("rejects a hooksConfig pathGuard with an empty-string glob", () => {
    const result = StartSessionRequestSchema.safeParse({
      ...validRequest,
      hooksConfig: { pathGuard: { allowedPaths: [""] } },
    });

    expect(result.success).toBe(false);
  });
});

// ADR-166: `runId` / `projectSlug` left the session request for the adopt
// payload — the only schema that still carries them.
describe("AdoptWorkspacePayloadSchema", () => {
  const validPayload = {
    runId: "run-abc",
    projectSlug: "myapp",
    kind: "directory",
    path: "/srv/local/pkg",
  } as const;

  it("accepts runId with dots, dashes, underscores", () => {
    expect(
      AdoptWorkspacePayloadSchema.safeParse({
        ...validPayload,
        runId: "run_abc.1-2",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["a path-traversal segment", "../../../etc"],
    ["a forward slash", "run/with/slash"],
    ["over 128 chars", "a".repeat(129)],
    ["the bare `.`", "."],
    ["the bare `..`", ".."],
  ])("rejects runId with %s", (_case, runId) => {
    const result = AdoptWorkspacePayloadSchema.safeParse({
      ...validPayload,
      runId,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["runId"]);
    }
  });

  it.each([
    ["non-kebab", "My_Project"],
    ["over 64 chars", "a".repeat(65)],
  ])("rejects a %s projectSlug", (_case, projectSlug) => {
    const result = AdoptWorkspacePayloadSchema.safeParse({
      ...validPayload,
      projectSlug,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["projectSlug"]);
    }
  });
});

describe("SupervisorDiagnosticsResponseSchema", () => {
  function diagnosticsWithReadOnlySession(
    readOnlySession: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      status: "ready",
      version: "0.0.1",
      checkedAt: "2026-06-11T12:00:00.000Z",
      adapters: [
        {
          id: "opencode",
          binary: "opencode",
          source: "path",
          path: "/bin/opencode",
          available: true,
          version: null,
          error: null,
          smoke: {
            status: "ok",
            reason: null,
            checkedAt: "2026-06-11T12:00:00.000Z",
            protocolVersion: 1,
            readOnlySession,
          },
        },
      ],
      envRefs: [],
    };
  }

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
            readOnlySession: {
              status: "not_required",
              reason: null,
              checkedAt: null,
              protocolVersion: null,
              probeVersion: null,
              staleReason: null,
            },
            capabilityEnforcement: {
              status: "pending",
              reason: null,
              checkedAt: null,
              protocolVersion: null,
            },
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
            readOnlySession: {
              status: "not_required",
              reason: null,
              checkedAt: null,
              protocolVersion: null,
              probeVersion: null,
              staleReason: null,
            },
            capabilityEnforcement: {
              status: "pending",
              reason: null,
              checkedAt: null,
              protocolVersion: null,
            },
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
            readOnlySession: {
              status: "pending",
              reason: "gemini read-only-session smoke has not been cached",
              checkedAt: null,
              protocolVersion: null,
              probeVersion: null,
              staleReason: null,
            },
            capabilityEnforcement: {
              status: "pending",
              reason: "gemini capability-enforcement smoke has not been cached",
              checkedAt: null,
              protocolVersion: null,
            },
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
            readOnlySession: {
              status: "pending",
              reason: "opencode read-only-session smoke has not been cached",
              checkedAt: null,
              protocolVersion: null,
              probeVersion: null,
              staleReason: null,
            },
            capabilityEnforcement: {
              status: "pending",
              reason:
                "opencode capability-enforcement smoke has not been cached",
              checkedAt: null,
              protocolVersion: null,
            },
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
            readOnlySession: {
              status: "pending",
              reason: "mimo read-only-session smoke has not been cached",
              checkedAt: null,
              protocolVersion: null,
              probeVersion: null,
              staleReason: null,
            },
            capabilityEnforcement: {
              status: "pending",
              reason: "mimo capability-enforcement smoke has not been cached",
              checkedAt: null,
              protocolVersion: null,
            },
          },
        },
      ],
      envRefs: [],
    });

    expect(result.success).toBe(true);
  });

  it.each([
    [
      "omits staleReason",
      {
        status: "ok",
        reason: null,
        checkedAt: "2026-06-11T12:00:00.000Z",
        protocolVersion: 1,
        probeVersion: 1,
      },
    ],
    [
      "uses null staleReason for stale evidence",
      {
        status: "stale",
        reason: "probe is old",
        checkedAt: "2026-06-01T12:00:00.000Z",
        protocolVersion: 1,
        probeVersion: 1,
        staleReason: null,
      },
    ],
    [
      "uses a stale reason for non-stale evidence",
      {
        status: "ok",
        reason: null,
        checkedAt: "2026-06-11T12:00:00.000Z",
        protocolVersion: 1,
        probeVersion: 1,
        staleReason: "freshness",
      },
    ],
  ])("rejects read-only evidence that %s", (_caseName, readOnlySession) => {
    expect(
      SupervisorDiagnosticsResponseSchema.safeParse(
        diagnosticsWithReadOnlySession(readOnlySession),
      ).success,
    ).toBe(false);
  });
});

describe("SupervisorError details (ADR-166)", () => {
  it("maps FENCED to 409 and serializes details on the body", () => {
    const err = new SupervisorError("FENCED", "stale epoch", {
      details: {
        reason: "assignment_fenced",
        runId: "run-1",
        commandEpoch: 1,
        hostEpoch: 2,
      },
    });

    expect(httpStatusForCode(err.code)).toBe(409);
    expect(errorBody(err)).toEqual({
      code: "FENCED",
      message: "stale epoch",
      details: {
        reason: "assignment_fenced",
        runId: "run-1",
        commandEpoch: 1,
        hostEpoch: 2,
      },
    });
  });

  it("omits details from the body when none were attached", () => {
    expect(errorBody(new SupervisorError("SPAWN", "boom"))).toEqual({
      code: "SPAWN",
      message: "boom",
    });
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

// ADR-179: the MCP field set is shared by `POST /sessions` mcpServers[] and
// `POST /mcp-probe`. Nothing pinned it before (C5: the two schemas had already
// drifted), so these cases are the seam contract for both.

const httpServer = {
  name: "github",
  transport: "http",
  url: "https://api.githubcopilot.com/mcp/",
} as const;

const stdioServer = {
  name: "filesystem",
  transport: "stdio",
  command: "npx",
} as const;

describe("McpServerInputSchema (ADR-179)", () => {
  it("accepts env and headers value maps", () => {
    expect(
      McpServerInputSchema.safeParse({
        ...stdioServer,
        env: { GITHUB_TOKEN: "env:GITHUB_TOKEN", FASTMCP_LOG_LEVEL: "ERROR" },
      }).success,
    ).toBe(true);

    expect(
      McpServerInputSchema.safeParse({
        ...httpServer,
        headers: { "X-Tenant": "acme" },
        bearerTokenEnv: "env:GITHUB_TOKEN",
      }).success,
    ).toBe(true);
  });

  it("rejects a malformed env: value under its own key path", () => {
    const result = McpServerInputSchema.safeParse({
      ...stdioServer,
      env: { GH: "env:1BAD" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["env", "GH"]);
  });

  it("rejects bearerTokenEnv on stdio", () => {
    const result = McpServerInputSchema.safeParse({
      ...stdioServer,
      bearerTokenEnv: "env:GITHUB_TOKEN",
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["bearerTokenEnv"]);
  });

  it("rejects bearerTokenEnv beside an Authorization header, case-insensitively", () => {
    for (const headerName of [
      "Authorization",
      "authorization",
      "AUTHORIZATION",
    ]) {
      const result = McpServerInputSchema.safeParse({
        ...httpServer,
        headers: { [headerName]: "Basic abc" },
        bearerTokenEnv: "env:GITHUB_TOKEN",
      });

      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error.issues[0]?.path).toEqual(["bearerTokenEnv"]);
    }
  });

  it("rejects bearerTokenEnv that is not an env:NAME reference", () => {
    expect(
      McpServerInputSchema.safeParse({ ...httpServer, bearerTokenEnv: "tok-1" })
        .success,
    ).toBe(false);
  });

  it("rejects a header name that is not an RFC 7230 token", () => {
    expect(
      McpServerInputSchema.safeParse({
        ...httpServer,
        headers: { "X Tenant": "acme" },
      }).success,
    ).toBe(false);
  });

  it("rejects a literal header value carrying CR/LF or a control character", () => {
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const NUL = String.fromCharCode(0);
    const DEL = String.fromCharCode(127);

    for (const bad of [
      `a${CR}${LF}X-Evil: 1`,
      `a${LF}b`,
      `a${NUL}b`,
      `a${DEL}b`,
    ]) {
      expect(
        McpServerInputSchema.safeParse({
          ...httpServer,
          headers: { "X-Tenant": bad },
        }).success,
      ).toBe(false);
    }

    // A tab and the printable range stay legal field-values.
    expect(
      McpServerInputSchema.safeParse({
        ...httpServer,
        headers: { "X-Tenant": `a${String.fromCharCode(9)}b ~` },
      }).success,
    ).toBe(true);
  });

  it("rejects an env key that is not an environment variable name", () => {
    expect(
      McpServerInputSchema.safeParse({
        ...stdioServer,
        env: { "1BAD": "x" },
      }).success,
    ).toBe(false);
  });

  it("rejects more than 64 entries in either map", () => {
    const big = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`K_${i}`, "v"]),
    );

    expect(
      McpServerInputSchema.safeParse({ ...stdioServer, env: big }).success,
    ).toBe(false);
  });

  it("refuses the other transport's fields rather than carrying both", () => {
    expect(
      McpServerInputSchema.safeParse({
        ...stdioServer,
        url: "https://example.com",
      }).success,
    ).toBe(false);

    expect(
      McpServerInputSchema.safeParse({ ...httpServer, command: "npx" }).success,
    ).toBe(false);
  });
});

describe("McpProbeRequestSchema (ADR-179)", () => {
  it("shares the field set minus `name`", () => {
    expect(
      McpProbeRequestSchema.safeParse({
        transport: "stdio",
        command: "npx",
        env: { GITHUB_TOKEN: "env:GITHUB_TOKEN" },
      }).success,
    ).toBe(true);

    expect(
      McpProbeRequestSchema.safeParse({
        transport: "http",
        url: "https://mcp.example.com/v1",
        headers: { "X-Tenant": "acme" },
        bearerTokenEnv: "env:MCP_TOKEN",
      }).success,
    ).toBe(true);
  });

  it("rejects `name` — the probe body is the field set minus it", () => {
    expect(
      McpProbeRequestSchema.safeParse({
        transport: "stdio",
        command: "npx",
        name: "filesystem",
      }).success,
    ).toBe(false);
  });

  it("applies the same bearer rules", () => {
    expect(
      McpProbeRequestSchema.safeParse({
        transport: "stdio",
        command: "npx",
        bearerTokenEnv: "env:MCP_TOKEN",
      }).success,
    ).toBe(false);

    expect(
      McpProbeRequestSchema.safeParse({
        transport: "http",
        url: "https://mcp.example.com/v1",
        headers: { Authorization: "Basic abc" },
        bearerTokenEnv: "env:MCP_TOKEN",
      }).success,
    ).toBe(false);
  });
});

describe("EnvRefsRequestSchema (ADR-179)", () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `NAME_${i}`);

  it("accepts 1..64 names", () => {
    expect(EnvRefsRequestSchema.safeParse({ names: ["PATH"] }).success).toBe(
      true,
    );
    expect(EnvRefsRequestSchema.safeParse({ names: names(64) }).success).toBe(
      true,
    );
  });

  it("refuses 0 and 65 (strictly outside on both sides)", () => {
    expect(EnvRefsRequestSchema.safeParse({ names: [] }).success).toBe(false);
    expect(EnvRefsRequestSchema.safeParse({ names: names(65) }).success).toBe(
      false,
    );
  });

  it("refuses a name that is not an environment variable name", () => {
    for (const bad of ["BAD NAME", "1BAD", "a-b", ""]) {
      expect(EnvRefsRequestSchema.safeParse({ names: [bad] }).success).toBe(
        false,
      );
    }
  });

  it("refuses unknown properties", () => {
    expect(
      EnvRefsRequestSchema.safeParse({ names: ["PATH"], values: true }).success,
    ).toBe(false);
  });
});
