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
// It deliberately implements NOTHING else. The m11a/m11b specs never spawn an
// agent during their assertions (m11a only posts a HITL decision; m11b's resume
// path is a local `check` + a human node), so a reachable `/health` that lacks
// `/sessions` does not change their behavior — it only flips a UI banner and
// lets the settings-enforcement gate be the thing that refuses.
import { createServer, type Server } from "node:http";

export const STUB_SUPERVISOR_PORT = 7788;
export const STUB_SUPERVISOR_URL = `http://127.0.0.1:${STUB_SUPERVISOR_PORT}`;

export function startStubSupervisor(): Promise<Server> {
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

    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ code: "PRECONDITION", message: "not implemented" }),
    );
  });

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
