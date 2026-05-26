import "server-only";

import pino from "pino";

import { MaisterError, type MaisterErrorCode } from "@/lib/errors";

const logger = pino({
  name: "supervisor-client",
  level: process.env.LOG_LEVEL ?? "info",
});

const DEFAULT_BASE_URL = "http://localhost:7777";

export type SupervisorExecutorInput = {
  agent: "claude" | "codex";
  model: string;
  env?: Record<string, string>;
  router?: "ccr";
};

export type CreateSessionInput = {
  runId: string;
  projectSlug: string;
  worktreePath: string;
  stepId: string;
  prompt: string;
  executor: SupervisorExecutorInput;
  resumeSessionId?: string;
};

export type CreateSessionResult = {
  sessionId: string;
  pid: number;
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
};

export type SupervisorEvent =
  | {
      type: "session.line";
      sessionId: string;
      monotonicId: number;
      line: string;
    }
  | {
      type: "session.exited";
      sessionId: string;
      monotonicId: number;
      exitCode: number;
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

export async function checkpointSession(sessionId: string): Promise<void> {
  const url = `${baseUrl()}/sessions/${encodeURIComponent(sessionId)}/checkpoint`;

  logger.debug({ url, sessionId }, "checkpointSession");
  let res: Response;

  try {
    res = await fetch(url, { method: "POST" });
  } catch (err) {
    throw networkErrorToMaister(err, "checkpointSession");
  }
  if (!res.ok) {
    throw await asMaisterError(res, "CHECKPOINT");
  }
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
