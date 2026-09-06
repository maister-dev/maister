import "server-only";

import type {
  PlatformStatus,
  PlatformUnavailableReason,
} from "@/types/platform-status";
import type { AgentMcpServer } from "@/lib/capabilities/agent-map";
import type { ContextMountSnapshot } from "@/lib/context-mounts/types";
import type { SessionEnforcementProfile } from "@/lib/flows/enforcement-profile";
import type { HooksConfig } from "@/lib/flows/hooks-config";

import { createHash } from "node:crypto";

import pino from "pino";
import {
  Agent,
  Request as UndiciRequest,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from "undici";
import { z } from "zod";

import {
  parseCommandReceiptV2,
  type CommandReceiptV2,
} from "../../runtime/command-evidence";

import { ADAPTER_IDS, type AdapterId } from "@/lib/acp-runners/adapter-support";
import { contextMountsToWire } from "@/lib/context-mounts/types";
import { MaisterError, type MaisterErrorCode } from "@/lib/errors";

const logger = pino({
  name: "supervisor-client",
  level: process.env.LOG_LEVEL ?? "info",
});

const DEFAULT_BASE_URL = "http://localhost:7777";
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;
const longLivedDispatcher = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
});
const binaryDispatcher = new Agent({
  headersTimeout: 10_000,
  bodyTimeout: 10_000,
});

export type SupervisorExecutorInput = {
  agent: AdapterId;
  model: string;
  env?: Record<string, string>;
};

export type SupervisorAdapterLaunchInput = {
  env?: Record<string, string>;
  preArgs?: string[];
  postArgs?: string[];
};

export type SupervisorRunnerInput = {
  version: 1;
  runnerId: string;
  adapter: AdapterId;
  capabilityAgent: AdapterId;
  model: string;
  provider:
    | { kind: "anthropic" }
    | {
        kind: "anthropic_compatible";
        baseUrl?: string;
        authTokenEnv?: string;
      }
    | { kind: "openai" }
    | {
        kind: "openai_compatible";
        baseUrl?: string;
        apiKeyEnv?: string;
        wireApi?: "responses";
      }
    | { kind: "google_gemini"; apiKeyEnv?: string }
    | {
        kind: "google_vertex";
        projectId?: string;
        location?: string;
        apiKeyEnv?: string;
      }
    | { kind: "google_gateway"; baseUrl?: string; apiKeyEnv?: string }
    | { kind: "agent_native" };
  permissionPolicy: "default" | "dangerously_skip_permissions";
  env?: Record<string, string>;
};

// ADR-166 (strict): the `session.create` payload minus its workspace address —
// `CreateSessionPayload` (execution-host contracts) adds the opaque
// `executionWorkspaceId`. Every path the host needs (cwd, confinement roots,
// run dir, context mounts) derives from the adopted handle; only the
// `workspace.adopt` payload built in `execution-host/adoption.ts` carries one.
export type CreateSessionInput = {
  stepId: string;
  nodeAttemptId?: string;
  // M42 (ADR-114): the logical Flow session this ACP process serves — stamped
  // into canonical usage and session events. Absent → supervisor defaults to "default".
  sessionName?: string;
  executor: SupervisorExecutorInput;
  runner?: SupervisorRunnerInput;
  resumeSessionId?: string;
  capabilityProfileObjectId?: string;
  capabilityInstructionsObjectId?: string;
  outputObjects?: SupervisorRuntimeOutputBinding[];
  adapterLaunch?: SupervisorAdapterLaunchInput;
  mcpServers?: AgentMcpServer[];
  // M34 (ADR-090 L1): session-scoped read-only — the supervisor auto-denies
  // write-class tool permission requests for the whole session. Used for
  // none/repo_read platform-agent runs.
  readOnlySession?: boolean;
  // B1 (execution-policy permissions=auto_approve): the supervisor auto-selects
  // the allow option for every permission request in this session (below the
  // read-only layers). Derived from the run's execution_policy snapshot.
  autoApprovePermissions?: boolean;
  // M34 lifecycle: reap the idle adapter on a clean `end_turn` for a one-shot
  // (non-persistent) standalone agent session, so the run finalizes/parks
  // instead of lingering `Running` and leaking an agent slot.
  reapOnEndTurn?: boolean;
  // ADR-108 (M40): resolved guardrail rule set. The supervisor arms the hook
  // interceptor (path_guard / repetition / no_progress) for this session; each
  // rule key is optional and an absent key means that rule is not armed.
  hooksConfig?: HooksConfig;
  // ADR-130: derived capability-enforcement set. The supervisor arms the
  // capability_guard interceptor (strict tools/mcps by tool identity) for this
  // session; absent → capability_guard is inert.
  enforcementProfile?: SessionEnforcementProfile;
};

export type CreateSessionResult = {
  sessionId: string;
  pid: number;
  acpSessionId: string;
};

export type PromptStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  // Interrupt (session/cancel): a user-requested cancel ends the turn cleanly —
  // the session stays live and the scratch dialog returns to WaitingForUser.
  | "cancelled";

export type PromptResult = {
  stopReason: PromptStopReason;
  meta?: unknown;
  runtimeObjects?: RuntimeObjectWireMetadata[];
};

export type SupervisorRuntimeOutputBinding = {
  objectId: string;
  kind:
    | "session_log"
    | "raw_transcript"
    | "cost_diagnostic"
    | "checkpoint"
    | "attachment"
    | "capability_profile"
    | "agent_memory_snapshot"
    | "node_result"
    | "evidence"
    | "generated_artifact"
    | "plan_review"
    | "diagnostic";
  logicalName: string;
  mimeType: string;
  generation: number;
  retentionClass: "run" | "delivery" | "ephemeral";
  expiresAt?: string | null;
  envName:
    | "MAISTER_OUTPUT_FILE"
    | "MAISTER_PLAN_DOCUMENT_FILE"
    | "MAISTER_PLAN_REVIEW_FILE";
};

// T5.4: structured ACP prompt content the web tier assembles (text + a
// worktree-confined file reference). Mirrors the ACP ContentBlock fields the
// web emits; the supervisor validates + forwards verbatim. `prompt` stays the
// string fallback (and the human-readable transcript record).
export type PromptContentBlock =
  | { type: "text"; text: string }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      mimeType?: string;
      description?: string;
    }
  // A manager-owned opaque object reference. The supervisor resolves it to a
  // confined file URI only after checking the run and assignment fence; this
  // variant is never forwarded to ACP verbatim.
  | {
      type: "runtime_object";
      objectId: string;
      name: string;
      mimeType?: string;
      description?: string;
    };

export type SendPromptInput = {
  stepId: string;
  nodeAttemptId?: string;
  prompt: string;
  contentBlocks?: PromptContentBlock[];
  // M30 (ADR-078 L2): answer-only gate-chat turn — the supervisor
  // auto-rejects unambiguous mutating toolCall kinds while it is in flight.
  readOnlyTurn?: boolean;
};

// The `GET /sessions` projection (mirrors `SessionListEntry` in
// supervisor/src/types.ts). Host-private paths never cross the wire.
export type SupervisorSessionRecord = {
  sessionId: string;
  adapter?: string;
  runId: string;
  projectSlug: string;
  stepId: string;
  nodeAttemptId?: string;
  sessionName?: string;
  status: "live" | "exited" | "crashed";
  pid: number;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  monotonicId: number;
  // M8 T6: keep-alive sweeper looks up sessions by acpSessionId. This
  // is the post-newSession ACP-level id the supervisor stored on
  // record.acpSessionId; mirrors supervisor/src/types.ts.
  acpSessionId?: string;
  // ADR-166: the adopted handle this session runs in and the fence of the
  // `session.create` command that spawned it.
  executionWorkspaceId?: string;
  assignmentId?: string;
  assignmentEpoch?: number;
  createdByCommandId?: string;
};

export type SupervisorModelCatalogDraft = {
  adapter: AdapterId;
  provider: Record<string, unknown>;
};

export type SupervisorModelCatalog = {
  models: { id: string; displayName?: string; origins: string[] }[];
  sources: {
    kind: string;
    status: "ok" | "skipped" | "error";
    reason?: string;
    count?: number;
  }[];
  resolvedAt: string;
  ttlSeconds: number;
};

// ADR-166 (Implemented): the durable execution-host identity reported on
// `/health`. Optional on the transport parse so a pre-ADR-166 supervisor still
// reads as ready; the registrar (lib/execution-host) REQUIRES it to register.
export const ExecutionHostIdentitySchema = z
  .object({
    hostKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    bootId: z.string().uuid(),
    protocolVersion: z.literal(1),
  })
  .strict();

export type ExecutionHostIdentity = z.infer<typeof ExecutionHostIdentitySchema>;

export const ExecutionHostDataPlaneCapabilitiesSchema = z
  .object({
    dataPlaneVersion: z.literal("execution-host-data-plane.v1"),
    eventStream: z.boolean(),
    asyncPrompt: z.boolean(),
    runtimeObjects: z.boolean(),
    limits: z
      .object({
        maxEventBytes: z.literal(1_048_576),
        maxObjectBytes: z.literal(26_214_400),
        maxReplayBatch: z.literal(500),
      })
      .strict(),
  })
  .strict();

export type ExecutionHostDataPlaneCapabilities = z.infer<
  typeof ExecutionHostDataPlaneCapabilitiesSchema
>;

const SupervisorHealthSchema = z
  .object({
    status: z.literal("ready"),
    host: ExecutionHostIdentitySchema.optional(),
    version: z.string().min(1),
    uptimeMs: z.number().int().nonnegative(),
    checkedAt: z.string().datetime(),
    sessions: z
      .object({
        live: z.number().int().nonnegative(),
        exited: z.number().int().nonnegative(),
        crashed: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const ReadOnlySmokeEvidenceBaseSchema = z
  .object({
    reason: z.string().nullable(),
    checkedAt: z.string().datetime().nullable(),
    protocolVersion: z.number().int().positive().nullable(),
    probeVersion: z.number().int().positive().nullable(),
  })
  .strict();

const ReadOnlySmokeEvidenceSchema = z.discriminatedUnion("status", [
  ReadOnlySmokeEvidenceBaseSchema.extend({
    status: z.literal("stale"),
    staleReason: z.enum(["probe_contract", "freshness"]),
  }).strict(),
  ReadOnlySmokeEvidenceBaseSchema.extend({
    status: z.enum(["not_required", "pending", "ok", "skipped", "error"]),
    staleReason: z.null(),
  }).strict(),
]);

const SupervisorDiagnosticsSchema = z
  .object({
    status: z.literal("ready"),
    version: z.string().min(1),
    checkedAt: z.string().datetime(),
    adapters: z.array(
      z
        .object({
          id: z.enum(ADAPTER_IDS),
          binary: z.string().min(1),
          source: z.enum(["path", "override"]),
          path: z.string().nullable(),
          available: z.boolean(),
          version: z.string().nullable(),
          error: z.string().nullable(),
          smoke: z
            .object({
              status: z.enum([
                "not_required",
                "pending",
                "ok",
                "skipped",
                "error",
              ]),
              reason: z.string().nullable(),
              checkedAt: z.string().datetime().nullable(),
              protocolVersion: z.number().int().positive().nullable(),
              readOnlySession: ReadOnlySmokeEvidenceSchema,
              // capabilityEnforcement is a simple dimension (no probe version /
              // staleness) — distinct from the richer read-only-session evidence.
              capabilityEnforcement: z
                .object({
                  status: z.enum([
                    "not_required",
                    "pending",
                    "ok",
                    "skipped",
                    "error",
                  ]),
                  reason: z.string().nullable(),
                  checkedAt: z.string().datetime().nullable(),
                  protocolVersion: z.number().int().positive().nullable(),
                })
                .strict(),
            })
            .strict(),
        })
        .strict(),
    ),
    envRefs: z.array(
      z
        .object({
          name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
          present: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export type {
  PlatformStatus,
  PlatformUnavailableReason,
  SupervisorHealth,
} from "@/types/platform-status";

export type SupervisorDiagnostics = z.infer<typeof SupervisorDiagnosticsSchema>;

export type SupervisorDiagnosticsStatus =
  | { kind: "ready"; diagnostics: SupervisorDiagnostics }
  | {
      kind: "unavailable";
      reason: PlatformUnavailableReason;
      message: string;
    };

export type SupervisorPermissionOption = {
  optionId: string;
  kind?: string;
  name?: string;
};

export type SupervisorEvent =
  | {
      type: "session.line";
      sessionId: string;
      monotonicId: number;
      line: string;
    }
  | {
      type: "session.update";
      sessionId: string;
      monotonicId: number;
      update: unknown;
    }
  | {
      type: "session.permission_request";
      sessionId: string;
      monotonicId: number;
      requestId: string;
      options: ReadonlyArray<SupervisorPermissionOption>;
      toolCall: unknown;
    }
  | {
      type: "session.exited";
      sessionId: string;
      monotonicId: number;
      exitCode: number;
      // M8 review fix: optional supervisor-side intentional-shutdown
      // marker. "checkpoint" = graceful checkpoint via
      // POST /sessions/{id}/checkpoint (sweeper or manual). "intentional"
      // = plain DELETE /sessions/{id}. Absent on natural process exit.
      // Mirrors supervisor/src/types.ts and docs/api/async/supervisor-sse
      // .asyncapi.yaml SessionExitedEvent. ADR-166: "fenced" = evicted by a
      // command carrying a higher assignment epoch.
      reason?: "checkpoint" | "intentional" | "fenced";
    }
  | {
      type: "session.crashed";
      sessionId: string;
      monotonicId: number;
      exitCode: number | null;
      signal: string | null;
    }
  // M30 (ADR-078 DD4): answer-only gate-chat turn — rendered in the chat
  // surface, never the flow timeline. Mirrors supervisor/src/types.ts and
  // both AsyncAPI files.
  | {
      type: "session.chat_turn";
      sessionId: string;
      monotonicId: number;
      hitlRequestId: string;
      role: "user" | "agent";
      body: string;
      seq?: number;
      mutationReverted?: boolean;
    }
  // ADR-108 (M40): a guardrail rule tripped at the supervisor ACP seam. `halt`
  // (repetition / no_progress) is escalated by the web tier (checkpoint +
  // NeedsInput, Phase 3); `deny` (path_guard) is record-only. Mirrors
  // supervisor/src/types.ts + docs/api/async/supervisor-sse.asyncapi.yaml.
  | {
      type: "session.hook_trip";
      sessionId: string;
      monotonicId: number;
      rule: "path_guard" | "repetition" | "no_progress" | "capability_guard";
      lifecycle: "pre_tool_call" | "post_turn";
      disposition: "deny" | "halt";
      toolCall: unknown;
    }
  // ADR-166 (Implemented): command acceptance / completion for the enveloped
  // session routes — the durable completion signal beside the long-lived HTTP
  // response. Mirrors supervisor/src/types.ts + supervisor-sse.asyncapi.yaml.
  // Consumed by the execution-host command ledger; every other consumer
  // ignores it.
  | {
      type: "session.command";
      sessionId: string;
      monotonicId: number;
      commandId: string;
      kind:
        | "session.prompt"
        | "session.input"
        | "session.cancel"
        | "session.checkpoint"
        | "session.delete";
      phase: "accepted" | "completed";
      status?: "succeeded" | "failed" | "fenced";
      result?: Record<string, unknown>;
      error?: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
    };

function baseUrl(): string {
  return process.env.MAISTER_SUPERVISOR_URL ?? DEFAULT_BASE_URL;
}

const KNOWN_SUPERVISOR_CODES: ReadonlySet<MaisterErrorCode> = new Set([
  "PRECONDITION",
  "SPAWN",
  "NEEDS_INPUT",
  "EXECUTOR_UNAVAILABLE",
  "ACP_PROTOCOL",
  "CHECKPOINT",
  "CRASH",
]);

function isKnownCode(value: unknown): value is MaisterErrorCode {
  return (
    typeof value === "string" &&
    KNOWN_SUPERVISOR_CODES.has(value as MaisterErrorCode)
  );
}

// ADR-166 D5: the ONE status+body → MaisterError mapping. The supervisor's
// `details` travel through untouched (reason tokens are the contract), and the
// wire-only `FENCED` code lands as `CONFLICT {details.reason:"assignment_fenced"}`
// — no new MaisterError member. `details.httpStatus` lets an endpoint apply
// its own status-specific rule (input 410 → HITL_TIMEOUT) without re-parsing.
export function supervisorErrorToMaister(
  status: number,
  body: unknown,
  fallbackCode: MaisterErrorCode,
): MaisterError {
  const record =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const wireCode = typeof record.code === "string" ? record.code : null;
  const wireDetails =
    record.details && typeof record.details === "object"
      ? (record.details as Record<string, unknown>)
      : {};
  const message =
    typeof record.message === "string"
      ? record.message
      : `supervisor ${status}`;

  if (wireCode === "FENCED") {
    return new MaisterError("CONFLICT", message, {
      details: {
        ...wireDetails,
        reason: "assignment_fenced",
        httpStatus: status,
      },
    });
  }

  return new MaisterError(
    isKnownCode(wireCode) ? wireCode : fallbackCode,
    message,
    { details: { ...wireDetails, httpStatus: status } },
  );
}

async function asMaisterError(
  res: Response,
  fallbackCode: MaisterErrorCode,
): Promise<MaisterError> {
  let body: unknown = null;

  try {
    body = await res.json();
  } catch {
    /* non-JSON body, fall through */
  }

  return supervisorErrorToMaister(res.status, body, fallbackCode);
}

// A failure whose outcome on the host is UNKNOWN (the request may or may not
// have executed): network error, timeout, non-JSON 5xx. The execution-host
// deliverer retries the SAME command id on this marker and on nothing else.
export const UNKNOWN_OUTCOME_TRANSPORT = "unknown_outcome" as const;

function unknownOutcomeError(
  err: unknown,
  ctx: string,
  reason: "network" | "timeout" | "non_json_5xx",
): MaisterError {
  const message = err instanceof Error ? err.message : String(err);

  return new MaisterError("EXECUTOR_UNAVAILABLE", `${ctx}: ${message}`, {
    cause: err instanceof Error ? err : undefined,
    details: { transport: UNKNOWN_OUTCOME_TRANSPORT, reason },
  });
}

function networkErrorToMaister(err: unknown, ctx: string): MaisterError {
  return unknownOutcomeError(
    err,
    ctx,
    isAbortError(err) ? "timeout" : "network",
  );
}

async function fetchLongLivedSupervisor(
  url: string,
  init: Omit<UndiciRequestInit, "dispatcher">,
  ctx: string,
): Promise<Response> {
  logger.debug(
    { url, ctx },
    "[FIX:supervisor-long-lived-fetch] using undici dispatcher without headers/body timeout",
  );

  return (await undiciFetch(url, {
    ...init,
    dispatcher: longLivedDispatcher,
  })) as unknown as Response;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.message.includes("aborted"))
  );
}

export async function checkSupervisorHealth(
  opts: { timeoutMs?: number } = {},
): Promise<PlatformStatus> {
  const url = `${baseUrl()}/health`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
  );
  let res: Response;

  logger.debug({ url }, "checkSupervisorHealth");

  try {
    res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return {
      kind: "unavailable",
      reason: isAbortError(err) ? "timeout" : "network",
      message,
    };
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const message = await readErrorMessage(res, `supervisor ${res.status}`);

    return { kind: "unavailable", reason: "http", message };
  }

  let body: unknown;

  try {
    body = await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return { kind: "unavailable", reason: "malformed", message };
  }

  const parsed = SupervisorHealthSchema.safeParse(body);

  if (!parsed.success) {
    return {
      kind: "unavailable",
      reason: "malformed",
      message: parsed.error.message,
    };
  }

  return { kind: "ready", health: parsed.data };
}

export async function checkSupervisorDiagnostics(
  opts: { timeoutMs?: number } = {},
): Promise<SupervisorDiagnosticsStatus> {
  const url = `${baseUrl()}/diagnostics`;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
  );
  let res: Response;

  logger.debug({ url }, "checkSupervisorDiagnostics");

  try {
    res = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return {
      kind: "unavailable",
      reason: isAbortError(err) ? "timeout" : "network",
      message,
    };
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const message = await readErrorMessage(res, `supervisor ${res.status}`);

    return { kind: "unavailable", reason: "http", message };
  }

  let body: unknown;

  try {
    body = await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return { kind: "unavailable", reason: "malformed", message };
  }

  const parsed = SupervisorDiagnosticsSchema.safeParse(body);

  if (!parsed.success) {
    return {
      kind: "unavailable",
      reason: "malformed",
      message: parsed.error.message,
    };
  }

  return { kind: "ready", diagnostics: parsed.data };
}

export async function listSessions(): Promise<SupervisorSessionRecord[]> {
  const url = `${baseUrl()}/sessions`;

  logger.debug({ url }, "listSessions");
  let res: Response;

  try {
    res = await fetch(url);
  } catch (err) {
    throw networkErrorToMaister(err, "listSessions");
  }
  if (res.status >= 500) {
    const message = await readErrorMessage(
      res,
      `supervisor ${res.status} while listing sessions`,
    );

    throw new MaisterError("EXECUTOR_UNAVAILABLE", message);
  }
  if (!res.ok) {
    throw await asMaisterError(res, "ACP_PROTOCOL");
  }

  return (await res.json()) as SupervisorSessionRecord[];
}

export async function resolveModelSuggestions(
  draft: SupervisorModelCatalogDraft,
  opts?: { force?: boolean },
): Promise<SupervisorModelCatalog> {
  const url = `${baseUrl()}/model-catalog/resolve`;

  logger.debug({ url, adapter: draft.adapter }, "resolveModelSuggestions");
  let res: Response;

  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...draft, force: opts?.force ?? false }),
    });
  } catch (err) {
    throw networkErrorToMaister(err, "resolveModelSuggestions");
  }
  if (!res.ok) {
    throw await asMaisterError(res, "EXECUTOR_UNAVAILABLE");
  }

  return (await res.json()) as SupervisorModelCatalog;
}

// ADR-129 (W-F): proxy a NAMES-only MCP health probe to the supervisor. The
// exec-trust gate is enforced web-side BEFORE this call; the supervisor resolves
// env/header values from process.env and never returns a secret.
export type SupervisorMcpProbeRequest = {
  transport: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  envKeys?: string[];
  url?: string;
  headerKeys?: string[];
};

export type SupervisorMcpProbeResult = {
  ok: boolean;
  latencyMs?: number;
  serverInfo?: { name: string; version: string } | null;
  reason?: string;
};

export async function probeMcpViaSupervisor(
  req: SupervisorMcpProbeRequest,
): Promise<SupervisorMcpProbeResult> {
  const url = `${baseUrl()}/mcp-probe`;

  logger.debug({ url, transport: req.transport }, "probeMcpViaSupervisor");
  let res: Response;

  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
  } catch (err) {
    throw networkErrorToMaister(err, "probeMcpViaSupervisor");
  }
  if (!res.ok) {
    throw await asMaisterError(res, "EXECUTOR_UNAVAILABLE");
  }

  return (await res.json()) as SupervisorMcpProbeResult;
}

async function readErrorMessage(
  res: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };

    if (typeof body?.message === "string") return body.message;
  } catch {
    /* non-JSON body */
  }

  return fallback;
}

// M8 T5: typed CheckpointResponse mirrors the supervisor's response shape so
// callers (the keep-alive sweeper, the resume helper) can branch on
// `alreadyCheckpointed` without re-parsing the body.
//
// HTTP status translation (D7 + D11):
//   200  → { alreadyCheckpointed, sessionId, monotonicId }
//   404  → MaisterError("CHECKPOINT") — unknown session; terminal (sweeper marks markCheckpointed directly)
//   409  → MaisterError("CHECKPOINT") — body validation rejected
//   5xx  → MaisterError("EXECUTOR_UNAVAILABLE") — retryable, sweeper retries on next tick
//   network/abort → MaisterError("EXECUTOR_UNAVAILABLE") — retryable
export type CheckpointResponse = {
  alreadyCheckpointed: boolean;
  sessionId: string;
  monotonicId: number;
};

export async function* streamSession(
  sessionId: string,
  opts: { lastEventId?: number; signal?: AbortSignal } = {},
): AsyncGenerator<SupervisorEvent, void, void> {
  const url = `${baseUrl()}/sessions/${encodeURIComponent(sessionId)}/stream`;
  const headers: Record<string, string> = {};

  if (opts.lastEventId !== undefined) {
    headers["Last-Event-ID"] = String(opts.lastEventId);
  }
  logger.debug(
    { url, sessionId, lastEventId: opts.lastEventId },
    "streamSession",
  );
  let res: Response;

  try {
    res = await fetchLongLivedSupervisor(
      url,
      { headers, signal: opts.signal },
      "streamSession",
    );
  } catch (err) {
    throw networkErrorToMaister(err, "streamSession");
  }
  if (!res.ok || !res.body) {
    throw await asMaisterError(res, "ACP_PROTOCOL");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentData = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");

      while (nl !== -1) {
        const rawLine = buffer.slice(0, nl);

        buffer = buffer.slice(nl + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line === "") {
          if (currentData) {
            try {
              yield JSON.parse(currentData) as SupervisorEvent;
            } catch (err) {
              logger.warn(
                { err: (err as Error).message },
                "stream-parse-failed",
              );
            }
            currentData = "";
          }
        } else if (line.startsWith("data:")) {
          const chunk = line.slice(5).trimStart();

          currentData = currentData ? `${currentData}\n${chunk}` : chunk;
        }
        nl = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* streamRuntimeEvents(
  opts: { afterSequence?: string; signal?: AbortSignal } = {},
): AsyncGenerator<Record<string, unknown>, void, void> {
  const url = `${baseUrl()}/runtime-events`;
  const headers: Record<string, string> = {};

  if (opts.afterSequence !== undefined) {
    headers["Last-Event-ID"] = opts.afterSequence;
  }
  logger.debug(
    { url, afterSequence: opts.afterSequence },
    "streamRuntimeEvents",
  );

  let res: Response;

  try {
    res = await fetchLongLivedSupervisor(
      url,
      { headers, signal: opts.signal },
      "streamRuntimeEvents",
    );
  } catch (error) {
    throw networkErrorToMaister(error, "streamRuntimeEvents");
  }
  if (!res.ok || !res.body) {
    throw await asMaisterError(res, "ACP_PROTOCOL");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frameId: string | null = null;
  let currentData = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");

      while (newline !== -1) {
        const rawLine = buffer.slice(0, newline);

        buffer = buffer.slice(newline + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line === "") {
          if (!currentData || frameId === null) {
            throw new MaisterError(
              "ACP_PROTOCOL",
              "runtime event SSE frame is missing an id or data",
            );
          }
          let data: unknown;

          try {
            data = JSON.parse(currentData);
          } catch (error) {
            throw new MaisterError(
              "ACP_PROTOCOL",
              `runtime event SSE payload is not JSON: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          if (!data || typeof data !== "object") {
            throw new MaisterError(
              "ACP_PROTOCOL",
              "runtime event SSE payload must be an object",
            );
          }
          if ((data as { sequence?: unknown }).sequence !== frameId) {
            throw new MaisterError(
              "ACP_PROTOCOL",
              "runtime event SSE id does not match envelope sequence",
            );
          }
          yield data as Record<string, unknown>;
          frameId = null;
          currentData = "";
        } else if (line.startsWith("id:")) {
          frameId = line.slice(3).trim();
        } else if (line.startsWith("data:")) {
          const chunk = line.slice(5).trimStart();

          currentData = currentData ? `${currentData}\n${chunk}` : chunk;
        }
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ============================================================================
// ADR-166 (Implemented) — enveloped wire. Importable ONLY from
// `web/lib/execution-host/**` (the local-direct transport); domain code goes
// through `BoundClient` / `HostAdminClient`. Every enveloped variant shares the
// ONE `request()` helper below, so status classification (definitive vs
// unknown-outcome), replay detection, and `details` pass-through live in one
// place. The legacy path-bearing functions above are deleted at the strict
// flip (T5.3) once no importer remains.
// ============================================================================

export type WireCommandFence = {
  hostKey: string;
  assignmentId: string;
  assignmentEpoch: number;
  runId: string;
};

export type WireEnvelope<TPayload = unknown> = {
  requestVersion?: 2;
  target?: { hostSessionId: string };
  command: { id: string; kind: string; issuedAt: string };
  fence: WireCommandFence;
  payload: TPayload;
};

export type WorkspaceKindWire = "git_worktree" | "repo_checkout" | "directory";

export type AdoptWorkspaceWirePayload = {
  runId: string;
  projectSlug: string;
  kind: WorkspaceKindWire;
  path: string;
  repoPath?: string;
  contextMounts?: ContextMountSnapshot[];
};

export type AdoptWorkspaceWireResult = {
  executionWorkspaceId: string;
  kind: WorkspaceKindWire;
  replayed: boolean;
};

export type WorkspaceRecordWire = {
  executionWorkspaceId: string;
  runId: string;
  projectSlug: string;
  kind: WorkspaceKindWire;
  adoptedAt: string;
  releasedAt: string | null;
};

export type CommandReceiptWire = CommandReceiptV2 | LegacyCommandReceiptWire;

export type LegacyCommandReceiptWire = {
  commandId: string;
  runId: string;
  kind: string;
  assignmentEpoch: number;
  phase: "accepted" | "completed" | "rejected";
  httpStatus: number;
  body: Record<string, unknown>;
  receivedAt: string;
  completedAt: string | null;
  eventId: string | null;
  // `accepted` + `inflight:false` = the host restarted mid-turn (turn_lost).
  inflight: boolean;
};

export type DeleteSessionOutcome = "terminated" | "gone";

export type PromptAccepted = {
  commandId: string;
  state: "accepted";
};

export const COMMAND_REPLAYED_HEADER = "x-maister-command-replayed";

type WireRequest = {
  method: "GET" | "POST" | "DELETE" | "PUT";
  path: string;
  body?: unknown;
  ctx: string;
  fallbackCode: MaisterErrorCode;
  timeoutMs?: number | null;
  longLived?: boolean;
  signal?: AbortSignal;
};

type WireResponse<T> = { status: number; body: T; replayed: boolean };

function combineSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (a && b) return AbortSignal.any([a, b]);

  return a ?? b;
}

async function request<T>(spec: WireRequest): Promise<WireResponse<T>> {
  const url = `${baseUrl()}${spec.path}`;
  const controller = spec.timeoutMs ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), spec.timeoutMs ?? undefined)
    : null;
  const headers: Record<string, string> =
    spec.body !== undefined ? { "content-type": "application/json" } : {};
  const init = {
    method: spec.method,
    headers,
    body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
    signal: combineSignals(spec.signal, controller?.signal),
  };
  let res: Response;

  try {
    logger.debug({ url, method: spec.method, ctx: spec.ctx }, "wire-request");

    try {
      res = spec.longLived
        ? await fetchLongLivedSupervisor(url, init, spec.ctx)
        : await fetch(url, { ...init, cache: "no-store" });
    } catch (err) {
      throw networkErrorToMaister(err, spec.ctx);
    }

    const replayed = res.headers.get(COMMAND_REPLAYED_HEADER) === "true";

    if (res.ok) {
      if (res.status === 204) {
        return { status: res.status, body: null as T, replayed };
      }

      try {
        return { status: res.status, body: (await res.json()) as T, replayed };
      } catch (error) {
        // A truncated/timed-out success body may follow an already applied
        // effect. Keep the original request unknown rather than guessing failure.
        throw networkErrorToMaister(error, spec.ctx);
      }
    }

    let errorBody: unknown = null;
    let parsed = false;

    try {
      errorBody = await res.json();
      parsed = true;
    } catch {
      /* non-JSON error body */
    }

    if (!parsed && res.status >= 500) {
      throw unknownOutcomeError(
        new Error(`supervisor ${res.status} (non-JSON body)`),
        spec.ctx,
        "non_json_5xx",
      );
    }

    throw supervisorErrorToMaister(res.status, errorBody, spec.fallbackCode);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function httpStatusOf(err: unknown): number | null {
  const status =
    err instanceof MaisterError ? err.details?.httpStatus : undefined;

  return typeof status === "number" ? status : null;
}

// A parsed 5xx is DEFINITIVE (the host answered): EXECUTOR_UNAVAILABLE without
// the unknown-outcome marker, so the ledger records `failed` after one attempt
// and the caller's own retry issues a NEW command (D5).
function definitiveUnavailable(err: unknown): never {
  const status = httpStatusOf(err);

  if (err instanceof MaisterError && status !== null && status >= 500) {
    throw new MaisterError("EXECUTOR_UNAVAILABLE", err.message, {
      details: err.details,
    });
  }

  throw err;
}

function sessionPath(sessionId: string, suffix = ""): string {
  return `/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

// Admin reads (receipts, handles) carry no command policy; this is their only
// timeout. Command routes take theirs from the caller (ADR-166 D5 policy table).
const ADMIN_READ_TIMEOUT_MS = 10_000;

export type CommandWireOptions = { timeoutMs?: number | null };

export type RuntimeObjectWireMetadata = {
  objectId: string;
  kind: string;
  logicalName: string;
  mimeType: string;
  sizeBytes: number | null;
  sha256: string | null;
  generation: number;
  retentionClass: string;
  state: string;
  createdAt: string;
  sealedAt: string | null;
  expiresAt: string | null;
  deletedAt: string | null;
};

const RuntimeObjectWireMetadataSchema = z
  .object({
    objectId: z.string().uuid(),
    kind: z.string().min(1),
    logicalName: z.string().min(1),
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative().nullable(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    generation: z.number().int().min(1),
    retentionClass: z.string().min(1),
    state: z.string().min(1),
    createdAt: z.string().datetime({ offset: true }),
    sealedAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    deletedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

function parseRuntimeObjectWireMetadata(
  value: unknown,
): RuntimeObjectWireMetadata {
  const parsed = RuntimeObjectWireMetadataSchema.safeParse(value);

  if (!parsed.success) {
    throw new MaisterError(
      "ACP_PROTOCOL",
      "supervisor returned invalid runtime object metadata",
    );
  }

  return parsed.data;
}

export async function adoptWorkspace(
  envelope: WireEnvelope<AdoptWorkspaceWirePayload>,
  opts: CommandWireOptions = {},
): Promise<AdoptWorkspaceWireResult> {
  const { contextMounts, ...rest } = envelope.payload;
  // ADR-157: the supervisor's ContextMountSchema is strict and wire-shaped;
  // this is the one place the adopt body is built.
  const body: WireEnvelope = {
    ...envelope,
    payload:
      contextMounts && contextMounts.length > 0
        ? { ...rest, contextMounts: contextMountsToWire(contextMounts) }
        : rest,
  };
  const res = await request<AdoptWorkspaceWireResult>({
    method: "POST",
    path: "/workspaces/adopt",
    body,
    ctx: "adoptWorkspace",
    fallbackCode: "PRECONDITION",
    timeoutMs: opts.timeoutMs,
  });

  return { ...res.body, replayed: res.body.replayed || res.replayed };
}

export async function getWorkspace(
  executionWorkspaceId: string,
): Promise<WorkspaceRecordWire | null> {
  try {
    const res = await request<WorkspaceRecordWire>({
      method: "GET",
      path: `/workspaces/${encodeURIComponent(executionWorkspaceId)}`,
      ctx: "getWorkspace",
      fallbackCode: "PRECONDITION",
      timeoutMs: ADMIN_READ_TIMEOUT_MS,
    });

    return res.body;
  } catch (err) {
    if (httpStatusOf(err) === 404) return null;
    throw err;
  }
}

export async function releaseWorkspace(
  executionWorkspaceId: string,
  envelope: WireEnvelope,
  opts: CommandWireOptions = {},
): Promise<{ released: boolean }> {
  try {
    const res = await request<{ released: boolean }>({
      method: "DELETE",
      path: `/workspaces/${encodeURIComponent(executionWorkspaceId)}`,
      body: envelope,
      ctx: "releaseWorkspace",
      fallbackCode: "PRECONDITION",
      timeoutMs: opts.timeoutMs,
    });

    return { released: res.body.released === true };
  } catch (err) {
    if (httpStatusOf(err) === 404) return { released: false };
    throw err;
  }
}

export async function getCommandReceipt(
  commandId: string,
): Promise<CommandReceiptWire | null> {
  try {
    const res = await request<CommandReceiptWire>({
      method: "GET",
      path: `/commands/${encodeURIComponent(commandId)}`,
      ctx: "getCommandReceipt",
      fallbackCode: "PRECONDITION",
      timeoutMs: ADMIN_READ_TIMEOUT_MS,
    });

    if ("receiptVersion" in res.body) return parseCommandReceiptV2(res.body);

    return { ...res.body, inflight: res.body.inflight === true };
  } catch (err) {
    if (httpStatusOf(err) === 404) return null;
    throw err;
  }
}

export async function getRuntimeObject(
  objectId: string,
): Promise<RuntimeObjectWireMetadata | null> {
  try {
    const response = await request<unknown>({
      method: "GET",
      path: `/runtime-objects/${encodeURIComponent(objectId)}`,
      ctx: "getRuntimeObject",
      fallbackCode: "PRECONDITION",
      timeoutMs: ADMIN_READ_TIMEOUT_MS,
    });

    return parseRuntimeObjectWireMetadata(response.body);
  } catch (error) {
    if (httpStatusOf(error) === 404) return null;
    throw error;
  }
}

export async function reserveRuntimeObject(
  envelope: WireEnvelope,
  opts: CommandWireOptions = {},
): Promise<RuntimeObjectWireMetadata> {
  const response = await request<unknown>({
    method: "POST",
    path: "/runtime-objects",
    body: envelope,
    ctx: "reserveRuntimeObject",
    fallbackCode: "ACP_PROTOCOL",
    timeoutMs: opts.timeoutMs,
  });

  return parseRuntimeObjectWireMetadata(response.body);
}

function invalidBinaryRequest(ctx: string): MaisterError {
  logger.warn(
    { ctx, transport: "not_sent", reason: "transport_request_invalid" },
    "runtime-object-request-refused",
  );

  return new MaisterError("ACP_PROTOCOL", `${ctx}: invalid binary request`, {
    details: { transport: "not_sent", reason: "transport_request_invalid" },
  });
}

type BinaryReply = { response: UndiciResponse; finish: () => void };

async function runtimeObjectBinaryResponse(input: {
  path: string;
  method: "GET" | "PUT";
  headers?: Record<string, string>;
  bytes?: Uint8Array;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  ctx: string;
}): Promise<BinaryReply> {
  if (
    input.timeoutMs !== undefined &&
    input.timeoutMs !== null &&
    (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)
  ) {
    throw invalidBinaryRequest(input.ctx);
  }
  const timeoutMs = input.timeoutMs ?? ADMIN_READ_TIMEOUT_MS;
  const controller = new AbortController();
  let request: UndiciRequest;

  // Construction is synchronous and cannot have reached the peer. Do not
  // classify malformed local headers/URLs as uncertain remote execution.
  try {
    request = new UndiciRequest(`${baseUrl()}${input.path}`, {
      method: input.method,
      headers: input.headers,
      body: input.bytes,
      cache: "no-store",
      signal: combineSignals(input.signal, controller.signal),
    });
  } catch {
    throw invalidBinaryRequest(input.ctx);
  }
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const finish = () => {
    if (timer) clearTimeout(timer);
  };

  try {
    const response = await undiciFetch(request, {
      dispatcher: binaryDispatcher,
    });

    logger.debug(
      {
        ctx: input.ctx,
        method: input.method,
        bytes: input.bytes?.byteLength,
        status: response.status,
      },
      "runtime-object-response",
    );

    // The deadline covers body consumption, not only response headers.
    return { response, finish };
  } catch (error) {
    finish();
    throw networkErrorToMaister(error, input.ctx);
  }
}

async function throwRuntimeObjectWireError(
  response: UndiciResponse,
  ctx: string,
): Promise<never> {
  let body: unknown = null;

  try {
    body = await response.json();
  } catch {
    // A non-JSON 5xx cannot prove whether host state advanced.
    if (response.status >= 500) {
      throw unknownOutcomeError(
        new Error(`supervisor ${response.status} (non-JSON body)`),
        ctx,
        "non_json_5xx",
      );
    }
  }
  throw supervisorErrorToMaister(response.status, body, "ACP_PROTOCOL");
}

export async function uploadRuntimeObject(input: {
  objectId: string;
  envelope: WireEnvelope<{
    generation: number;
    sizeBytes: number;
    sha256: string;
  }>;
  bytes: Uint8Array;
  timeoutMs?: number | null;
}): Promise<RuntimeObjectWireMetadata> {
  const uploadSchema = z.object({
    objectId: z.string().uuid(),
    commandId: z.string().uuid(),
    assignmentId: z.string().uuid(),
    assignmentEpoch: z.number().int().positive(),
    generation: z.number().int().positive(),
    sizeBytes: z.number().int().min(0).max(26_214_400),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  });
  const parsed = uploadSchema.safeParse({
    objectId: input.objectId,
    commandId: input.envelope.command.id,
    assignmentId: input.envelope.fence.assignmentId,
    assignmentEpoch: input.envelope.fence.assignmentEpoch,
    ...input.envelope.payload,
  });

  if (
    !parsed.success ||
    input.envelope.payload.sizeBytes !== input.bytes.byteLength ||
    createHash("sha256").update(input.bytes).digest("hex") !==
      input.envelope.payload.sha256
  ) {
    throw invalidBinaryRequest("uploadRuntimeObject");
  }
  const digest = `sha-256=:${Buffer.from(input.envelope.payload.sha256, "hex").toString("base64")}:`;
  const { response, finish } = await runtimeObjectBinaryResponse({
    path: `/runtime-objects/${encodeURIComponent(input.objectId)}/content`,
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(input.bytes.byteLength),
      "content-digest": digest,
      "x-maister-command-id": input.envelope.command.id,
      "x-maister-command-issued-at": input.envelope.command.issuedAt,
      "x-maister-assignment-id": input.envelope.fence.assignmentId,
      "x-maister-assignment-epoch": String(
        input.envelope.fence.assignmentEpoch,
      ),
      "x-maister-object-generation": String(input.envelope.payload.generation),
      "x-maister-sha256": input.envelope.payload.sha256,
    },
    bytes: input.bytes,
    timeoutMs: input.timeoutMs,
    ctx: "uploadRuntimeObject",
  });

  try {
    if (!response.ok)
      return await throwRuntimeObjectWireError(response, "uploadRuntimeObject");

    return parseRuntimeObjectWireMetadata(await response.json());
  } catch (error) {
    if (error instanceof MaisterError) throw error;
    throw networkErrorToMaister(error, "uploadRuntimeObject");
  } finally {
    finish();
  }
}

export async function getRuntimeObjectContent(
  objectId: string,
  opts: { range?: { start: number; end?: number }; signal?: AbortSignal } = {},
): Promise<{
  bytes: Uint8Array;
  contentRange: string | null;
  contentDigest: string | null;
}> {
  const opened = await openRuntimeObjectContent(objectId, opts);

  return {
    bytes: new Uint8Array(await new Response(opened.body).arrayBuffer()),
    contentRange: opened.contentRange,
    contentDigest: opened.contentDigest,
  };
}

export async function openRuntimeObjectContent(
  objectId: string,
  opts: { range?: { start: number; end?: number }; signal?: AbortSignal } = {},
): Promise<{
  body: ReadableStream<Uint8Array>;
  contentLength: number | null;
  contentRange: string | null;
  contentDigest: string | null;
}> {
  const range = opts.range
    ? `bytes=${opts.range.start}-${opts.range.end ?? ""}`
    : undefined;
  const { response, finish } = await runtimeObjectBinaryResponse({
    path: `/runtime-objects/${encodeURIComponent(objectId)}/content`,
    method: "GET",
    headers: range ? { range } : undefined,
    timeoutMs: ADMIN_READ_TIMEOUT_MS,
    ctx: "getRuntimeObjectContent",
    signal: opts.signal,
  });

  if (!response.ok) {
    try {
      return await throwRuntimeObjectWireError(
        response,
        "getRuntimeObjectContent",
      );
    } finally {
      finish();
    }
  }
  if (!response.body) {
    finish();
    throw new MaisterError(
      "ACP_PROTOCOL",
      "runtime object content response is missing its body stream",
      { details: { reason: "runtime_object_missing" } },
    );
  }
  const contentLength = response.headers.get("content-length");
  const parsedContentLength =
    contentLength === null ? null : Number(contentLength);

  if (
    parsedContentLength !== null &&
    (!Number.isSafeInteger(parsedContentLength) || parsedContentLength < 0)
  ) {
    await response.body.cancel();
    finish();
    throw new MaisterError(
      "ACP_PROTOCOL",
      "runtime object content response has an invalid content length",
      { details: { reason: "runtime_object_integrity_mismatch" } },
    );
  }

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const chunk = await reader.read();

        if (chunk.done) {
          finish();
          reader.releaseLock();
          stream.close();
        } else if (chunk.value instanceof Uint8Array) {
          stream.enqueue(chunk.value);
        } else {
          throw new MaisterError(
            "ACP_PROTOCOL",
            "runtime object body is not binary",
          );
        }
      } catch (error) {
        finish();
        stream.error(
          error instanceof MaisterError
            ? error
            : networkErrorToMaister(error, "getRuntimeObjectContent"),
        );
      }
    },
    async cancel(reason: unknown) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
        reader.releaseLock();
      }
    },
  });

  return {
    body,
    contentLength: parsedContentLength,
    contentRange: response.headers.get("content-range"),
    contentDigest: response.headers.get("content-digest"),
  };
}

export async function deleteRuntimeObject(
  objectId: string,
  envelope: WireEnvelope<{ generation: number }>,
  opts: CommandWireOptions = {},
): Promise<void> {
  await request<null>({
    method: "DELETE",
    path: `/runtime-objects/${encodeURIComponent(objectId)}`,
    body: envelope,
    ctx: "deleteRuntimeObject",
    fallbackCode: "ACP_PROTOCOL",
    timeoutMs: opts.timeoutMs,
  });
}

export async function getExecutionHostCapabilities(): Promise<ExecutionHostDataPlaneCapabilities | null> {
  try {
    const res = await request<unknown>({
      method: "GET",
      path: "/capabilities",
      ctx: "getExecutionHostCapabilities",
      fallbackCode: "ACP_PROTOCOL",
      timeoutMs: ADMIN_READ_TIMEOUT_MS,
    });

    return ExecutionHostDataPlaneCapabilitiesSchema.parse(res.body);
  } catch (err) {
    if (httpStatusOf(err) === 404) return null;
    throw err;
  }
}

export type RuntimeEventAckWire = {
  streamId: string;
  acknowledgedThrough: string;
};

export async function acknowledgeRuntimeEvents(input: {
  streamId: string;
  throughSequence: string;
}): Promise<RuntimeEventAckWire> {
  const res = await request<unknown>({
    method: "POST",
    path: "/runtime-events/ack",
    body: input,
    ctx: "acknowledgeRuntimeEvents",
    fallbackCode: "ACP_PROTOCOL",
    timeoutMs: ADMIN_READ_TIMEOUT_MS,
  });
  const parsed = z
    .object({
      streamId: z.string().uuid(),
      acknowledgedThrough: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),
    })
    .strict()
    .safeParse(res.body);

  if (!parsed.success) {
    throw new MaisterError(
      "ACP_PROTOCOL",
      "supervisor returned a malformed runtime event acknowledgement",
    );
  }

  return parsed.data;
}

export async function createSessionEnveloped(
  envelope: WireEnvelope,
  opts: CommandWireOptions = {},
): Promise<CreateSessionResult> {
  const res = await request<CreateSessionResult>({
    method: "POST",
    path: "/sessions",
    body: envelope,
    ctx: "createSession",
    fallbackCode: "ACP_PROTOCOL",
    timeoutMs: opts.timeoutMs,
  });

  return res.body;
}

export async function startPromptEnveloped(
  sessionId: string,
  envelope: WireEnvelope<SendPromptInput>,
  opts: CommandWireOptions = {},
): Promise<PromptAccepted> {
  const response = await request<PromptAccepted>({
    method: "POST",
    path: sessionPath(sessionId, "/prompts"),
    body: envelope,
    ctx: "startPrompt",
    fallbackCode: "ACP_PROTOCOL",
    timeoutMs: opts.timeoutMs ?? 10_000,
  });
  const body = response.body;

  if (
    response.status !== 202 ||
    body?.commandId !== envelope.command.id ||
    body?.state !== "accepted"
  ) {
    throw new MaisterError(
      "ACP_PROTOCOL",
      "supervisor returned an invalid asynchronous prompt acceptance",
      {
        details: {
          reason: "prompt_admission_mismatch",
          commandId: envelope.command.id,
        },
      },
    );
  }

  return body;
}

// Input keeps its status-specific rules: 410 (and the pre-M7 404) is a
// genuinely expired deferred → terminal HITL_TIMEOUT; a parsed 5xx is the
// "unknown session" answer → definitive EXECUTOR_UNAVAILABLE.
export async function deliverInputEnveloped(
  sessionId: string,
  envelope: WireEnvelope,
  opts: CommandWireOptions = {},
): Promise<{ ok: true; replayed: boolean }> {
  try {
    const res = await request<{ ok: true }>({
      method: "POST",
      path: sessionPath(sessionId, "/input"),
      body: envelope,
      ctx: "deliverInput",
      fallbackCode: "ACP_PROTOCOL",
      timeoutMs: opts.timeoutMs,
    });

    return { ok: true, replayed: res.replayed };
  } catch (err) {
    const status = httpStatusOf(err);

    if (
      err instanceof MaisterError &&
      (status === 410 || status === 404) &&
      err.details?.reason !== "assignment_fenced"
    ) {
      throw new MaisterError("HITL_TIMEOUT", err.message, {
        details: err.details,
      });
    }

    return definitiveUnavailable(err);
  }
}

export async function cancelPromptEnveloped(
  sessionId: string,
  envelope: WireEnvelope,
  opts: CommandWireOptions = {},
): Promise<{ cancelled: boolean }> {
  const res = await request<{ cancelled?: boolean }>({
    method: "POST",
    path: sessionPath(sessionId, "/cancel"),
    body: envelope,
    ctx: "cancelPrompt",
    fallbackCode: "ACP_PROTOCOL",
    timeoutMs: opts.timeoutMs,
  });

  return { cancelled: res.body?.cancelled === true };
}

export async function checkpointSessionEnveloped(
  sessionId: string,
  envelope: WireEnvelope,
  opts: CommandWireOptions = {},
): Promise<CheckpointResponse> {
  let body: Partial<CheckpointResponse>;

  try {
    body = (
      await request<Partial<CheckpointResponse>>({
        method: "POST",
        path: sessionPath(sessionId, "/checkpoint"),
        body: envelope,
        ctx: "checkpointSession",
        fallbackCode: "CHECKPOINT",
        timeoutMs: opts.timeoutMs,
      })
    ).body;
  } catch (err) {
    return definitiveUnavailable(err);
  }

  if (
    typeof body.alreadyCheckpointed !== "boolean" ||
    typeof body.sessionId !== "string" ||
    typeof body.monotonicId !== "number"
  ) {
    throw new MaisterError(
      "CHECKPOINT",
      `supervisor returned malformed CheckpointResponse: ${JSON.stringify(body)}`,
    );
  }

  return body as CheckpointResponse;
}

// 404 is an OUTCOME, not a failure: the session already exited in the
// list/delete interval (the `deleteSessionIfPresent` semantics).
export async function deleteSessionEnveloped(
  sessionId: string,
  envelope: WireEnvelope,
  opts: CommandWireOptions = {},
): Promise<{ outcome: DeleteSessionOutcome }> {
  try {
    await request<unknown>({
      method: "DELETE",
      path: sessionPath(sessionId),
      body: envelope,
      ctx: "deleteSession",
      fallbackCode: "ACP_PROTOCOL",
      timeoutMs: opts.timeoutMs,
    });

    return { outcome: "terminated" };
  } catch (err) {
    if (httpStatusOf(err) === 404) return { outcome: "gone" };

    return definitiveUnavailable(err);
  }
}
