import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  issueLibrarianTurnToken,
  scopesForLibrarianTurn,
} from "@/lib/librarian/authority";
import { seedProject } from "@/test-support/execution-host-seed";
import {
  addProjectMember,
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
    databaseName: "librarian_knowledge_vault",
  });
}, 180_000);
afterAll(async () => {
  await database?.stop();
});

it("AV-08 reads native knowledge through the turn's live access and refuses direct writes", async () => {
  const get = (await import("@/app/api/v1/ext/knowledge/route")).GET;
  const post = (await import("@/app/api/v1/ext/knowledge/proposals/route"))
    .POST;
  const db = database.db;
  const userId = await seedActiveUser(db);
  const projectId = await seedProject(db);
  await addProjectMember(db, { projectId, userId, role: "member" });
  await database.pool.query(
    "UPDATE projects SET brain_enabled=true WHERE id=$1",
    [projectId],
  );
  const turnId = await seedLibrarianTurn(db, userId);
  const { tokenId, secret } = await issueLibrarianTurnToken(
    {
      turnId,
      ownerUserId: userId,
      scopes: scopesForLibrarianTurn("owner_message"),
      expiresAt: new Date(Date.now() + 60_000),
    },
    db,
  );
  await database.pool.query(
    "UPDATE librarian_turns SET token_id=$2 WHERE id=$1",
    [turnId, tokenId],
  );
  const headers = {
    authorization: `Bearer ${secret}`,
    "content-type": "application/json",
  };
  const url = new URL("http://localhost/api/v1/ext/knowledge");
  url.searchParams.set("ownerKind", "project");
  url.searchParams.set("ownerId", projectId);
  const response = await get(new NextRequest(url, { headers }));
  expect(response.status, JSON.stringify(await response.clone().json())).toBe(
    200,
  );
  expect(await response.json()).toMatchObject({ items: [] });
  const direct = await post(
    new NextRequest(new URL("/api/v1/ext/knowledge/proposals", url), {
      headers,
      method: "POST",
      body: "{}",
    }),
  );
  expect(direct.status).toBe(403);
  const { POST: cards } =
    await import("@/app/api/v1/ext/librarian/cards/route");
  const { decideLibrarianCard } =
    await import("@/lib/librarian/card-decisions");
  const { getLinkedWork } = await import("@/lib/librarian/read-models");
  const slug = (
    await database.pool.query<{ slug: string }>(
      "SELECT slug FROM projects WHERE id=$1",
      [projectId],
    )
  ).rows[0]!.slug;
  const submit = (body: Record<string, unknown>, key: string = randomUUID()) =>
    cards(
      new NextRequest(new URL("/api/v1/ext/librarian/cards", url), {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": key },
        body: JSON.stringify(body),
      }),
    );
  const draft = {
    action: "brain_proposal",
    projectSlug: slug,
    kind: "state",
    draft: { title: "Process fact", content: "Builds run before release." },
  };
  const card = await submit(draft);
  expect(card.status, JSON.stringify(await card.clone().json())).toBe(201);
  const { cardId } = await card.json();
  const count = async () =>
    (
      await database.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM brain_proposals WHERE project_id=$1 AND kind='state'",
        [projectId],
      )
    ).rows[0]?.count;
  expect(await count()).toBe(0);
  expect((await getLinkedWork(userId, db)).cards).toContainEqual(
    expect.objectContaining({
      id: cardId,
      status: "pending",
      available: true,
      effectPreview: expect.stringContaining("Builds run before release."),
    }),
  );
  const confirm = () =>
    decideLibrarianCard(
      { cardId, user: { id: userId, role: "member" }, decision: "accept" },
      db,
    );
  const receipt = await confirm();
  const effect = receipt.body.effect as { kind: string; proposalId: string };
  expect(effect).toMatchObject({
    kind: "brain",
    proposalId: expect.any(String),
  });
  expect(await confirm()).toEqual(receipt);
  expect(await count()).toBe(1);
  expect(
    (
      await database.pool.query(
        "SELECT status, actor FROM brain_proposals WHERE id=$1",
        [effect.proposalId],
      )
    ).rows,
  ).toEqual([{ status: "pending", actor: { type: "user", id: userId } }]);
  const knowledge = await submit({
    action: "knowledge_proposal",
    content: {
      change: "add",
      owner: { kind: "project", projectId },
      title: "Release observation",
      kind: "observation",
      assertion: "Release check uses automation.",
      basis: "unknown",
      evidence: [],
      missingEvidence: [],
      limitations: [],
    },
  });
  expect(knowledge.status, JSON.stringify(await knowledge.clone().json())).toBe(
    201,
  );
  const { cardId: knowledgeId } = await knowledge.json();
  const knowledgeReceipt = await decideLibrarianCard(
    {
      cardId: knowledgeId,
      user: { id: userId, role: "member" },
      decision: "accept",
    },
    db,
  );
  const knowledgeEffect = knowledgeReceipt.body.effect as {
    kind: string;
    proposalId: string;
  };
  expect(knowledgeEffect.kind).toBe("knowledge");
  expect(
    (
      await database.pool.query(
        "SELECT status,knowledge_attribution->>'id' AS author FROM brain_proposals WHERE id=$1",
        [knowledgeEffect.proposalId],
      )
    ).rows,
  ).toEqual([{ status: "pending", author: userId }]);

  const agentId = "vault-fixture:librarian";
  await database.pool.query(
    `INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path)
    VALUES($1,'vault-fixture','fixture','git','Vault fixture','Vault fixture','none','session','["manual"]','read_only','/tmp/vault-fixture.md')`,
    [agentId],
  );
  await database.pool.query(
    "INSERT INTO agent_project_links(id,project_id,agent_id,enabled,memory_enabled) VALUES($1,$2,$3,true,true)",
    [randomUUID(), projectId, agentId],
  );
  await database.pool.query(
    "INSERT INTO agent_memory_cutover(generation) VALUES(1)",
  );
  const [vault] = (
    await database.pool.query<{ id: string }>(
      "INSERT INTO agent_memory_vaults(project_id,agent_id) VALUES($1,$2) RETURNING id",
      [projectId, agentId],
    )
  ).rows;
  if (!vault) throw new Error("Expected a vault fixture");
  const { GET: vaultList } =
    await import("@/app/api/v1/ext/librarian/vaults/route");
  const { GET: viewVault } =
    await import("@/app/api/v1/ext/librarian/vaults/[vaultId]/view/route");
  const visibleVaults = await vaultList(
    new NextRequest(new URL("/api/v1/ext/librarian/vaults", url), { headers }),
  );
  expect((await visibleVaults.json()).items).toContainEqual(
    expect.objectContaining({ id: vault.id, ownerKind: "project" }),
  );
  await database.pool.query(
    "UPDATE project_members SET role='owner' WHERE project_id=$1 AND user_id=$2",
    [projectId, userId],
  );
  const command = {
    command: "create",
    path: "/memories/notes/fact.md",
    file_text: "Observed a release warning.",
    ifRevisionId: null,
    ifHash: null,
    requestKey: randomUUID(),
  };
  const vaultCard = await submit({
    action: "vault_edit",
    vaultId: vault.id,
    command,
  });
  expect(vaultCard.status, JSON.stringify(await vaultCard.clone().json())).toBe(
    201,
  );
  const { cardId: vaultCardId } = await vaultCard.json();
  const vaultReceipt = await decideLibrarianCard(
    {
      cardId: vaultCardId,
      user: { id: userId, role: "member" },
      decision: "accept",
    },
    db,
  );
  expect(vaultReceipt.body.effect).toMatchObject({
    kind: "vault",
    revisionIds: [expect.any(String)],
  });
  const note = await viewVault(
    new NextRequest(
      new URL(
        `/api/v1/ext/librarian/vaults/${vault.id}/view?path=${encodeURIComponent(command.path)}`,
        url,
      ),
      { headers },
    ),
    { params: Promise.resolve({ vaultId: vault.id }) },
  );
  expect(await note.json()).toMatchObject({
    kind: "note",
    content: command.file_text,
  });
  expect(
    (
      await database.pool.query(
        "SELECT knowledge_access->'restrictions' AS sources FROM librarian_turns WHERE id=$1",
        [turnId],
      )
    ).rows[0]?.sources,
  ).toContainEqual(
    expect.objectContaining({
      kind: "agent_vault_revision_v1",
      vaultId: vault.id,
    }),
  );
  const { appendConversationMessage, lockOwnerConversation } =
    await import("@/lib/librarian/conversation");
  const { searchLibrarianHistory } =
    await import("@/lib/librarian/history-search");
  await db.transaction(async (tx) => {
    const { conversation, segment } = await lockOwnerConversation(tx, userId);
    await appendConversationMessage(tx, {
      conversationId: conversation.id,
      segmentId: segment.id,
      authorKind: "librarian",
      body: "A release warning was observed.",
      turnId,
    });
  });
  expect(
    (await searchLibrarianHistory(userId, "warning", db)).hits,
  ).toHaveLength(1);

  const redactedCard = await submit({
    ...draft,
    draft: {
      title: "Warning follow-up",
      content: "Investigate the release warning.",
    },
  });
  expect(redactedCard.status).toBe(201);
  const { cardId: redactedCardId } = await redactedCard.json();
  const admin = await seedActiveUser(db, { role: "admin" });
  const revisionId = (vaultReceipt.body.effect as { revisionIds: string[] })
    .revisionIds[0]!;
  const { redactMemoryRevision } =
    await import("@/lib/agent-memory-vault/redaction");
  await redactMemoryRevision(db, admin, revisionId, {
    requestKey: randomUUID(),
    reason: "Acceptance fixture",
  });
  expect((await searchLibrarianHistory(userId, "warning", db)).hits).toEqual(
    [],
  );
  expect(
    (
      await database.pool.query(
        "SELECT status, payload, effect_context FROM librarian_cards WHERE id=$1",
        [redactedCardId],
      )
    ).rows,
  ).toEqual([{ status: "superseded", payload: {}, effect_context: null }]);

  const laterTurnId = await seedLibrarianTurn(db, userId);
  const later = await issueLibrarianTurnToken(
    {
      turnId: laterTurnId,
      ownerUserId: userId,
      scopes: scopesForLibrarianTurn("owner_message"),
      expiresAt: new Date(Date.now() + 60_000),
    },
    db,
  );
  await database.pool.query(
    "UPDATE librarian_turns SET token_id=$2 WHERE id=$1",
    [laterTurnId, later.tokenId],
  );
  headers.authorization = `Bearer ${later.secret}`;

  const revokedCard = await submit({
    ...draft,
    draft: { title: "Another fact", content: "Tests are required." },
  });
  const { cardId: revokedCardId } = await revokedCard.json();
  await database.pool.query(
    "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2",
    [projectId, userId],
  );
  const denied = await get(new NextRequest(url, { headers }));

  url.searchParams.set("ownerId", randomUUID());
  const missing = await get(new NextRequest(url, { headers }));
  expect(denied.status).toBe(missing.status);
  expect(await denied.json()).toEqual(await missing.json());
  await expect(
    decideLibrarianCard(
      {
        cardId: revokedCardId,
        user: { id: userId, role: "member" },
        decision: "accept",
      },
      db,
    ),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  expect(await count()).toBe(1);
});
