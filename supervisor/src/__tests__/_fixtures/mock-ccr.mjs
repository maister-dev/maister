#!/usr/bin/env node
import http from "node:http";

const portRaw = process.env.MAISTER_MOCK_CCR_PORT;

if (!portRaw) {
  console.error("MAISTER_MOCK_CCR_PORT is required");
  process.exit(2);
}
const port = Number.parseInt(portRaw, 10);

if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  console.error("MAISTER_MOCK_CCR_PORT must be a valid TCP port");
  process.exit(2);
}

const server = http.createServer((req, res) => {
  // Mirror CCR's surface: /health returns 200 (used by the supervisor's
  // identity-validating readiness probe). Other paths still return 200
  // for backwards-compat with earlier tests.
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, service: "mock-ccr", path: req.url ?? "/" }));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`listening on ${port}\n`);
});

function shutdown(signal) {
  process.stdout.write(`received ${signal}\n`);
  server.close(() => {
    process.exit(0);
  });
  // safety net
  setTimeout(() => process.exit(0), 1_000).unref();
}

const ignoreSigterm = process.argv.includes("--ignore-sigterm");

if (ignoreSigterm) {
  // Traps SIGTERM and does NOT exit — drives the SIGKILL escalation path
  // in supervisor/src/ccr-manager.ts shutdown().
  process.on("SIGTERM", () => {
    process.stdout.write(`ignored SIGTERM\n`);
  });
} else {
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
process.on("SIGINT", () => shutdown("SIGINT"));
