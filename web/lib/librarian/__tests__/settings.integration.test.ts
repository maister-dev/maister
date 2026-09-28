import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  admitNextLibrarianTurn,
  submitOwnerMessage,
} from "@/lib/librarian/admission";
import {
  readLibrarianSettings,
  updateLibrarianSettings,
} from "@/lib/librarian/settings";
import { fakeExecutionHosts } from "@/test-support/fake-execution-host";
import {
  seedActiveUser,
  seedLibrarianPlatform,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-185 (T2.13, LCV-11): the admin's enablement. The runner column survives
// the SET → CLEAR → re-SET round trip and a runner deletion; disabling stops
// admission only — queued messages stay queued and visible.

let database: StartedPostgresTestDb;
let db: NodePgDatabase;
let role: "admin" | "member" = "admin";
let adminId = "";

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  requireGlobalRole: vi.fn(async () => {
    if (role !== "admin") throw new MaisterError("UNAUTHORIZED", "admin only");

    return { id: adminId, role };
  }),
}));

function rows<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

async function insertRunner(id: string, overrides: string = "'default'") {
  await db.execute(sql`
    INSERT INTO platform_acp_runners
      (id, adapter, capability_agent, model, provider, permission_policy,
       readiness_status, readiness_reasons, enabled)
    VALUES (${id}, 'claude', 'claude', 'claude-sonnet-4-6', '{"kind":"anthropic"}'::jsonb,
            ${sql.raw(overrides)}, 'Ready', '[]'::jsonb, true)
  `);
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "librarian_settings",
  });
  db = database.db as unknown as NodePgDatabase;
  await fakeExecutionHosts(db);
  await seedLibrarianPlatform(db, {
    enabled: false,
    runnerId: "platform-default",
  });
  adminId = await seedActiveUser(db, { role: "admin" });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("IT-LCV-11 part 2: the librarian runner round trip", () => {
  it("SET → CLEAR → re-SET, and a deleted runner reads as not configured", async () => {
    const runnerId = `lib-${randomUUID()}`;

    await insertRunner(runnerId);
    const set = await updateLibrarianSettings(
      { enabled: true, runnerId },
      adminId,
      db as unknown as Db,
    );

    expect(set).toMatchObject({
      enabled: true,
      runnerId,
      availability: "ready",
    });
    const cleared = await updateLibrarianSettings(
      { enabled: true, runnerId: null },
      adminId,
      db as unknown as Db,
    );

    expect(cleared).toMatchObject({
      runnerId: null,
      availability: "not_configured",
    });
    const reset = await updateLibrarianSettings(
      { enabled: true, runnerId },
      adminId,
      db as unknown as Db,
    );

    expect(reset.runnerId).toBe(runnerId);
    // Leaving `runnerId` out keeps the runner.
    const kept = await updateLibrarianSettings(
      { enabled: false },
      adminId,
      db as unknown as Db,
    );

    expect(kept).toMatchObject({
      enabled: false,
      runnerId,
      availability: "disabled",
    });
    await db.execute(
      sql`DELETE FROM platform_acp_runners WHERE id = ${runnerId}`,
    );
    const [column] = rows<{ librarian_runner_id: string | null }>(
      await db.execute(sql`
        SELECT librarian_runner_id FROM platform_runtime_settings WHERE id = 'singleton'
      `),
    );

    expect(column.librarian_runner_id).toBeNull();
    await updateLibrarianSettings(
      { enabled: true },
      adminId,
      db as unknown as Db,
    );
    expect((await readLibrarianSettings(db)).availability).toBe(
      "not_configured",
    );
  });

  it("refuses a runner that skips permissions or does not exist with CONFIG", async () => {
    const skipper = `lib-skip-${randomUUID()}`;

    await insertRunner(skipper, "'dangerously_skip_permissions'");
    await expect(
      updateLibrarianSettings(
        { enabled: true, runnerId: skipper },
        adminId,
        db as unknown as Db,
      ),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { reason: "skips_permissions" },
    });
    await expect(
      updateLibrarianSettings(
        { enabled: true, runnerId: "no-such-runner" },
        adminId,
        db as unknown as Db,
      ),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { reason: "runner_missing" },
    });
  });

  it("refuses Codex while built-in host reads have no adapter denial", async () => {
    const runnerId = `lib-codex-${randomUUID()}`;

    await insertRunner(runnerId);
    await db.execute(sql`
      UPDATE platform_acp_runners
      SET adapter = 'codex', capability_agent = 'codex'
      WHERE id = ${runnerId}
    `);
    await expect(
      updateLibrarianSettings(
        { enabled: true, runnerId },
        adminId,
        db as unknown as Db,
      ),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { reason: "builtin_denial_unverified" },
    });
    await db.execute(sql`
      UPDATE platform_acp_runners
      SET capability_agent = 'claude'
      WHERE id = ${runnerId}
    `);
    await expect(
      updateLibrarianSettings(
        { enabled: true, runnerId },
        adminId,
        db as unknown as Db,
      ),
    ).rejects.toMatchObject({
      code: "CONFIG",
      details: { reason: "capability_not_supported" },
    });
    await db.execute(sql`
      UPDATE platform_acp_runners
      SET capability_agent = 'codex'
      WHERE id = ${runnerId}
    `);
    await db.execute(sql`
      UPDATE platform_runtime_settings
      SET librarian_enabled = true, librarian_runner_id = ${runnerId}
      WHERE id = 'singleton'
    `);
    expect((await readLibrarianSettings(db)).availability).toBe(
      "runner_not_ready",
    );
  });
});

describe("IT-LCV-11 part 2: disabling during a queued backlog", () => {
  it("keeps queued messages queued and admits nothing while disabled", async () => {
    const runnerId = `lib-${randomUUID()}`;

    await insertRunner(runnerId);
    await updateLibrarianSettings(
      { enabled: true, runnerId },
      adminId,
      db as unknown as Db,
    );
    const ownerId = await seedActiveUser(db);
    const send = (body: string) =>
      submitOwnerMessage(
        ownerId,
        { clientMessageId: randomUUID(), body, subject: null },
        { db: db as unknown as Db, start: async () => {} },
      );

    await send("first");
    const queued = await send("second");

    await updateLibrarianSettings(
      { enabled: false },
      adminId,
      db as unknown as Db,
    );
    const [conversation] = rows<{ id: string }>(
      await db.execute(sql`
        SELECT id FROM librarian_conversations WHERE user_id = ${ownerId}
      `),
    );

    await db.execute(sql`
      UPDATE librarian_turns SET status = 'completed', ended_at = now()
      WHERE conversation_id = ${conversation.id} AND status = 'admitted'
    `);
    expect(
      await admitNextLibrarianTurn(conversation.id, {
        db: db as unknown as Db,
      }),
    ).toBeNull();
    const [message] = rows<{ delivery_state: string }>(
      await db.execute(sql`
        SELECT delivery_state FROM librarian_messages WHERE id = ${queued.message.id}
      `),
    );

    expect(message.delivery_state).toBe("queued");
  });
});

describe("the admin route", () => {
  it("answers an admin and refuses a member", async () => {
    const route = await import("@/app/api/admin/platform/librarian/route");

    role = "admin";
    const ok = await route.GET();

    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      settings: { enabled: expect.any(Boolean) },
      readiness: { state: expect.any(String) },
    });
    const bad = await route.PATCH(
      new NextRequest("http://localhost/api/admin/platform/librarian", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runnerId: null }),
      }),
    );

    expect(bad.status).toBe(422);
    role = "member";
    expect((await route.GET()).status).toBe(403);
  });
});
