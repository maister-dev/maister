import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Ajv from "ajv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { parseAgentMemoryMutation } from "@/lib/agent-memory-vault/commands";
import { agentMemoryVaultLimits } from "@/lib/agent-memory-vault/limits";
import { prepareHumanProjectVault } from "@/lib/agent-memory-vault/project-access";
import { applyVaultMutation } from "@/lib/agent-memory-vault/store";
import * as schema from "@/lib/db/schema";
import {
  issueLibrarianTurnToken,
  scopesForLibrarianTurn,
} from "@/lib/librarian/authority";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  seedActiveUser,
  seedLibrarianTurn,
} from "@/test-support/librarian-seed";
import {
  startMainAndBrainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));

beforeAll(async () => {
  database = await startMainAndBrainPostgresTestDb({
    databaseName: "librarian_governed_confirmations",
  });
  await database.pool.query(
    "INSERT INTO agent_memory_cutover(generation) VALUES(1)",
  );
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

async function fixture() {
  const { db, pool } = database;
  const project = await seedProjectRow(db);
  const userId = await seedActiveUser(db, { role: "admin" });
  const turnId = await seedLibrarianTurn(db, userId);
  const token = await issueLibrarianTurnToken(
    {
      turnId,
      ownerUserId: userId,
      scopes: scopesForLibrarianTurn("owner_message"),
      expiresAt: new Date(Date.now() + 60_000),
    },
    db,
  );
  const agentId = `fixture:${randomUUID()}`;

  await pool.query("UPDATE librarian_turns SET token_id=$2 WHERE id=$1", [
    turnId,
    token.tokenId,
  ]);
  await pool.query("UPDATE projects SET brain_enabled=true WHERE id=$1", [
    project.id,
  ]);
  await pool.query(
    `INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path)
      VALUES($1,'fixture','v1','git','Fixture agent','Fixture','none','session','[]','read_only','/unused/fixture.md')`,
    [agentId],
  );
  await pool.query(
    `INSERT INTO agent_project_links(id,project_id,agent_id,memory_enabled)
      VALUES(gen_random_uuid()::text,$1,$2,true)`,
    [project.id, agentId],
  );
  const access = prepareHumanProjectVault({
    userId,
    slug: project.slug,
    agentId,
    action: "editSettings",
  });
  const { vaultId } = await db.transaction(access);
  const { POST: post } = await import("@/app/api/v1/ext/librarian/cards/route");

  return {
    project,
    userId,
    vaultId,
    write: (command: unknown) =>
      applyVaultMutation(
        db,
        parseAgentMemoryMutation(command),
        access,
        agentMemoryVaultLimits(),
      ),
    submit: (proposal: object) =>
      post(
        new NextRequest("http://localhost/api/v1/ext/librarian/cards", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token.secret}`,
            "content-type": "application/json",
            "Idempotency-Key": randomUUID(),
          },
          body: JSON.stringify(proposal),
        }),
      ),
  };
}

const notePath = "/memories/notes/context.md";

function createNote(text: string) {
  return {
    command: "create",
    path: notePath,
    file_text: text,
    ifRevisionId: null,
    ifHash: null,
    requestKey: randomUUID(),
  };
}

it("shows the entire authorized note change and refuses an older incomplete card", async () => {
  const { db, pool } = database;
  const { userId, vaultId, write, submit } = await fixture();
  const { getLinkedWork } = await import("@/lib/librarian/read-models");
  const { decideLibrarianCard } =
    await import("@/lib/librarian/card-decisions");
  const { parseActionHistoryQuery, readActionHistory } =
    await import("@/lib/librarian/action-history");
  const attention = () =>
    readActionHistory(
      db,
      userId,
      parseActionHistoryQuery(new URLSearchParams({ collection: "attention" })),
    );
  const original = `${"Line of context\n".repeat(185)}Original conclusion`;
  const saved = await write(createNote(original));

  if (saved.status !== "applied") throw new Error("Expected an applied note");
  const note = saved.affected[0]!;
  const proposal = {
    action: "vault_edit",
    vaultId,
    command: {
      command: "str_replace",
      path: notePath,
      old_str: "Original conclusion",
      new_str: "Reviewed conclusion",
      ifRevisionId: note.revisionId,
      ifHash: note.hash,
      requestKey: randomUUID(),
    },
  };
  const created = await submit(proposal);

  expect(created.status).toBe(201);
  const { cardId } = (await created.json()) as { cardId: string };
  const card = await getLinkedWork(userId, db);
  const rendered = card.cards.find((candidate) => candidate.id === cardId);
  const contract = parse(
    readFileSync(resolve("../docs/api/web.openapi.yaml"), "utf8"),
  ) as { components: object };
  const validateCard = new Ajv({
    strict: false,
    validateFormats: false,
  }).compile({
    $ref: "#/components/schemas/LibrarianCard",
    components: contract.components,
  });

  expect(rendered).toMatchObject({ available: true });
  expect(validateCard(rendered), JSON.stringify(validateCard.errors)).toBe(
    true,
  );
  expect(JSON.parse(rendered?.effectPreview ?? "null")).toMatchObject([
    { before: original, after: original.replace("Original", "Reviewed") },
  ]);
  expect((await attention()).items).toContainEqual(
    expect.objectContaining({
      id: cardId,
      confirmation: expect.objectContaining({
        effectPreview: rendered?.effectPreview,
      }),
    }),
  );
  await pool.query(
    `UPDATE librarian_cards SET effect_context=jsonb_set(effect_context,'{preview}',to_jsonb(left(effect_context->>'preview',2048)))
      WHERE id=$1`,
    [cardId],
  );

  const { getLibrarianConversationView } = await import("@/lib/librarian/view");
  const view = await getLibrarianConversationView(userId, db);
  const unavailable = view.cards.find((candidate) => candidate.id === cardId);

  expect(view.pendingCards).toEqual([]);
  expect((await attention()).items).toEqual([]);
  expect(unavailable).toMatchObject({
    id: cardId,
    available: false,
    payload: {},
  });
  expect(unavailable).not.toHaveProperty("effectPreview");
  expect(validateCard(unavailable), JSON.stringify(validateCard.errors)).toBe(
    true,
  );
  await expect(
    decideLibrarianCard(
      { cardId, user: { id: userId, role: "admin" }, decision: "accept" },
      db,
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  expect(
    (
      await pool.query(
        "SELECT content FROM agent_memory_revision_payloads WHERE note_id=$1",
        [note.noteId],
      )
    ).rows,
  ).toEqual([{ content: original }]);

  const fresh = await submit({
    ...proposal,
    command: { ...proposal.command, requestKey: randomUUID() },
  });

  expect(fresh.status).toBe(201);
  const { cardId: freshId } = (await fresh.json()) as { cardId: string };

  expect(
    await decideLibrarianCard(
      {
        cardId: freshId,
        user: { id: userId, role: "admin" },
        decision: "accept",
      },
      db,
    ),
  ).toMatchObject({ statusCode: 200 });
});

it("refuses oversized governed drafts before publishing a confirmation", async () => {
  const { project, userId, vaultId, write, submit } = await fixture();
  const longText = `A complete checked draft. ${"evidence ".repeat(2200)}End of draft.`;
  const notes = await Promise.all([
    write(createNote(longText.slice(0, 9_000))),
    write({
      ...createNote(longText.slice(0, 9_000)),
      path: "/memories/notes/related.md",
    }),
  ]);
  const {
    rows: [vault],
  } = await database.pool.query<{ generation: string }>(
    "SELECT generation::text FROM agent_memory_vaults WHERE id=$1",
    [vaultId],
  );
  const heads = notes.flatMap((note) => {
    if (note.status !== "applied") throw new Error("Expected a saved note");

    return note.affected.map(({ path, revisionId, hash }) => ({
      path,
      ifRevisionId: revisionId,
      ifHash: hash,
    }));
  });
  const proposals = [
    {
      action: "vault_edit",
      vaultId,
      command: {
        command: "clear",
        ifGeneration: vault!.generation,
        heads,
        requestKey: randomUUID(),
      },
    },
    {
      action: "brain_proposal",
      projectSlug: project.slug,
      kind: "state",
      draft: { title: "Process fact", content: longText },
    },
    {
      action: "knowledge_proposal",
      content: {
        change: "add",
        owner: { kind: "project", projectId: project.id },
        title: "An observation",
        assertion: longText,
        kind: "observation",
        basis: "inferred",
        evidence: [],
        missingEvidence: [],
        limitations: [],
      },
    },
  ];

  const responses = await Promise.all(
    proposals.map(async (proposal) => {
      const response = await submit(proposal);

      return { status: response.status, body: await response.json() };
    }),
  );

  for (const response of responses)
    expect(response).toMatchObject({
      status: 409,
      body: {
        code: "PRECONDITION",
        details: { reason: "governed_preview_limit" },
      },
    });
  expect(
    (
      await database.pool.query(
        `SELECT card.id FROM librarian_cards card JOIN librarian_conversations conv ON conv.id=card.conversation_id WHERE conv.user_id=$1`,
        [userId],
      )
    ).rows,
  ).toEqual([]);
});

it("keeps older complete draft previews reviewable across JSONB key ordering", async () => {
  const { project, userId, submit } = await fixture();
  const { db, pool } = database;
  const { getLibrarianConversationView } = await import("@/lib/librarian/view");
  const draft = {
    content: "A retained complete effect",
    title: "An observation",
  };
  const created = await submit({
    action: "brain_proposal",
    projectSlug: project.slug,
    kind: "state",
    draft,
  });

  expect(created.status).toBe(201);
  const { cardId } = (await created.json()) as { cardId: string };

  for (const preview of [
    JSON.stringify(draft),
    JSON.stringify({ title: draft.title, content: draft.content }),
  ]) {
    await pool.query(
      "UPDATE librarian_cards SET effect_context=jsonb_set(effect_context,'{preview}',to_jsonb($2::text)) WHERE id=$1",
      [cardId, preview],
    );
    const view = await getLibrarianConversationView(userId, db);

    expect(view.pendingCards).toMatchObject([{ id: cardId, available: true }]);
  }
});

it("waits before locking a confirmation whose source is being redacted", async () => {
  const { pool } = database;
  const db = drizzle(pool, { schema });
  const { userId, vaultId, write, submit } = await fixture();
  const { redactMemoryRevision } =
    await import("@/lib/agent-memory-vault/redaction");
  const { decideKnowledgeCard } =
    await import("@/lib/librarian/knowledge-card-effects");
  const saved = await write(createNote("Restricted source"));

  if (saved.status !== "applied") throw new Error("Expected an applied note");
  const note = saved.affected[0]!;
  const result = await submit({
    action: "vault_edit",
    vaultId,
    command: {
      ...createNote("A pending change"),
      ifRevisionId: note.revisionId,
      ifHash: note.hash,
    },
  });

  expect(result.status).toBe(201);
  const { cardId } = (await result.json()) as { cardId: string };
  const invalidated = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const redaction = db.transaction(async (tx) => {
    await redactMemoryRevision(tx, userId, note.revisionId, {
      requestKey: randomUUID(),
      reason: "Remove an exact source revision",
    });
    invalidated.resolve();
    await release.promise;
  });

  try {
    await Promise.race([invalidated.promise, redaction]);
    const decisionPid = Promise.withResolvers<number>();
    const decision = db
      .transaction(async (tx) => {
        const { rows } = await tx.execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );

        decisionPid.resolve(rows[0]!.pid);

        return decideKnowledgeCard(tx, { cardId, userId, decision: "accept" });
      })
      .then(
        (effect) => ({ effect }),
        (error: unknown) => ({ error }),
      );
    const pid = await decisionPid.promise;

    try {
      await expect
        .poll(
          async () =>
            (
              await pool.query<{ wait_event: string | null }>(
                "SELECT wait_event FROM pg_stat_activity WHERE pid=$1",
                [pid],
              )
            ).rows[0]?.wait_event,
        )
        .toBe("advisory");
    } finally {
      release.resolve();
      await redaction;
      const outcome = await decision;

      expect(outcome).toMatchObject({ error: { code: "PRECONDITION" } });
    }
  } finally {
    release.resolve();
    await redaction;
  }
  expect(
    (
      await pool.query("SELECT status FROM librarian_cards WHERE id=$1", [
        cardId,
      ])
    ).rows,
  ).toEqual([{ status: "superseded" }]);
  expect(
    (
      await pool.query(
        "SELECT content FROM agent_memory_revision_payloads WHERE note_id=$1",
        [note.noteId],
      )
    ).rows,
  ).toEqual([]);
});
