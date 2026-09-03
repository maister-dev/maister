/* eslint-disable no-console */
// Minimal stub supervisor used by the e2e suite. It answers `GET /health` and
// `GET /diagnostics` with the exact shapes lib/supervisor-client.ts accepts, so
// the app under test can exercise readiness and platform runtime diagnostics
// without spawning real agents.
//
// Why this exists: two e2e flows need the supervisor to read as *ready* without
// ever spawning a real agent —
//   • the board's Launch button is DISABLED when the platform status is not
//     ready (components/board/board.tsx), so a click-through launch is
//     impossible against an unreachable supervisor; and
//   • POST /api/runs runs `checkSupervisorHealth()` BEFORE the M11c
//     settings-enforcement gate, so an unreachable supervisor would return
//     EXECUTOR_UNAVAILABLE (503) and mask the CONFIG (400) refusal we assert.
//
// It deliberately implements ALMOST nothing else. The m11a/m11b specs never
// spawn an agent during their assertions (m11a only posts a HITL decision;
// m11b's resume path is a local `check` + a human node), so a reachable
// `/health` that lacks more surface does not change their behavior.
//
// M34 (platform-agents e2e) adds a MINIMAL `/sessions` surface: POST creates
// a session record file (the specs inspect what the web sent — readOnly flag,
// mcpServers, prompts), the SSE stream emits one `session.update` and then
// HOLDS until the spec drops a `<sessionId>.release` marker (or the backstop
// timeout fires), then emits `session.exited` exitCode 0. The hold gives the
// quarantine spec a deterministic window to dirty the repo_read checkout
// BEFORE the terminal choke point runs the dirty-watchdog.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";

export const STUB_SUPERVISOR_PORT = 7788;
export const STUB_SUPERVISOR_URL = `http://127.0.0.1:${STUB_SUPERVISOR_PORT}`;
export const STUB_SESSIONS_DIR = path.resolve("e2e/.runtime/stub-sessions");
// ADR-166 (transitional contract): a fixed execution-host identity so the web
// registrar upserts ONE stable execution_hosts row across every spec.
export const STUB_HOST_KEY = "eh_e2e_stub_supervisor_0001";
export const STUB_BOOT_ID = "0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0";

const RELEASE_BACKSTOP_MS = 15_000;
const RELEASE_POLL_MS = 150;

function readJsonBody(req: import("node:http").IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function sessionFile(sessionId: string): string {
  return path.join(STUB_SESSIONS_DIR, `${sessionId}.json`);
}

// ---- ADR-166 transitional contract (in-memory: fences, receipts, handles) --
// A body is enveloped iff it carries `command` + `fence`; the route's real
// payload is `body.payload`. Fences are per-run epoch high-waters; receipts
// replay a completed command id verbatim; handles are minted by adoption. All
// in-memory — acceptable for the stub (documented in the plan, T2.6).
type StubEnvelope = {
  command: { id: string; kind: string };
  fence: {
    hostKey: string;
    assignmentId: string;
    assignmentEpoch: number;
    runId: string;
  };
  payload: Record<string, unknown>;
};

const fences = new Map<string, { assignmentId: string; epoch: number }>();

// ---- ADR-166 session registry (shared by both e2e supervisors) -------------
// The `GET /sessions` projection of the real host (`SessionListEntry`) plus
// the eviction hook a stream handler installs: when a command with a HIGHER
// epoch arrives for a run, every live lower-epoch session of that run is
// evicted (`session.exited{reason:"fenced"}`) BEFORE the command executes.
export type StubSessionEntry = {
  sessionId: string;
  adapter: string;
  runId: string;
  projectSlug: string;
  stepId: string;
  nodeAttemptId?: string;
  sessionName: string;
  status: "live" | "exited";
  pid: number;
  startedAt: string;
  exitedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  acpSessionId: string;
  executionWorkspaceId?: string;
  assignmentId?: string;
  assignmentEpoch?: number;
  createdByCommandId?: string;
  onEvict?: (hostEpoch: number) => void;
};

export const stubSessions = new Map<string, StubSessionEntry>();

export function stubRegisterSession(
  entry: Omit<StubSessionEntry, "status" | "pid" | "startedAt"> &
    Partial<Pick<StubSessionEntry, "status" | "pid" | "startedAt">>,
): StubSessionEntry {
  const record: StubSessionEntry = {
    status: "live",
    pid: 4242,
    startedAt: new Date().toISOString(),
    ...entry,
  };

  stubSessions.set(record.sessionId, record);

  return record;
}

export function stubExitSession(sessionId: string, exitCode = 0): void {
  const entry = stubSessions.get(sessionId);

  if (!entry || entry.status !== "live") return;
  entry.status = "exited";
  entry.exitedAt = new Date().toISOString();
  entry.exitCode = exitCode;
  entry.onEvict = undefined;
}

// The real `toSessionListEntry`: host-private paths never leave the host.
export function stubSessionListEntry(entry: StubSessionEntry) {
  return {
    sessionId: entry.sessionId,
    adapter: entry.adapter,
    runId: entry.runId,
    projectSlug: entry.projectSlug,
    stepId: entry.stepId,
    nodeAttemptId: entry.nodeAttemptId,
    sessionName: entry.sessionName,
    status: entry.status,
    pid: entry.pid,
    startedAt: entry.startedAt,
    exitedAt: entry.exitedAt,
    exitCode: entry.exitCode,
    signal: entry.signal ?? null,
    monotonicId: 0,
    acpSessionId: entry.acpSessionId,
    executionWorkspaceId: entry.executionWorkspaceId,
    assignmentId: entry.assignmentId,
    assignmentEpoch: entry.assignmentEpoch,
    createdByCommandId: entry.createdByCommandId,
  };
}

export function stubFencedExitEvent(sessionId: string, monotonicId: number) {
  return {
    type: "session.exited",
    sessionId,
    monotonicId,
    exitCode: 143,
    reason: "fenced",
  };
}

function stubEvictLowerEpochSessions(runId: string, epoch: number): void {
  for (const entry of stubSessions.values()) {
    if (entry.runId !== runId || entry.status !== "live") continue;
    if (entry.assignmentEpoch === undefined || entry.assignmentEpoch >= epoch) {
      continue;
    }
    const evict = entry.onEvict;

    stubExitSession(entry.sessionId, 143);
    evict?.(epoch);
  }
}
const receipts = new Map<
  string,
  {
    status: number;
    body: unknown;
    runId: string;
    kind: string;
    epoch: number;
    receivedAt: string;
  }
>();
const handles = new Map<
  string,
  {
    runId: string;
    projectSlug: string;
    kind: string;
    path: string;
    releasedAt: string | null;
    adoptedAt: string;
  }
>();

export function stubEnvelope(body: unknown): StubEnvelope | null {
  const b = body as Partial<StubEnvelope> | null;

  return b &&
    typeof b === "object" &&
    b.command &&
    b.fence &&
    typeof b.command.id === "string"
    ? (b as StubEnvelope)
    : null;
}

export function stubPayload(body: unknown): any {
  const env = stubEnvelope(body);

  return env ? (env.payload ?? {}) : (body ?? {});
}

// Returns an error body when the fence must be refused, else null.
export function stubFence(
  env: StubEnvelope | null,
  expectedRunId?: string,
): { status: number; body: unknown } | null {
  if (!env) return null;
  if (env.fence.hostKey !== STUB_HOST_KEY) {
    return {
      status: 409,
      body: {
        code: "PRECONDITION",
        message: "host mismatch",
        details: { reason: "host_mismatch" },
      },
    };
  }
  if (expectedRunId !== undefined && env.fence.runId !== expectedRunId) {
    return {
      status: 409,
      body: {
        code: "PRECONDITION",
        message: "run mismatch",
        details: { reason: "run_mismatch", runId: env.fence.runId },
      },
    };
  }
  const stored = fences.get(env.fence.runId);

  if (stored && env.fence.assignmentEpoch < stored.epoch) {
    return {
      status: 409,
      body: {
        code: "FENCED",
        message: `command epoch ${env.fence.assignmentEpoch} is below the host high-water ${stored.epoch}`,
        details: {
          reason: "assignment_fenced",
          runId: env.fence.runId,
          commandEpoch: env.fence.assignmentEpoch,
          hostEpoch: stored.epoch,
        },
      },
    };
  }
  if (
    stored &&
    env.fence.assignmentEpoch === stored.epoch &&
    env.fence.assignmentId !== stored.assignmentId
  ) {
    return {
      status: 409,
      body: {
        code: "PRECONDITION",
        message: "assignment mismatch",
        details: { reason: "assignment_mismatch" },
      },
    };
  }
  if (!stored || env.fence.assignmentEpoch > stored.epoch) {
    fences.set(env.fence.runId, {
      assignmentId: env.fence.assignmentId,
      epoch: env.fence.assignmentEpoch,
    });
    // E-EH-04: the advance evicts the run's live lower-epoch sessions.
    stubEvictLowerEpochSessions(env.fence.runId, env.fence.assignmentEpoch);
  }

  return null;
}

export function stubReplay(
  env: StubEnvelope | null,
): { status: number; body: unknown } | null {
  if (!env) return null;

  return receipts.get(env.command.id) ?? null;
}

export function stubRecord(
  env: StubEnvelope | null,
  status: number,
  body: unknown,
): void {
  if (!env) return;
  receipts.set(env.command.id, {
    status,
    body,
    runId: env.fence.runId,
    kind: env.command.kind,
    epoch: env.fence.assignmentEpoch,
    receivedAt: new Date().toISOString(),
  });
}

export function stubReceipt(commandId: string) {
  const r = receipts.get(commandId);

  return r
    ? {
        commandId,
        runId: r.runId,
        kind: r.kind,
        assignmentEpoch: r.epoch,
        phase: "completed",
        httpStatus: r.status,
        body: r.body ?? {},
        receivedAt: r.receivedAt,
        completedAt: r.receivedAt,
        // The stub records receipts after the effect, so nothing is in flight.
        inflight: false,
      }
    : null;
}

export function stubAdopt(payload: any): { status: number; body: unknown } {
  const p = String(payload.path ?? "");

  if (!path.isAbsolute(p)) {
    return {
      status: 409,
      body: {
        code: "PRECONDITION",
        message: "relative path",
        details: { reason: "workspace_rejected", rule: "relative_path" },
      },
    };
  }
  if (!existsSync(p)) {
    return {
      status: 409,
      body: {
        code: "PRECONDITION",
        message: "not found",
        details: { reason: "workspace_rejected", rule: "not_found" },
      },
    };
  }
  for (const [id, h] of handles) {
    if (h.runId === payload.runId && h.path === p && !h.releasedAt) {
      return {
        status: 200,
        body: { executionWorkspaceId: id, kind: h.kind, replayed: true },
      };
    }
  }
  const id = `ws_${randomUUID().replace(/-/g, "")}`;

  handles.set(id, {
    runId: String(payload.runId),
    projectSlug: String(payload.projectSlug),
    kind: String(payload.kind),
    path: p,
    releasedAt: null,
    adoptedAt: new Date().toISOString(),
  });

  return {
    status: 200,
    body: { executionWorkspaceId: id, kind: payload.kind, replayed: false },
  };
}

export function stubHandle(id: string) {
  return handles.get(id) ?? null;
}

export function stubRelease(id: string): boolean {
  const h = handles.get(id);

  if (!h || h.releasedAt) return false;
  h.releasedAt = new Date().toISOString();

  return true;
}

const LEGACY_SESSION_PATH_FIELDS = [
  "runId",
  "projectSlug",
  "worktreePath",
  "repoPath",
  "confineRoot",
  "contextMounts",
];

// Resolve the create request (handle form ONLY — ADR-166 strict) to the fields
// the stub records. A legacy path field is refused by name; an unknown or
// released handle refuses like the real host.
export function stubResolveCreate(
  payload: any,
): { status: number; body: unknown } | { runId: string; request: any } {
  const legacyField = LEGACY_SESSION_PATH_FIELDS.find(
    (field) => payload[field] !== undefined,
  );

  if (legacyField) {
    return {
      status: 409,
      body: {
        code: "PRECONDITION",
        message: `${legacyField} is a legacy path field; adopt the workspace and send executionWorkspaceId`,
        details: { reason: "legacy_field", field: legacyField },
      },
    };
  }

  if (typeof payload.executionWorkspaceId === "string") {
    const h = handles.get(payload.executionWorkspaceId);

    if (!h)
      return {
        status: 409,
        body: {
          code: "PRECONDITION",
          message: "unknown execution workspace",
          details: { reason: "unknown_workspace" },
        },
      };
    if (h.releasedAt)
      return {
        status: 409,
        body: {
          code: "PRECONDITION",
          message: "released",
          details: { reason: "workspace_released", runId: h.runId },
        },
      };

    return {
      runId: h.runId,
      request: {
        ...payload,
        runId: h.runId,
        projectSlug: h.projectSlug,
        worktreePath: h.path,
      },
    };
  }

  return {
    status: 409,
    body: {
      code: "PRECONDITION",
      message: "executionWorkspaceId: Required",
    },
  };
}

export const MISSING_ENVELOPE_BODY = {
  code: "PRECONDITION",
  message: "missing envelope",
  details: { reason: "missing_envelope" },
};

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  replayed = false,
): void {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (replayed) headers["x-maister-command-replayed"] = "true";
  res.writeHead(status, headers);
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

export function startStubSupervisor(): Promise<Server> {
  mkdirSync(STUB_SESSIONS_DIR, { recursive: true });

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const body = JSON.stringify({
        status: "ready",
        host: {
          hostKey: STUB_HOST_KEY,
          bootId: STUB_BOOT_ID,
          protocolVersion: 1,
        },
        version: "e2e-stub",
        uptimeMs: 0,
        checkedAt: new Date().toISOString(),
        sessions: { live: 0, exited: 0, crashed: 0 },
      });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);

      return;
    }

    if (req.method === "GET" && req.url === "/diagnostics") {
      const body = JSON.stringify({
        status: "ready",
        version: "e2e-stub",
        checkedAt: new Date().toISOString(),
        adapters: [
          {
            id: "claude",
            binary: "claude-agent-acp",
            available: true,
          },
          {
            id: "codex",
            binary: "codex-acp",
            available: true,
          },
        ],
        envRefs: [{ name: "ZAI_API_KEY", present: false }],
      });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);

      return;
    }

    if (req.method === "POST" && req.url === "/model-catalog/resolve") {
      // ADR-076 model discovery (T5.2): return a fixed flat catalog the web
      // admin proxy groups by source for the runner-modal combobox.
      const body = JSON.stringify({
        models: [
          { id: "glm-5.1", displayName: "GLM-5.1", origins: ["acp_probe"] },
          { id: "glm-5", displayName: "GLM-5", origins: ["curated"] },
        ],
        sources: [
          { kind: "acp_probe", status: "ok", count: 1 },
          { kind: "curated", status: "ok", count: 1 },
        ],
        resolvedAt: new Date().toISOString(),
        ttlSeconds: 3600,
      });

      req.resume(); // drain the request body
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);

      return;
    }

    // ---- ADR-166 workspace adoption + receipts (transitional) ---------------
    if (req.method === "POST" && req.url === "/workspaces/adopt") {
      void readJsonBody(req).then((body) => {
        const env = stubEnvelope(body);

        if (!env) {
          sendJson(res, 409, {
            code: "PRECONDITION",
            message: "missing envelope",
            details: { reason: "missing_envelope" },
          });

          return;
        }
        const replay = stubReplay(env);

        if (replay) {
          sendJson(res, replay.status, replay.body, true);

          return;
        }
        const refused = stubFence(env, String(env.payload.runId ?? ""));

        if (refused) {
          stubRecord(env, refused.status, refused.body);
          sendJson(res, refused.status, refused.body);

          return;
        }
        const outcome = stubAdopt(env.payload);

        stubRecord(env, outcome.status, outcome.body);
        sendJson(res, outcome.status, outcome.body);
      });

      return;
    }

    const workspaceMatch = req.url?.match(/^\/workspaces\/(ws_[0-9a-f]{32})$/);

    if (req.method === "GET" && workspaceMatch) {
      const h = stubHandle(workspaceMatch[1]);

      if (!h) {
        sendJson(res, 404, {
          code: "PRECONDITION",
          message: "unknown execution workspace",
          details: { reason: "unknown_workspace" },
        });

        return;
      }
      sendJson(res, 200, {
        executionWorkspaceId: workspaceMatch[1],
        runId: h.runId,
        projectSlug: h.projectSlug,
        kind: h.kind,
        adoptedAt: h.adoptedAt,
        releasedAt: h.releasedAt,
      });

      return;
    }

    if (req.method === "DELETE" && workspaceMatch) {
      void readJsonBody(req).then((body) => {
        const h = stubHandle(workspaceMatch[1]);

        if (!h) {
          sendJson(res, 404, {
            code: "PRECONDITION",
            message: "unknown execution workspace",
            details: { reason: "unknown_workspace" },
          });

          return;
        }
        const env = stubEnvelope(body);
        const replay = stubReplay(env);

        if (replay) {
          sendJson(res, replay.status, replay.body, true);

          return;
        }
        const refused = stubFence(env, h.runId);

        if (refused) {
          stubRecord(env, refused.status, refused.body);
          sendJson(res, refused.status, refused.body);

          return;
        }
        const outcome = { released: stubRelease(workspaceMatch[1]) };

        stubRecord(env, 200, outcome);
        sendJson(res, 200, outcome);
      });

      return;
    }

    const commandMatch = req.url?.match(/^\/commands\/([0-9a-f-]+)$/);

    if (req.method === "GET" && commandMatch) {
      const receipt = stubReceipt(commandMatch[1]);

      if (!receipt) {
        sendJson(res, 404, {
          code: "PRECONDITION",
          message: "unknown command",
        });

        return;
      }
      sendJson(res, 200, receipt);

      return;
    }

    // ---- M34 minimal /sessions surface (platform-agents e2e) --------------
    if (req.method === "POST" && req.url === "/sessions") {
      void readJsonBody(req).then((body) => {
        const env = stubEnvelope(body);

        if (!env) {
          sendJson(res, 409, MISSING_ENVELOPE_BODY);

          return;
        }
        const replay = stubReplay(env);

        if (replay) {
          sendJson(res, replay.status, replay.body, true);

          return;
        }
        const resolved = stubResolveCreate(stubPayload(body));

        if ("status" in resolved) {
          stubRecord(env, resolved.status, resolved.body);
          sendJson(res, resolved.status, resolved.body);

          return;
        }
        const refused = stubFence(env, resolved.runId);

        if (refused) {
          stubRecord(env, refused.status, refused.body);
          sendJson(res, refused.status, refused.body);

          return;
        }
        const sessionId = randomUUID();
        const acpSessionId = randomUUID();
        const request = resolved.request as Record<string, unknown>;

        writeFileSync(
          sessionFile(sessionId),
          JSON.stringify(
            { sessionId, acpSessionId, request: resolved.request, prompts: [] },
            null,
            2,
          ),
        );
        stubRegisterSession({
          sessionId,
          adapter: String(
            (request.runner as { adapter?: string } | undefined)?.adapter ??
              (request.executor as { agent?: string } | undefined)?.agent ??
              "claude",
          ),
          runId: resolved.runId,
          projectSlug: String(request.projectSlug ?? "e2e"),
          stepId: String(request.stepId ?? "step"),
          nodeAttemptId:
            typeof request.nodeAttemptId === "string"
              ? request.nodeAttemptId
              : undefined,
          sessionName: String(request.sessionName ?? "default"),
          acpSessionId,
          executionWorkspaceId:
            typeof request.executionWorkspaceId === "string"
              ? request.executionWorkspaceId
              : undefined,
          assignmentId: env.fence.assignmentId,
          assignmentEpoch: env.fence.assignmentEpoch,
          createdByCommandId: env.command.id,
        });
        const out = { sessionId, pid: 4242, acpSessionId };

        stubRecord(env, 201, out);
        sendJson(res, 201, out);
      });

      return;
    }

    if (req.method === "GET" && req.url === "/sessions") {
      sendJson(res, 200, [...stubSessions.values()].map(stubSessionListEntry));

      return;
    }

    const promptMatch = req.url?.match(/^\/sessions\/([0-9a-f-]+)\/prompt$/);

    if (req.method === "POST" && promptMatch) {
      const file = sessionFile(promptMatch[1]);

      void readJsonBody(req).then((body) => {
        const env = stubEnvelope(body);
        const replay = stubReplay(env);

        if (replay) {
          sendJson(res, replay.status, replay.body, true);

          return;
        }
        const refused = stubFence(env);

        if (refused) {
          stubRecord(env, refused.status, refused.body);
          sendJson(res, refused.status, refused.body);

          return;
        }
        try {
          const record = JSON.parse(readFileSync(file, "utf8"));

          record.prompts.push(stubPayload(body));
          writeFileSync(file, JSON.stringify(record, null, 2));
        } catch {
          // Unknown session — still answer; the spec asserts on the files.
        }
        const out = { stopReason: "end_turn" };

        stubRecord(env, 200, out);
        sendJson(res, 200, out);
      });

      return;
    }

    const teardownMatch = req.url?.match(
      /^\/sessions\/([0-9a-f-]+)\/(checkpoint|cancel|input)$/,
    );

    if (req.method === "POST" && teardownMatch) {
      void readJsonBody(req).then((body) => {
        const env = stubEnvelope(body);
        const replay = stubReplay(env);

        if (replay) {
          sendJson(res, replay.status, replay.body, true);

          return;
        }
        const refused = stubFence(env);

        if (refused) {
          stubRecord(env, refused.status, refused.body);
          sendJson(res, refused.status, refused.body);

          return;
        }
        const kind = teardownMatch[2];
        const out =
          kind === "checkpoint"
            ? {
                alreadyCheckpointed:
                  stubSessions.get(teardownMatch[1])?.status === "exited",
                sessionId: teardownMatch[1],
                monotonicId: 2,
              }
            : kind === "cancel"
              ? { cancelled: true, sessionId: teardownMatch[1] }
              : { ok: true };

        if (kind === "checkpoint") stubExitSession(teardownMatch[1]);
        stubRecord(env, 200, out);
        sendJson(res, 200, out);
      });

      return;
    }

    const streamMatch = req.url?.match(/^\/sessions\/([0-9a-f-]+)\/stream$/);

    if (req.method === "GET" && streamMatch) {
      const sessionId = streamMatch[1];
      const releasePath = path.join(STUB_SESSIONS_DIR, `${sessionId}.release`);

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(
        `data: ${JSON.stringify({
          type: "session.update",
          sessionId,
          monotonicId: 1,
          update: { kind: "stub" },
        })}\n\n`,
      );

      const startedAt = Date.now();
      const entry = stubSessions.get(sessionId);
      const timer = setInterval(() => {
        const released = existsSync(releasePath);
        const expired = Date.now() - startedAt > RELEASE_BACKSTOP_MS;

        if (!released && !expired) return;

        clearInterval(timer);
        stubExitSession(sessionId);
        res.write(
          `data: ${JSON.stringify({
            type: "session.exited",
            sessionId,
            monotonicId: 2,
            exitCode: 0,
          })}\n\n`,
        );
        res.end();
      }, RELEASE_POLL_MS);

      // A higher-epoch command for the run evicts this session: its stream
      // ends with the fenced exit instead of the release.
      if (entry) {
        entry.onEvict = () => {
          clearInterval(timer);
          res.write(
            `data: ${JSON.stringify(stubFencedExitEvent(sessionId, 2))}\n\n`,
          );
          res.end();
        };
      }

      req.on("close", () => {
        clearInterval(timer);
        if (entry?.onEvict) entry.onEvict = undefined;
      });

      return;
    }

    const deleteMatch = req.url?.match(/^\/sessions\/([0-9a-f-]+)$/);

    if (req.method === "DELETE" && deleteMatch) {
      void readJsonBody(req).then((body) => {
        const env = stubEnvelope(body);
        const replay = stubReplay(env);

        if (replay) {
          sendJson(res, replay.status, replay.body, true);

          return;
        }
        const refused = stubFence(env);

        if (refused) {
          stubRecord(env, refused.status, refused.body);
          sendJson(res, refused.status, refused.body);

          return;
        }
        stubExitSession(deleteMatch[1]);
        stubRecord(env, 204, {});
        res.writeHead(204);
        res.end();
      });

      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ code: "PRECONDITION", message: "not implemented" }),
    );
  });

  // The M34 session surface multiplies the request volume against this stub
  // (createSession/prompt/stream/delete per agent run). Node's default 5s
  // keepAliveTimeout then races undici's socket reuse — an idle socket can
  // close exactly as the web reuses it, failing 1s-budget calls like
  // checkSupervisorDiagnostics with a spurious network error. Never reap
  // idle sockets in this bounded test process.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(STUB_SUPERVISOR_PORT, "127.0.0.1", () => {
      console.log(
        `stub-supervisor: /health listening on ${STUB_SUPERVISOR_URL}`,
      );
      resolve(server);
    });
  });
}
