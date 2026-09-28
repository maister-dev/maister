import type { Db } from "@/lib/execution-host/db";
import type { ProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import type { RealSupervisor } from "@/test-support/real-supervisor";

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDb } from "@/lib/db/client";
import { submitOwnerMessage } from "@/lib/librarian/admission";
import { startLibrarianTurn } from "@/lib/librarian/runtime";
import { createExecutionHosts } from "@/lib/execution-host/client";
import { canonicalProjectors } from "@/lib/execution-host/events/projection-runtime";
import { startProjectionWorker } from "@/lib/execution-host/events/projection-worker";
import { stopRuntimeEventConsumers } from "@/lib/execution-host/events/consumer";
import { resetRegistrarStateForTests } from "@/lib/execution-host/registrar";
import { resetResolverForTests } from "@/lib/execution-host/resolver";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  addProjectMember,
  seedActiveUser,
  seedLibrarianPlatform,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";
import {
  freePort,
  startRealSupervisor,
  useRealSupervisorUrl,
} from "@/test-support/real-supervisor";

// ADR-185 (T2.14, IT-LCV-04 end to end): owner message → admission → the real
// supervisor → a mock ACP adapter → the real MCP facade (stdio) → the ext
// route, authenticated by the turn token → reply stored → token revoked → run
// parked. The only stand-ins are the adapter (scripted) and the HTTP server
// in front of the real ext route handlers.

let database: StartedPostgresTestDb;
let db: Db;
let supervisor: RealSupervisor;
let restoreUrl: () => void;
let worker: ProjectionWorker | null = null;
let web: Server;
const saved = {
  runtimeRoot: process.env.MAISTER_RUNTIME_ROOT,
  apiBase: process.env.MAISTER_API_BASE_URL,
  dbUrl: process.env.DB_URL,
};

function rows<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

// The facade reaches the web over HTTP; this serves the real ext handlers.
async function startExtServer(port: number): Promise<Server> {
  const projects = await import("@/app/api/v1/ext/projects/route");
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const request = new NextRequest(url, {
        method: req.method,
        headers: req.headers as Record<string, string>,
      });
      const response =
        url.pathname === "/api/v1/ext/projects" && req.method === "GET"
          ? await projects.GET(request)
          : new Response(JSON.stringify({ code: "PRECONDITION" }), {
              status: 404,
            });

      res.writeHead(response.status, {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
      });
      res.end(await response.text());
    })().catch((err: unknown) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );

  return server;
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "librarian_round_trip",
  });
  db = database.db as unknown as Db;
  process.env.DB_URL = database.databaseUrl;
  supervisor = await startRealSupervisor({ fixture: "mock-acp-librarian.mjs" });
  restoreUrl = useRealSupervisorUrl(supervisor.url);
  process.env.MAISTER_RUNTIME_ROOT = supervisor.runtimeRoot;
  const port = await freePort();

  web = await startExtServer(port);
  process.env.MAISTER_API_BASE_URL = `http://127.0.0.1:${port}`;
  resetRegistrarStateForTests();
  resetResolverForTests();
  worker = startProjectionWorker({ db, projectors: canonicalProjectors });
  await seedLibrarianPlatform(database.db as never);
}, 180_000);

afterAll(async () => {
  await stopRuntimeEventConsumers();
  await worker?.stop();
  await new Promise<void>((resolve) => web?.close(() => resolve()));
  await closeDb();
  restoreUrl?.();
  for (const [key, value] of [
    ["MAISTER_RUNTIME_ROOT", saved.runtimeRoot],
    ["MAISTER_API_BASE_URL", saved.apiBase],
    ["DB_URL", saved.dbUrl],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await supervisor?.kill();
  await database?.stop();
});

describe("IT-LCV-04: an owner message round-trips through the facade", () => {
  it("answers from a tool call made with the turn token, then parks", async () => {
    const ownerId = await seedActiveUser(database.db as never);
    const project = await seedProjectRow(database.db as never, {
      slug: `lib-${randomUUID().slice(0, 8)}`,
    });

    await addProjectMember(database.db as never, {
      projectId: project.id,
      userId: ownerId,
      role: "member",
    });
    const plan = {
      calls: [{ tool: "project_list", args: {} }],
      reply: "Found {{results}}",
    };
    let turn: Promise<void> | null = null;
    const hosts = createExecutionHosts({ db });
    const sent = await submitOwnerMessage(
      ownerId,
      {
        clientMessageId: randomUUID(),
        body: `Which projects can I see?\n\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``,
        subject: null,
      },
      {
        db,
        start: async (turnId) => {
          turn = startLibrarianTurn(turnId, { db, hosts });
          await turn;
        },
      },
    );

    await expect.poll(() => turn !== null, { timeout: 10_000 }).toBe(true);
    await turn;
    const turnId = sent.turn!.id;
    const [row] = rows<{ status: string; failure_reason: string | null }>(
      await db.execute(sql`
        SELECT status, failure_reason FROM librarian_turns WHERE id = ${turnId}
      `),
    );

    expect(row, await supervisor.logTail()).toEqual({
      status: "completed",
      failure_reason: null,
    });
    const [reply] = rows<{ body: string }>(
      await db.execute(sql`
        SELECT body FROM librarian_messages
        WHERE turn_id = ${turnId} AND author_kind = 'librarian'
      `),
    );

    expect(reply.body).toContain("project_list");
    expect(reply.body).toContain(project.slug);
    expect(reply.body).not.toContain('"isError":true');
    const audit = rows<{ actor_label: string; scope_used: string }>(
      await db.execute(sql`
        SELECT actor_label, scope_used FROM token_audit_log
        WHERE librarian_turn_id = ${turnId}
      `),
    );

    expect(audit).toContainEqual({
      actor_label: `librarian:${ownerId}`,
      scope_used: "projects:read",
    });
    const [token] = rows<{ revoked: boolean }>(
      await db.execute(sql`
        SELECT bool_and(revoked_at IS NOT NULL) AS revoked FROM project_tokens
        WHERE librarian_turn_id = ${turnId}
      `),
    );

    expect(token.revoked).toBe(true);
    const [run] = rows<{ status: string }>(
      await db.execute(sql`
        SELECT r.status FROM runs r JOIN librarian_conversations c ON c.run_id = r.id
        WHERE c.user_id = ${ownerId}
      `),
    );

    expect(run.status).toBe("NeedsInputIdle");
  }, 120_000);
});
