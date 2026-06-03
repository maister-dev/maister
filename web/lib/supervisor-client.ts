import "server-only";

import type {
  PlatformStatus,
  PlatformUnavailableReason,
} from "@/types/platform-status";
import type { AgentMcpServer } from "@/lib/capabilities/agent-map";

import { cache } from "react";
import pino from "pino";
import { z } from "zod";

import { MaisterError, type MaisterErrorCode } from "@/lib/errors";

const logger = pino({
  name: "supervisor-client",
  level: process.env.LOG_LEVEL ?? "info",
});

const DEFAULT_BASE_URL = "http://localhost:7777";
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;

export type SupervisorExecutorInput = {
  agent: "claude" | "codex";
  model: string;
  env?: Record<string, string>;
  router?: "ccr";
};

export type SupervisorAdapterLaunchInput = {
  env?: Record<string, string>;
  preArgs?: string[];
  postArgs?: string[];
};

export type CreateSessionInput = {
  runId: string;
  projectSlug: string;
  worktreePath: string;
  stepId: string;
  executor: SupervisorExecutorInput;
  resumeSessionId?: string;
  capabilityProfilePath?: string;
  adapterLaunch?: SupervisorAdapterLaunchInput;
  mcpServers?: AgentMcpServer[];
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
  | "cancelled";

export type PromptResult = {
  stopReason: PromptStopReason;
  meta?: unknown;
};

export type SendPromptInput = {
  stepId: string;
  prompt: string;
};

export type SupervisorSessionRecord = {
  sessionId: string;
  runId: string;
  projectSlug: string;
  stepId: string;
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

export type {
  PlatformStatus,
  PlatformUnavailableReason,
  SupervisorHealth,
} from "@/types/platform-status";

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

function unavailable(
  reason: PlatformUnavailableReason,
  message: string,
): PlatformStatus {
  return { kind: "unavailable", reason, message };
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

    return unavailable(isAbortError(err) ? "timeout" : "network", message);
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const message = await readErrorMessage(res, `supervisor ${res.status}`);

    return unavailable("http", message);
  }

  let body: unknown;

  try {
    body = await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    return unavailable("malformed", message);
  }

  const parsed = SupervisorHealthSchema.safeParse(body);

  if (!parsed.success) {
    return unavailable("malformed", parsed.error.message);
  }

  return { kind: "ready", health: parsed.data };
}

export const getPlatformStatus = cache(checkSupervisorHealth);

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
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (err) {
    throw networkErrorToMaister(err, "sendPrompt");
  }
  if (!res.ok) {
    throw await asMaisterError(res, "ACP_PROTOCOL");
  }

  return (await res.json()) as PromptResult;
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
    res = await fetch(url, { headers, signal: opts.signal });
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
