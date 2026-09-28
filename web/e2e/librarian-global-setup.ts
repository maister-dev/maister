import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";

import { resolvePostgresDbUrl } from "@/lib/db/postgres-url";
import { startRealSupervisor } from "@/test-support/real-supervisor";
import { seedLibrarianPlatform } from "@/test-support/librarian-seed";

import {
  LIBRARIAN_SUPERVISOR_CONTROL_PORT,
  LIBRARIAN_SUPERVISOR_PORT,
} from "./_seed/librarian-lane";

const execFileAsync = promisify(execFile);

function qualificationAdapter(value: string | undefined): "claude" | "codex" | undefined {
  if (value === undefined || value === "claude" || value === "codex") return value;

  throw new Error(`unsupported librarian qualification adapter: ${value}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const pool = new Pool({ connectionString: resolvePostgresDbUrl() });
  const worktreesRoot = process.env.MAISTER_WORKTREES_ROOT;
  const runtimeRoot = path.resolve("e2e/.runtime-librarian-web");
  const liveAdapter = qualificationAdapter(process.env.MAISTER_LIBRARIAN_QUALIFY_ADAPTER);

  if (!worktreesRoot)
    throw new Error("librarian lane requires MAISTER_WORKTREES_ROOT");
  await execFileAsync("pnpm", ["build"], {
    cwd: path.resolve("../mcp"),
    env: process.env,
  });
  await mkdir(runtimeRoot, { recursive: true });
  await seedLibrarianPlatform(
    drizzle(pool),
    liveAdapter
      ? {
          adapter: liveAdapter,
          model: liveAdapter === "claude" ? "claude-sonnet-4-6" : "gpt-6-astra",
        }
      : {},
  );
  let supervisor = await startRealSupervisor({
    port: LIBRARIAN_SUPERVISOR_PORT,
    runtimeRoot,
    workspaceRoots: [worktreesRoot, runtimeRoot],
    fixture: "mock-acp-librarian.mjs",
    ...(liveAdapter
      ? {
          env: {
            MAISTER_ADAPTER_BINARY_CLAUDE: path.resolve(
              "../supervisor/node_modules/.bin/claude-agent-acp",
            ),
            MAISTER_ADAPTER_BINARY_CODEX: path.resolve(
              "../supervisor/node_modules/.bin/codex-acp",
            ),
          },
        }
      : {}),
  });
  const control = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/restart") {
      response.writeHead(404).end();

      return;
    }
    if (request.headers["x-maister-e2e-control"] !== "librarian-e2e-control") {
      response.writeHead(403).end();

      return;
    }
    try {
      supervisor = await supervisor.restart();
      response.writeHead(200).end("ready");
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen(LIBRARIAN_SUPERVISOR_CONTROL_PORT, "127.0.0.1", resolve);
  });

  return async () => {
    await new Promise<void>((resolve, reject) => {
      control.close((error) => (error ? reject(error) : resolve()));
    });
    await supervisor.stop();
    await pool.end();
    await rm(runtimeRoot, { recursive: true, force: true });
  };
}
