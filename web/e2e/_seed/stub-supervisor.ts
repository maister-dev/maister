/* eslint-disable no-console */
// Minimal stub supervisor used by the e2e suite. It answers ONLY `GET /health`
// with the exact shape `SupervisorHealthSchema` (lib/supervisor-client.ts)
// accepts, so `checkSupervisorHealth()` resolves `{ kind: "ready" }` for the
// app under test.
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
