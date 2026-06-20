/* eslint-disable no-console */
// M36 (ADR-095) — a REAL HTTP test supervisor that drives the orchestrator
// engine's full delegate→park→resume→complete loop through the REAL
// supervisor-client HTTP wire (lib/supervisor-client.ts). Unlike the unit
// integration tests that mock the supervisor seam, this server is hit over
// HTTP+SSE exactly as the production supervisor is, so the real
// supervisor-client serializer + the real SSE frame parser + the real
// runner/launch session consumers all execute.
//
// It SIMULATES the agent IN-PROCESS — no adapter subprocess, no ACP stdio:
//   • run_kind='flow' (an orchestrator node session), turn 0 (no resume): it
//     reads the maister facade token from the createSession `mcpServers`
//     payload and spawns N children (default 2) by invoking the SAME
//     delegation surface the agent's MCP facade would (the ext
//     /api/v1/ext/runs/delegate route, mode:"run"). It then emits
//     `session.exited {exitCode:0}` — the clean end_turn the graph runner
//     reads (with pending children → park on WaitingOnChildren).
//   • run_kind='flow' resume turn (createSession carried `resumeSessionId`):
//     the goal is met, so it emits `session.exited {exitCode:0}` immediately
//     with no new children → the orchestrator node completes → flow terminal.
//   • run_kind='agent' (a delegated CHILD): it emits `session.exited
//     {exitCode:0}` immediately → consumeAgentSession finalizes the child to
//     Done (workspace=none) → run.done domain event with parent_run_id set.
//
// run_kind is looked up by the createSession `runId` against the pg pool the
// caller wires in. A monotonic counter feeds the SSE `id:` + each event's
// `monotonicId`.
//
// It is a SUPERSET of stub-supervisor.ts: /health, /diagnostics,
// /model-catalog/resolve and the CCR sidecar echoes all answer the same ready
// shapes, so an e2e suite can point MAISTER_SUPERVISOR_URL at this server for
// EVERY spec without breaking the ones that never spawn an agent.
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import type { AgentMcpServer } from "@/lib/capabilities/agent-map";

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import path from "node:path";

const STUB_RELEASE_BACKSTOP_MS = 15_000;
const STUB_RELEASE_POLL_MS = 150;

// ---- the delegation hook (the node-test vs browser-e2e substitution) --------
//
// In the BROWSER e2e the agent's MCP facade would POST the ext delegate route
// over HTTP; Next IS served there, so the default hook does exactly that
// (real route, real auth, real launchAgentRun). In the NODE loop test the ext
// route is NOT served (vitest has no Next server), so the test injects a hook
// that invokes the delegation SERVICE the route calls directly (launchAgentRun
// with the parent/root linkage looked up from the DB). Either way the
// supervisor-client HTTP wire above stays REAL.
export type DelegateRequest = {
  // The orchestrator run whose session is spawning children.
  orchestratorRunId: string;
  // The maister facade token read from the createSession mcpServers payload.
  facadeToken: string | null;
  // The facade base URL read from the same payload (browser hook targets it).
  apiBaseUrl: string | null;
  // 0-based child index (a sub-task ordinal).
  index: number;
  prompt: string;
};

export type DelegateHook = (req: DelegateRequest) => Promise<void>;

type SessionRecord = {
  sessionId: string;
  acpSessionId: string;
  runId: string;
  runKind: "flow" | "scratch" | "agent" | "unknown";
  isResume: boolean;
  mcpServers: AgentMcpServer[];
  // Set once the agent's turn is decided complete (on sendPrompt). The stream
  // handler flushes it as a `session.exited` frame the moment it is connected;
  // queuing here decouples the prompt POST from the stream GET race.
  exitPending: boolean;
  exitCode: number;
  detached: boolean;
  // stub-compat: this session uses the hold-until-`.release` stream path
  // (a non-orchestrator run when stubCompat is enabled), not the auto-drive.
  stub: boolean;
  // The live SSE writer, set while a stream is connected.
  emit: ((event: Record<string, unknown>) => void) | null;
};

export interface TestSupervisorOptions {
  // The pg pool used to look up runs.run_kind by the createSession runId.
  pool: Pool;
  // How many children each orchestrator turn-0 spawns. Default 2.
  childCount?: number;
  // The delegation hook (see DelegateHook). Default = HTTP POST to the ext
  // delegate route at the facade base URL (browser-e2e mode).
  delegate?: DelegateHook;
  // Optional: a fixed prompt per child (default "sub-task <n>").
  childPrompt?: (index: number) => string;
  // Optional: bind a fixed port (the browser e2e pins a stable URL). Default 0
  // (an ephemeral port the node loop test reads back from the handle).
  portHint?: number;
  // Optional: stub-supervisor compatibility for the BROWSER e2e. When set, a
  // non-orchestrator session (run_kind != "flow" — e.g. a platform-agents
  // `agent` run) behaves EXACTLY like e2e/_seed/stub-supervisor.ts: it writes a
  // `<sessionId>.json` record (the platform-agents spec inspects readOnlySession
  // + prompts) and its SSE stream HOLDS until the spec drops a
  // `<sessionId>.release` marker (or the backstop fires), then emits
  // session.exited{0}. Only orchestrator FLOW sessions drive the delegate→park
  // loop. Unset (the node loop test) ⇒ every session auto-drives by run_kind.
  stubCompat?: { sessionsDir: string };
}

export interface TestSupervisorHandle {
  server: Server;
  port: number;
  url: string;
  // Diagnostics for assertions: every createSession the web sent, in order.
  createdSessions: () => ReadonlyArray<{
    runId: string;
    runKind: string;
    isResume: boolean;
    mcpServers: AgentMcpServer[];
  }>;
  // Children the supervisor's orchestrator turn requested to spawn, in order.
  delegations: () => ReadonlyArray<DelegateRequest>;
  stop: () => Promise<void>;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
  });
}

// Pull the maister facade token + base url out of the createSession mcpServers
// payload, exactly where agentFacadeMcpServer (lib/agents/launch.ts) puts them.
function readFacade(mcpServers: AgentMcpServer[]): {
  token: string | null;
  apiBaseUrl: string | null;
} {
  const maister = mcpServers.find((s) => s.name === "maister");
  const env = (maister as { env?: Record<string, string> } | undefined)?.env;

  return {
    token: env?.MAISTER_PROJECT_TOKEN ?? null,
    apiBaseUrl: env?.MAISTER_API_BASE_URL ?? null,
  };
}

// Default delegation hook (browser-e2e): the agent's facade would POST the ext
// delegate route; replicate that over real HTTP. A non-2xx throws so the test
// supervisor surfaces it as a crash (loud failure).
const httpDelegateHook: DelegateHook = async (req) => {
  if (!req.facadeToken || !req.apiBaseUrl) {
    throw new Error(
      `test-supervisor: orchestrator session missing facade token/baseUrl ` +
        `(token=${!!req.facadeToken}, baseUrl=${req.apiBaseUrl})`,
    );
  }
  const res = await fetch(`${req.apiBaseUrl}/api/v1/ext/runs/delegate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${req.facadeToken}`,
    },
    body: JSON.stringify({
      target: { agentId: process.env.MAISTER_TEST_CHILD_AGENT_ID },
      mode: "run",
      prompt: req.prompt,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<no body>");

    throw new Error(
      `test-supervisor: delegate route returned ${res.status}: ${text}`,
    );
  }
};

export async function startTestSupervisor(
  opts: TestSupervisorOptions,
): Promise<TestSupervisorHandle> {
  const childCount = opts.childCount ?? 2;
  const delegate = opts.delegate ?? httpDelegateHook;
  const childPrompt = opts.childPrompt ?? ((i: number) => `sub-task ${i}`);

  const sessions = new Map<string, SessionRecord>();
  const created: Array<{
    runId: string;
    runKind: string;
    isResume: boolean;
    mcpServers: AgentMcpServer[];
  }> = [];
  const delegations: DelegateRequest[] = [];
  let monotonic = 0;

  const nextId = (): number => {
    monotonic += 1;

    return monotonic;
  };

  // Flush a queued clean exit onto a connected stream (idempotent).
  const flushExit = (rec: SessionRecord): void => {
    if (!rec.exitPending || !rec.emit) return;
    rec.exitPending = false;
    rec.emit({
      type: "session.exited",
      sessionId: rec.sessionId,
      monotonicId: nextId(),
      exitCode: rec.exitCode,
    });
  };

  async function lookupRunKind(
    runId: string,
  ): Promise<SessionRecord["runKind"]> {
    const r = await opts.pool.query(
      `SELECT "run_kind" FROM "runs" WHERE "id" = $1`,
      [runId],
    );
    const kind = r.rows[0]?.run_kind as string | undefined;

    if (kind === "flow" || kind === "scratch" || kind === "agent") return kind;

    return "unknown";
  }

  // --- stub-supervisor compatibility (browser e2e) ----------------------------
  // Mirror e2e/_seed/stub-supervisor.ts for non-orchestrator sessions: write a
  // `<sessionId>.json` record (readOnly flag + prompts) and hold the stream
  // until `<sessionId>.release` (or the backstop), then session.exited{0}.
  const stubFile = (sessionId: string): string =>
    path.join(opts.stubCompat!.sessionsDir, `${sessionId}.json`);

  const stubWriteRecord = (
    sessionId: string,
    acpSessionId: string,
    request: Record<string, unknown>,
  ): void => {
    if (!opts.stubCompat) return;
    mkdirSync(opts.stubCompat.sessionsDir, { recursive: true });
    writeFileSync(
      stubFile(sessionId),
      JSON.stringify(
        { sessionId, acpSessionId, request, prompts: [] },
        null,
        2,
      ),
    );
  };

  const stubAppendPrompt = (
    sessionId: string,
    body: Record<string, unknown>,
  ): void => {
    if (!opts.stubCompat) return;
    try {
      const record = JSON.parse(readFileSync(stubFile(sessionId), "utf8"));

      record.prompts.push(body);
      writeFileSync(stubFile(sessionId), JSON.stringify(record, null, 2));
    } catch {
      // Unknown session — the spec asserts on the file, still answers.
    }
  };

  const stubHoldStream = (
    rec: SessionRecord,
    res: import("node:http").ServerResponse,
  ): void => {
    const releasePath = path.join(
      opts.stubCompat!.sessionsDir,
      `${rec.sessionId}.release`,
    );
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const released = existsSync(releasePath);
      const expired = Date.now() - startedAt > STUB_RELEASE_BACKSTOP_MS;

      if (!released && !expired) return;
      clearInterval(timer);
      res.write(
        `data: ${JSON.stringify({
          type: "session.exited",
          sessionId: rec.sessionId,
          monotonicId: nextId(),
          exitCode: 0,
        })}\n\n`,
      );
      res.end();
    }, STUB_RELEASE_POLL_MS);

    res.on("close", () => clearInterval(timer));
  };

  // Decide + run the agent's turn for a session. Called on sendPrompt. For an
  // orchestrator turn 0 it spawns children first (awaited) so countPendingChildren
  // sees them when the runner makes the park decision after the prompt returns.
  async function driveTurn(rec: SessionRecord): Promise<void> {
    if (rec.runKind === "flow" && !rec.isResume) {
      const { token, apiBaseUrl } = readFacade(rec.mcpServers);

      for (let i = 0; i < childCount; i += 1) {
        const req: DelegateRequest = {
          orchestratorRunId: rec.runId,
          facadeToken: token,
          apiBaseUrl,
          index: i,
          prompt: childPrompt(i),
        };

        delegations.push(req);
        await delegate(req);
      }
    }
    // Every turn (orchestrator turn-0, orchestrator resume, child) ends with a
    // clean end_turn. Queue it; the stream flushes when connected.
    rec.exitPending = true;
    rec.exitCode = 0;
    flushExit(rec);
  }

  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "GET";

    // ---- stub-supervisor superset: readiness surfaces --------------------
    if (method === "GET" && url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ready",
          version: "e2e-test-supervisor",
          uptimeMs: 0,
          checkedAt: new Date().toISOString(),
          sessions: { live: 0, exited: 0, crashed: 0 },
        }),
      );

      return;
    }

    if (method === "GET" && url === "/diagnostics") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ready",
          version: "e2e-test-supervisor",
          checkedAt: new Date().toISOString(),
          adapters: [
            { id: "claude", binary: "claude-agent-acp", available: true },
            { id: "codex", binary: "codex-acp", available: true },
          ],
          sidecars: [{ id: "ccr-default", kind: "ccr", state: "ready" }],
          envRefs: [
            { name: "MAISTER_CCR_AUTH_TOKEN", present: true },
            { name: "ZAI_API_KEY", present: false },
          ],
        }),
      );

      return;
    }

    if (method === "POST" && url === "/model-catalog/resolve") {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
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
        }),
      );

      return;
    }

    const sidecarStart = url.match(/^\/sidecars\/([A-Za-z0-9._-]+)\/start$/);

    if (method === "POST" && sidecarStart) {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, state: "ready" }));

      return;
    }

    const sidecarStop = url.match(/^\/sidecars\/([A-Za-z0-9._-]+)\/stop$/);

    if (method === "POST" && sidecarStop) {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, state: "idle" }));

      return;
    }

    // ---- GET /sessions — reconcile/keepalive/parkOrchestratorSession view --
    if (method === "GET" && url === "/sessions") {
      const records = [...sessions.values()]
        .filter((s) => !s.detached)
        .map((s) => ({
          sessionId: s.sessionId,
          runId: s.runId,
          projectSlug: "test",
          stepId: "coordinate",
          status: "live" as const,
          pid: 4242,
          startedAt: new Date().toISOString(),
          logPath: "/tmp/x.log",
          monotonicId: monotonic,
          acpSessionId: s.acpSessionId,
        }));

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(records));

      return;
    }

    // ---- POST /sessions — create + run_kind lookup -----------------------
    if (method === "POST" && url === "/sessions") {
      void readJsonBody(req).then(async (body) => {
        const sessionId = randomUUID();
        const acpSessionId = (body.resumeSessionId as string) || randomUUID();
        const runId = String(body.runId ?? "");
        const mcpServers = (body.mcpServers as AgentMcpServer[]) ?? [];
        const runKind = await lookupRunKind(runId);

        // stub-compat path for non-orchestrator sessions (e.g. a platform-agents
        // `agent` run); orchestrator FLOW sessions always auto-drive.
        const stub = !!opts.stubCompat && runKind !== "flow";

        const rec: SessionRecord = {
          sessionId,
          acpSessionId,
          runId,
          runKind,
          isResume: typeof body.resumeSessionId === "string",
          mcpServers,
          exitPending: false,
          exitCode: 0,
          detached: false,
          stub,
          emit: null,
        };

        sessions.set(sessionId, rec);
        created.push({
          runId,
          runKind,
          isResume: rec.isResume,
          mcpServers,
        });
        if (stub) stubWriteRecord(sessionId, acpSessionId, body);

        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId, pid: 4242, acpSessionId }));
      });

      return;
    }

    const promptMatch = url.match(/^\/sessions\/([0-9a-f-]+)\/prompt$/);

    if (method === "POST" && promptMatch) {
      const rec = sessions.get(promptMatch[1]);

      void readJsonBody(req).then(async (body) => {
        // stub-compat: record the prompt; the stream stays held until release
        // (do NOT auto-drive — the spec controls termination).
        if (rec?.stub) {
          stubAppendPrompt(promptMatch[1], body);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ stopReason: "end_turn" }));

          return;
        }
        // Drive the agent's turn (spawn children for orchestrator turn-0, then
        // queue the clean exit). Errors surface as a crash on the stream.
        if (rec) {
          try {
            await driveTurn(rec);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            console.error(`test-supervisor: turn failed: ${message}`);
            rec.exitPending = false;
            if (rec.emit) {
              rec.emit({
                type: "session.crashed",
                sessionId: rec.sessionId,
                monotonicId: nextId(),
                exitCode: 1,
                signal: null,
              });
            }
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ stopReason: "end_turn" }));
      });

      return;
    }

    const streamMatch = url.match(/^\/sessions\/([0-9a-f-]+)\/stream$/);

    if (method === "GET" && streamMatch) {
      const rec = sessions.get(streamMatch[1]);

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      if (!rec) {
        res.end();

        return;
      }

      // stub-compat: emit one update, then HOLD until `<sessionId>.release`.
      if (rec.stub) {
        res.write(
          `data: ${JSON.stringify({
            type: "session.update",
            sessionId: rec.sessionId,
            monotonicId: nextId(),
            update: { kind: "stub" },
          })}\n\n`,
        );
        stubHoldStream(rec, res);

        return;
      }

      rec.emit = (event: Record<string, unknown>) => {
        res.write(`id: ${event.monotonicId}\n`);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (
          event.type === "session.exited" ||
          event.type === "session.crashed"
        ) {
          rec.emit = null;
          res.end();
        }
      };
      // A child run's stream may connect AFTER its prompt already queued the
      // exit (consumeAgentSession starts the stream in a microtask, then awaits
      // sendPrompt) — flush any pending exit now.
      flushExit(rec);

      req.on("close", () => {
        if (rec.emit) rec.emit = null;
      });

      return;
    }

    // ---- POST /sessions/:id/checkpoint — park detach ---------------------
    const checkpointMatch = url.match(/^\/sessions\/([0-9a-f-]+)\/checkpoint$/);

    if (method === "POST" && checkpointMatch) {
      const rec = sessions.get(checkpointMatch[1]);

      req.resume();
      if (rec) rec.detached = true;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          alreadyCheckpointed: false,
          sessionId: checkpointMatch[1],
          monotonicId: nextId(),
        }),
      );

      return;
    }

    // ---- POST /sessions/:id/input — permission delivery (unused here) ----
    const inputMatch = url.match(/^\/sessions\/([0-9a-f-]+)\/input$/);

    if (method === "POST" && inputMatch) {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      return;
    }

    // ---- DELETE /sessions/:id --------------------------------------------
    const deleteMatch = url.match(/^\/sessions\/([0-9a-f-]+)$/);

    if (method === "DELETE" && deleteMatch) {
      const rec = sessions.get(deleteMatch[1]);

      if (rec) {
        if (rec.emit) rec.emit = null;
        sessions.delete(deleteMatch[1]);
      }
      res.writeHead(204);
      res.end();

      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ code: "PRECONDITION", message: "not implemented" }),
    );
  });

  // Never reap idle sockets in a bounded test process (mirrors stub-supervisor:
  // undici socket reuse races Node's 5s keepAliveTimeout otherwise).
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.portHint ?? 0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  const serverUrl = `http://127.0.0.1:${port}`;

  console.log(`test-supervisor: listening on ${serverUrl}`);

  return {
    server,
    port,
    url: serverUrl,
    createdSessions: () => created,
    delegations: () => delegations,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
