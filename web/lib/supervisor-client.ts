import "server-only";

import type {
  PlatformStatus,
  PlatformUnavailableReason,
} from "@/types/platform-status";
import type { AgentMcpServer } from "@/lib/capabilities/agent-map";
import type { HooksConfig } from "@/lib/flows/hooks-config";

import { cache } from "react";
import pino from "pino";
import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from "undici";
import { z } from "zod";

import { ADAPTER_IDS, type AdapterId } from "@/lib/acp-runners/adapter-support";
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

export type SupervisorExecutorInput = {
  agent: AdapterId;
  model: string;
  env?: Record<string, string>;
  router?: "ccr";
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
  sidecar?: {
    id: string;
    kind: "ccr";
    lifecycle?: "managed" | "external";
    configPath?: string;
    baseUrl?: string;
    healthcheckUrl?: string;
    authTokenEnv?: string;
  };
  env?: Record<string, string>;
};

export type CreateSessionInput = {
  runId: string;
  projectSlug: string;
  worktreePath: string;
  // Project repo root — forwarded so the supervisor can confine prompt
  // content-block file URIs to repo ∪ worktree ∪ run dir (matches the web-side
  // attachment confinement). Only set where the run can send file references.
  repoPath?: string;
  // M36 Phase 5 (ADR-097): SOLE content-block confinement root for a
  // project-less local-package assistant session (the working dir). Replaces
  // worktree ∪ repo as the supervisor allow-set; the run dir stays allowed.
  confineRoot?: string;
  stepId: string;
  nodeAttemptId?: string;
  // M42 (ADR-114): the logical Flow session this ACP process serves — stamped
  // onto cost.jsonl + run.events.jsonl. Absent → supervisor defaults to "default".
  sessionName?: string;
  executor: SupervisorExecutorInput;
  runner?: SupervisorRunnerInput;
  resumeSessionId?: string;
  capabilityProfilePath?: string;
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
  // ADR-108 (M40): resolved guardrail rule set. The supervisor arms the hook
  // interceptor (path_guard / repetition / no_progress) for this session; each
  // rule key is optional and an absent key means that rule is not armed.
  hooksConfig?: HooksConfig;
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
  | "refusal";

export type PromptResult = {
  stopReason: PromptStopReason;
  meta?: unknown;
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

export type SupervisorSessionRecord = {
  sessionId: string;
  runId: string;
  projectSlug: string;
  stepId: string;
  nodeAttemptId?: string;
  status: "live" | "exited" | "crashed";
  pid: number;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  logPath: string;
  monotonicId: number;
  // M8 T6: keep-alive sweeper looks up sessions by acpSessionId. This
  // is the post-newSession ACP-level id the supervisor stored on
  // record.acpSessionId; mirrors supervisor/src/types.ts.
  acpSessionId?: string;
};

export type SupervisorModelCatalogDraft = {
  adapter: AdapterId;
  provider: Record<string, unknown>;
  router?: "ccr";
  sidecarId?: string;
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

const SupervisorHealthSchema = z
  .object({
    status: z.literal("ready"),
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
            })
            .strict(),
        })
        .strict(),
    ),
    sidecars: z.array(
      z
        .object({
          id: z.string().min(1),
          kind: z.literal("ccr"),
          state: z.enum(["idle", "starting", "ready", "failed", "stopping"]),
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
      // .asyncapi.yaml SessionExitedEvent.
      reason?: "checkpoint" | "intentional";
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
      rule: "path_guard" | "repetition" | "no_progress";
      lifecycle: "pre_tool_call" | "post_turn";
      disposition: "deny" | "halt";
      toolCall: unknown;
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
  const code =
    body &&
    typeof body === "object" &&
    "code" in body &&
    isKnownCode((body as { code: unknown }).code)
      ? (body as { code: MaisterErrorCode }).code
      : fallbackCode;
  const message =
    body &&
    typeof body === "object" &&
    "message" in body &&
    typeof (body as { message: unknown }).message === "string"
      ? (body as { message: string }).message
      : `supervisor ${res.status}`;

  return new MaisterError(code, message);
}

function networkErrorToMaister(err: unknown, ctx: string): MaisterError {
  const message = err instanceof Error ? err.message : String(err);

  return new MaisterError("EXECUTOR_UNAVAILABLE", `${ctx}: ${message}`);
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

export const getPlatformStatus = cache(checkSupervisorHealth);

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

export async function createSession(
  input: CreateSessionInput,
): Promise<CreateSessionResult> {
  const url = `${baseUrl()}/sessions`;

  logger.debug({ url, runId: input.runId }, "createSession");
  let res: Response;

  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (err) {
    throw networkErrorToMaister(err, "createSession");
  }
  if (!res.ok) {
    throw await asMaisterError(res, "ACP_PROTOCOL");
  }

  return (await res.json()) as CreateSessionResult;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const url = `${baseUrl()}/sessions/${encodeURIComponent(sessionId)}`;

  logger.debug({ url, sessionId }, "deleteSession");
  let res: Response;

  try {
    res = await fetch(url, { method: "DELETE" });
  } catch (err) {
    throw networkErrorToMaister(err, "deleteSession");
  }
  if (!res.ok) {
    throw await asMaisterError(res, "ACP_PROTOCOL");
  }
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
  if (!res.ok) {
    throw await asMaisterError(res, "ACP_PROTOCOL");
  }

  return (await res.json()) as SupervisorSessionRecord[];
}

export async function sendPrompt(
  sessionId: string,
  input: SendPromptInput,
): Promise<PromptResult> {
  const url = `${baseUrl()}/sessions/${encodeURIComponent(sessionId)}/prompt`;

  logger.debug(
    { url, sessionId, stepId: input.stepId, len: input.prompt.length },
    "sendPrompt",
  );

  let res: Response;

  try {
    res = await fetchLongLivedSupervisor(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
      "sendPrompt",
    );
  } catch (err) {
    throw networkErrorToMaister(err, "sendPrompt");
  }
  if (!res.ok) {
    throw await asMaisterError(res, "ACP_PROTOCOL");
  }

  return (await res.json()) as PromptResult;
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

async function postInput(
  sessionId: string,
  body: Record<string, unknown>,
  ctx: string,
): Promise<{ ok: true }> {
  const url = `${baseUrl()}/sessions/${encodeURIComponent(sessionId)}/input`;

  logger.debug({ url, sessionId, action: body.action }, ctx);
  let res: Response;

  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw networkErrorToMaister(err, ctx);
  }
  if (res.status === 200) {
    return (await res.json()) as { ok: true };
  }
  if (res.status === 410) {
    // Genuinely expired deferred — terminal. Distinct from the 503
    // "unknown session" path, which is retryable and means the
    // supervisor restarted or the session crashed.
    const message = await readErrorMessage(res, "supervisor 410 on input");

    throw new MaisterError("HITL_TIMEOUT", message);
  }
  if (res.status === 404) {
    // Defensive fallback: pre-M7 supervisors may still emit 404 with
    // the same payload shape. Treat as terminal HITL_TIMEOUT — the
    // M7 supervisor returns 410 for this case.
    const message = await readErrorMessage(res, "supervisor 404 on input");

    throw new MaisterError("HITL_TIMEOUT", message);
  }
  if (res.status >= 500 && res.status < 600) {
    const message = await readErrorMessage(
      res,
      `supervisor ${res.status} on input`,
    );

    throw new MaisterError("EXECUTOR_UNAVAILABLE", message);
  }
  if (res.status === 409) {
    const message = await readErrorMessage(
      res,
      "supervisor 409 on input — body shape mismatch",
    );

    throw new MaisterError("ACP_PROTOCOL", message);
  }

  const message = await readErrorMessage(
    res,
    `supervisor ${res.status} on input`,
  );

  throw new MaisterError("ACP_PROTOCOL", message);
}

export async function deliverPermission(
  sessionId: string,
  requestId: string,
  optionId: string,
): Promise<{ ok: true }> {
  return postInput(
    sessionId,
    {
      kind: "permission",
      action: "select",
      requestId,
      optionId,
    },
    "deliverPermission",
  );
}

export async function cancelPermission(
  sessionId: string,
  requestId: string,
  reason: string,
): Promise<{ ok: true }> {
  return postInput(
    sessionId,
    {
      kind: "permission",
      action: "cancel",
      requestId,
      reason: reason.slice(0, 256),
    },
    "cancelPermission",
  );
}

// M8 T5: typed CheckpointResponse mirrors the supervisor's response
// shape so callers (the keep-alive sweeper T6, the resume helper T9)
// can branch on `alreadyCheckpointed` without re-parsing the body.
//
// HTTP status translation (D7 + D11):
//   200  → { ok: true, alreadyCheckpointed, sessionId, monotonicId }
//   404  → MaisterError("CHECKPOINT") — unknown session; terminal (sweeper marks markCheckpointed directly)
//   409  → MaisterError("CHECKPOINT") — body validation rejected
//   500  → MaisterError("EXECUTOR_UNAVAILABLE") — SIGKILL escalation; retryable, sweeper retries on next tick
//   network/abort → MaisterError("EXECUTOR_UNAVAILABLE") — retryable
export type CheckpointResponse = {
  alreadyCheckpointed: boolean;
  sessionId: string;
  monotonicId: number;
};

export async function checkpointSession(
  sessionId: string,
): Promise<CheckpointResponse> {
  const url = `${baseUrl()}/sessions/${encodeURIComponent(sessionId)}/checkpoint`;

  logger.debug({ url, sessionId }, "checkpointSession");
  let res: Response;

  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch (err) {
    throw networkErrorToMaister(err, "checkpointSession");
  }
  if (!res.ok) {
    // 5xx surface as EXECUTOR_UNAVAILABLE (retryable) regardless of
    // supervisor's own error code — checkpoint over a 5xx is always
    // safe to retry from the sweeper's perspective.
    if (res.status >= 500) {
      const body = (await res
        .json()
        .catch(() => ({ message: `supervisor ${res.status}` }))) as {
        message?: string;
      };

      throw new MaisterError(
        "EXECUTOR_UNAVAILABLE",
        body.message ?? `supervisor ${res.status}`,
      );
    }
    throw await asMaisterError(res, "CHECKPOINT");
  }

  const body = (await res.json()) as Partial<CheckpointResponse>;

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

// ADR-094: admin CCR sidecar start/stop. No auth header (the supervisor wire is
// server-to-server). Non-ok responses default to EXECUTOR_UNAVAILABLE; the
// supervisor's own code (PRECONDITION on an unwired manager) is preserved by
// asMaisterError when present.
export type SidecarInstanceConfig = {
  readonly lifecycle?: "managed" | "external";
  readonly configPath?: string | null;
  readonly baseUrl?: string | null;
  readonly healthcheckUrl?: string | null;
};

export type SidecarState =
  | "idle"
  | "starting"
  | "ready"
  | "failed"
  | "stopping";

export type SidecarStateResponse = {
  readonly ok: true;
  readonly state: SidecarState;
};

const SIDECAR_STATES: readonly string[] = [
  "idle",
  "starting",
  "ready",
  "failed",
  "stopping",
];

function parseSidecarStateResponse(body: unknown): SidecarStateResponse {
  if (
    body !== null &&
    typeof body === "object" &&
    (body as { ok?: unknown }).ok === true &&
    typeof (body as { state?: unknown }).state === "string" &&
    SIDECAR_STATES.includes((body as { state: string }).state)
  ) {
    return body as SidecarStateResponse;
  }

  throw new MaisterError(
    "EXECUTOR_UNAVAILABLE",
    `supervisor returned malformed sidecar state response: ${JSON.stringify(body)}`,
  );
}

export async function startSidecar(
  id: string,
  instanceConfig: SidecarInstanceConfig,
): Promise<SidecarStateResponse> {
  const url = `${baseUrl()}/sidecars/${encodeURIComponent(id)}/start`;

  logger.debug({ url, sidecarId: id }, "startSidecar");
  let res: Response;

  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, ...instanceConfig }),
    });
  } catch (err) {
    throw networkErrorToMaister(err, "startSidecar");
  }
  if (!res.ok) {
    throw await asMaisterError(res, "EXECUTOR_UNAVAILABLE");
  }

  return parseSidecarStateResponse(await res.json());
}

export async function stopSidecar(id: string): Promise<SidecarStateResponse> {
  const url = `${baseUrl()}/sidecars/${encodeURIComponent(id)}/stop`;

  logger.debug({ url, sidecarId: id }, "stopSidecar");
  let res: Response;

  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch (err) {
    throw networkErrorToMaister(err, "stopSidecar");
  }
  if (!res.ok) {
    throw await asMaisterError(res, "EXECUTOR_UNAVAILABLE");
  }

  return parseSidecarStateResponse(await res.json());
}

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
