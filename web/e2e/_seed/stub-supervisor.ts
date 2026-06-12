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
// M33 (platform-agents e2e) adds a MINIMAL `/sessions` surface: POST creates
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

export function startStubSupervisor(): Promise<Server> {
  mkdirSync(STUB_SESSIONS_DIR, { recursive: true });

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const body = JSON.stringify({
        status: "ready",
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
        sidecars: [{ id: "ccr-default", kind: "ccr", state: "ready" }],
        envRefs: [
          { name: "MAISTER_CCR_AUTH_TOKEN", present: true },
          { name: "ZAI_API_KEY", present: false },
        ],
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

    // ---- M33 minimal /sessions surface (platform-agents e2e) --------------
    if (req.method === "POST" && req.url === "/sessions") {
      void readJsonBody(req).then((body) => {
        const sessionId = randomUUID();
        const acpSessionId = randomUUID();

        writeFileSync(
          sessionFile(sessionId),
          JSON.stringify(
            { sessionId, acpSessionId, request: body, prompts: [] },
            null,
            2,
          ),
        );
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ sessionId, pid: 4242, acpSessionId }));
      });

      return;
    }

    const promptMatch = req.url?.match(/^\/sessions\/([0-9a-f-]+)\/prompt$/);

    if (req.method === "POST" && promptMatch) {
      const file = sessionFile(promptMatch[1]);

      void readJsonBody(req).then((body) => {
        try {
          const record = JSON.parse(readFileSync(file, "utf8"));

          record.prompts.push(body);
          writeFileSync(file, JSON.stringify(record, null, 2));
        } catch {
          // Unknown session — still answer; the spec asserts on the files.
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ stopReason: "end_turn" }));
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
      const timer = setInterval(() => {
        const released = existsSync(releasePath);
        const expired = Date.now() - startedAt > RELEASE_BACKSTOP_MS;

        if (!released && !expired) return;

        clearInterval(timer);
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

      req.on("close", () => clearInterval(timer));

      return;
    }

    const deleteMatch = req.url?.match(/^\/sessions\/([0-9a-f-]+)$/);

    if (req.method === "DELETE" && deleteMatch) {
      res.writeHead(204);
      res.end();

      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ code: "PRECONDITION", message: "not implemented" }),
    );
  });

  // The M33 session surface multiplies the request volume against this stub
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
