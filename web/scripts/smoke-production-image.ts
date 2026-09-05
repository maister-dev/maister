import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { startMainAndBrainPostgresTestDb } from "../test-support/pg-container";

const execute = promisify(execFile);
const image = process.argv[2];

assert(image, "usage: smoke-production-image.ts IMAGE");
const database = await startMainAndBrainPostgresTestDb({
  databaseName: "production_shutdown",
});
let containerId: string | undefined;

async function docker(args: string[]): Promise<string> {
  return (
    await execute("docker", args, {
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout.trim();
}

try {
  const databaseUrl = new URL(database.databaseUrl);

  databaseUrl.hostname = "127.0.0.1";
  databaseUrl.port = "5432";
  containerId = (
    await execute(
      "docker",
      [
        "create",
        "--network",
        `container:${database.container.getId()}`,
        "--env",
        "DB_URL",
        "--env",
        "MAISTER_DEFAULT_PACKAGE_SOURCES=",
        "--env",
        "AUTH_SECRET=image-smoke-only",
        "--env",
        "AUTH_TRUST_HOST=true",
        image,
      ],
      { env: { ...process.env, DB_URL: databaseUrl.toString() } },
    )
  ).stdout.trim();
  await docker(["start", containerId]);
  const bootDeadline = Date.now() + 60_000;
  let ready = false;

  while (Date.now() < bootDeadline) {
    const output = await docker(["logs", containerId]);

    if (output.includes('"msg":"web-listening"')) {
      ready = true;
      break;
    }
    const running = await docker([
      "inspect",
      "--format",
      "{{.State.Running}}",
      containerId,
    ]);

    assert.equal(running, "true", `production web failed to boot: ${output}`);
    await delay(200);
  }
  assert(ready, "production web readiness timed out");
  await docker([
    "exec",
    containerId,
    "node",
    "--input-type=module",
    "-e",
    "const r = await fetch('http://127.0.0.1:3000/login'); if (r.status !== 200) throw new Error('login HTTP ' + r.status); await r.arrayBuffer();",
  ]);
  const startedAt = performance.now();

  await docker(["kill", "--signal=SIGTERM", containerId]);
  const exitCode = await docker(["wait", containerId]);
  const output = await docker(["logs", containerId]);

  assert.equal(exitCode, "0", output);
  assert.match(output, /projection-worker-stopped/);
  assert.match(output, /web-shutdown-done/);
  assert(performance.now() - startedAt < 25_000);
  const connections = await database.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
  );

  assert.equal(
    connections.rows[0].count,
    "0",
    "production web left PostgreSQL sessions behind",
  );
  process.stdout.write(
    JSON.stringify({
      image,
      test: "production-web-http-and-sigterm",
      status: "passed",
      elapsedMs: performance.now() - startedAt,
    }) + "\n",
  );
} finally {
  try {
    if (containerId) await docker(["rm", "--force", containerId]);
  } finally {
    await database.stop();
  }
}
