import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";
import {
  issueAgentRunToken,
  issueOrchestratorRunToken,
  revokeAgentRunToken,
  revokeOrchestratorRunTokensForRun,
} from "@/lib/agents/tokens";
import { issueToken } from "@/lib/tokens/issue";
import { revokeToken } from "@/lib/tokens/revoke";
import { type TokenScope } from "@/lib/tokens/scopes";
import { updateOwnerToken, updateProjectToken } from "@/lib/tokens/update";
import { TokenAuthError, verifyToken } from "@/lib/tokens/verify";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

let projectId: string;
let otherProjectId: string;
let userId: string;
let otherUserId: string;
let agentId: string;

const actor = () => ({ userId, label: `user:${userId}` });

async function lifecycleRows(tokenId: string) {
  return db
    .select()
    .from(schema.tokenLifecycleEvents)
    .where(eq(schema.tokenLifecycleEvents.token_id, tokenId));
}

async function tokenRow(tokenId: string) {
  const rows = await db
    .select()
    .from(schema.projectTokens)
    .where(eq(schema.projectTokens.id, tokenId));

  return rows[0];
}

/** A managed project token — the editable, ledger-covered class. */
async function managedProjectToken(overrides?: {
  name?: string;
  scopes?: TokenScope[];
  expiresAt?: Date | null;
}) {
  return issueToken(
    {
      projectId,
      name: overrides?.name ?? `CI pipeline ${randomUUID().slice(0, 8)}`,
      scopes: overrides?.scopes ?? ["tasks:read"],
      createdByUserId: userId,
      expiresAt: overrides?.expiresAt ?? null,
    },
    db,
  );
}

/** A managed global personal token. */
async function managedOwnerToken(
  ownerId: string,
  overrides?: { name?: string; scopes?: TokenScope[] },
) {
  return issueToken(
    {
      projectId: null,
      name: overrides?.name ?? `Personal ${randomUUID().slice(0, 8)}`,
      tokenKind: "user",
      ownerUserId: ownerId,
      scopes: overrides?.scopes ?? ["tasks:read"],
      createdByUserId: ownerId,
    },
    db,
  );
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "token_update_test",
  });
  db = testDatabase.db;

  projectId = randomUUID();
  otherProjectId = randomUUID();
  userId = randomUUID();
  otherUserId = randomUUID();
  agentId = `pkg:agent-${randomUUID().slice(0, 8)}`;

  await db.insert(schema.users).values([
    {
      id: userId,
      name: "Token Admin",
      email: `admin-${userId}@example.com`,
      role: "member",
      accountStatus: "active",
      passwordHash: "x",
    },
    {
      id: otherUserId,
      name: "Other Owner",
      email: `other-${otherUserId}@example.com`,
      role: "member",
      accountStatus: "active",
      passwordHash: "x",
    },
  ]);

  await db.insert(schema.projects).values([
    {
      id: projectId,
      taskKey: `TA${randomUUID().slice(0, 6)}`.toUpperCase(),
      slug: `tok-update-${randomUUID().slice(0, 8)}`,
      name: "Token Update Project",
      repoPath: `/tmp/tok-update-${randomUUID().slice(0, 8)}`,
      maisterYamlPath: "/tmp/tok-update/maister.yaml",
    },
    {
      id: otherProjectId,
      taskKey: `TB${randomUUID().slice(0, 6)}`.toUpperCase(),
      slug: `tok-other-${randomUUID().slice(0, 8)}`,
      name: "Other Project",
      repoPath: `/tmp/tok-other-${randomUUID().slice(0, 8)}`,
      maisterYamlPath: "/tmp/tok-other/maister.yaml",
    },
  ]);

  await db.insert(schema.agents).values({
    id: agentId,
    packageName: "pkg",
    versionLabel: "v1.0.0",
    origin: "git",
    name: "Test Agent",
    description: "fixture",
    workspace: "none",
    mode: "session",
    triggers: [],
    riskTier: "read_only",
    sourcePath: "maister-agents/test.md",
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("lib/tokens/update — integration (testcontainers)", () => {
  it("I1: widening scopes persists and writes exactly one scopes_changed row carrying before/after", async () => {
    const issued = await managedProjectToken({ scopes: ["tasks:read"] });

    const result = await updateProjectToken(
      { tokenId: issued.tokenId, projectId },
      { scopes: ["tasks:read", "flows:read", "runners:read"] },
      actor(),
      db,
    );

    expect(result.outcome).toBe("updated");
    expect((await tokenRow(issued.tokenId)).scopes).toEqual([
      "tasks:read",
      "flows:read",
      "runners:read",
    ]);

    const rows = await lifecycleRows(issued.tokenId);
    const changes = rows.filter((r: any) => r.event === "scopes_changed");

    expect(changes).toHaveLength(1);
    expect(changes[0].before).toEqual({ scopes: ["tasks:read"] });
    expect(changes[0].after).toEqual({
      scopes: ["tasks:read", "flows:read", "runners:read"],
    });
    expect(changes[0].actor_user_id).toBe(userId);
    expect(changes[0].project_id).toBe(projectId);
  });

  it("I2: narrowing scopes persists and writes exactly one scopes_changed row", async () => {
    const issued = await managedProjectToken({
      scopes: ["tasks:read", "tasks:update", "runs:launch"],
    });

    const result = await updateProjectToken(
      { tokenId: issued.tokenId, projectId },
      { scopes: ["tasks:read"] },
      actor(),
      db,
    );

    expect(result.outcome).toBe("updated");
    expect((await tokenRow(issued.tokenId)).scopes).toEqual(["tasks:read"]);

    const changes = (await lifecycleRows(issued.tokenId)).filter(
      (r: any) => r.event === "scopes_changed",
    );

    expect(changes).toHaveLength(1);
    expect(changes[0].after).toEqual({ scopes: ["tasks:read"] });
  });

  it("I3: a patch that changes nothing writes no lifecycle row and reports unchanged", async () => {
    const issued = await managedProjectToken({
      name: "Stable name",
      scopes: ["tasks:read"],
    });
    const before = await lifecycleRows(issued.tokenId);

    const result = await updateProjectToken(
      { tokenId: issued.tokenId, projectId },
      { name: "Stable name", scopes: ["tasks:read"], expiresAt: null },
      actor(),
      db,
    );

    expect(result.outcome).toBe("unchanged");
    expect(await lifecycleRows(issued.tokenId)).toHaveLength(before.length);
  });

  it("I4: a multi-field patch writes one row per changed field, all in one commit", async () => {
    const issued = await managedProjectToken({
      name: "Before name",
      scopes: ["tasks:read"],
    });
    const expiry = new Date(Date.now() + 86_400_000);

    const result = await updateProjectToken(
      { tokenId: issued.tokenId, projectId },
      { name: "After name", scopes: ["runs:read"], expiresAt: expiry },
      actor(),
      db,
    );

    expect(result.outcome).toBe("updated");

    const rows = await lifecycleRows(issued.tokenId);
    const events = rows
      .map((r: any) => r.event)
      .filter((e: string) => e !== "issued");

    expect(events.sort()).toEqual(
      ["expiry_changed", "renamed", "scopes_changed"].sort(),
    );

    const row = await tokenRow(issued.tokenId);

    expect(row.name).toBe("After name");
    expect(row.scopes).toEqual(["runs:read"]);
    expect(row.expires_at?.toISOString()).toBe(expiry.toISOString());
  });

  it("I5: a failure inside the transaction discards both the update and its lifecycle rows", async () => {
    const issued = await managedProjectToken({ scopes: ["tasks:read"] });
    const ledgerBefore = await lifecycleRows(issued.tokenId);

    // A non-existent actor violates token_lifecycle_events.actor_user_id's FK,
    // so the ledger INSERT fails AFTER the UPDATE inside the same transaction.
    await expect(
      updateProjectToken(
        { tokenId: issued.tokenId, projectId },
        { scopes: ["runs:read"] },
        { userId: randomUUID(), label: "user:ghost" },
        db,
      ),
    ).rejects.toThrow();

    expect((await tokenRow(issued.tokenId)).scopes).toEqual(["tasks:read"]);
    expect(await lifecycleRows(issued.tokenId)).toHaveLength(
      ledgerBefore.length,
    );
  });

  it("I6: an agent-kind token is refused PRECONDITION", async () => {
    const runId = randomUUID();
    const minted = await issueAgentRunToken({
      agentId,
      projectId,
      runId,
      db,
    });

    const err = await updateProjectToken(
      { tokenId: minted.tokenId, projectId },
      { scopes: ["tasks:read"] },
      actor(),
      db,
    ).catch((e) => e);

    expect(isMaisterError(err) && err.code).toBe("PRECONDITION");
  });

  it("I7: a project-kind token named orchestrator-run:<id> is refused PRECONDITION", async () => {
    const runId = randomUUID();
    const minted = await issueOrchestratorRunToken({ projectId, runId, db });

    const stored = await tokenRow(minted.tokenId);

    expect(stored.token_kind).toBe("project");

    const err = await updateProjectToken(
      { tokenId: minted.tokenId, projectId },
      { scopes: ["tasks:read"] },
      actor(),
      db,
    ).catch((e) => e);

    expect(isMaisterError(err) && err.code).toBe("PRECONDITION");
  });

  it("I8: a revoked token is refused PRECONDITION", async () => {
    const issued = await managedProjectToken();

    await revokeToken({ tokenId: issued.tokenId, projectId }, db);

    const err = await updateProjectToken(
      { tokenId: issued.tokenId, projectId },
      { scopes: ["runs:read"] },
      actor(),
      db,
    ).catch((e) => e);

    expect(isMaisterError(err) && err.code).toBe("PRECONDITION");
  });

  it("I9: an already-expired token accepts an expiry extension and verifies again", async () => {
    const issued = await managedProjectToken({
      expiresAt: new Date(Date.now() - 3_600_000),
    });

    await expect(verifyToken(issued.secret, db)).rejects.toBeInstanceOf(
      TokenAuthError,
    );

    const result = await updateProjectToken(
      { tokenId: issued.tokenId, projectId },
      { expiresAt: new Date(Date.now() + 3_600_000) },
      actor(),
      db,
    );

    expect(result.outcome).toBe("updated");

    const verified = await verifyToken(issued.secret, db);

    expect(verified.tokenId).toBe(issued.tokenId);

    const changes = (await lifecycleRows(issued.tokenId)).filter(
      (r: any) => r.event === "expiry_changed",
    );

    expect(changes).toHaveLength(1);
  });

  it("I11: a reserved run-bound name is refused CONFIG by the service", async () => {
    const issued = await managedProjectToken();

    for (const name of [
      `orchestrator-run:${randomUUID()}`,
      `agent-run:${randomUUID()}`,
      `AGENT-RUN:${randomUUID()}`,
      // Untrimmed: the project POST schema has no `.trim()`, so the guard must
      // not depend on the caller having trimmed for it.
      ` orchestrator-run:${randomUUID()}`,
      `\tagent-run:${randomUUID()}`,
    ]) {
      const err = await updateProjectToken(
        { tokenId: issued.tokenId, projectId },
        { name },
        actor(),
        db,
      ).catch((e) => e);

      expect(isMaisterError(err) && err.code).toBe("CONFIG");
    }

    expect((await tokenRow(issued.tokenId)).name).toBe(issued.name);
  });

  it("I12: issueOrchestratorRunToken and issueAgentRunToken still mint their reserved names", async () => {
    const orchestratorRunId = randomUUID();
    const agentRunId = randomUUID();

    const orchestratorToken = await issueOrchestratorRunToken({
      projectId,
      runId: orchestratorRunId,
      db,
    });
    const agentToken = await issueAgentRunToken({
      agentId,
      projectId,
      runId: agentRunId,
      db,
    });

    expect((await tokenRow(orchestratorToken.tokenId)).name).toBe(
      `orchestrator-run:${orchestratorRunId}`,
    );
    expect((await tokenRow(agentToken.tokenId)).name).toBe(
      `agent-run:${agentRunId}`,
    );
  });

  it("I13: a cross-project tokenId is not-found and never mutated", async () => {
    const issued = await managedProjectToken({ scopes: ["tasks:read"] });

    const result = await updateProjectToken(
      { tokenId: issued.tokenId, projectId: otherProjectId },
      { scopes: ["runs:read"] },
      actor(),
      db,
    );

    expect(result.outcome).toBe("not-found");
    expect((await tokenRow(issued.tokenId)).scopes).toEqual(["tasks:read"]);
    expect(
      (await lifecycleRows(issued.tokenId)).filter(
        (r: any) => r.event === "scopes_changed",
      ),
    ).toHaveLength(0);
  });

  it("I14: another user's personal token is not-found via the account path", async () => {
    const issued = await managedOwnerToken(otherUserId, {
      scopes: ["tasks:read"],
    });

    const result = await updateOwnerToken(
      { tokenId: issued.tokenId, ownerUserId: userId },
      { scopes: ["runs:read"] },
      actor(),
      db,
    );

    expect(result.outcome).toBe("not-found");
    expect((await tokenRow(issued.tokenId)).scopes).toEqual(["tasks:read"]);
  });

  it("I19: humanHitl absent preserves an existing hitl:respond:human across a scopes patch", async () => {
    const issued = await managedOwnerToken(userId, {
      scopes: ["tasks:read", "hitl:respond:human"],
    });

    const result = await updateOwnerToken(
      { tokenId: issued.tokenId, ownerUserId: userId },
      { scopes: ["runs:read"] },
      actor(),
      db,
    );

    expect(result.outcome).toBe("updated");
    expect((await tokenRow(issued.tokenId)).scopes).toEqual([
      "runs:read",
      "hitl:respond:human",
    ]);
  });

  it("I20: expiresAt null clears expiry while an absent expiresAt preserves it", async () => {
    const expiry = new Date(Date.now() + 86_400_000);
    const issued = await managedProjectToken({ expiresAt: expiry });

    await updateProjectToken(
      { tokenId: issued.tokenId, projectId },
      { name: "Renamed, expiry untouched" },
      actor(),
      db,
    );

    expect((await tokenRow(issued.tokenId)).expires_at?.toISOString()).toBe(
      expiry.toISOString(),
    );

    await updateProjectToken(
      { tokenId: issued.tokenId, projectId },
      { expiresAt: null },
      actor(),
      db,
    );

    expect((await tokenRow(issued.tokenId)).expires_at).toBeNull();
  });

  it("I21: a non-managed token never appears in token_lifecycle_events on any path", async () => {
    const orchestratorRunId = randomUUID();
    const agentRunId = randomUUID();

    const orchestrator = await issueOrchestratorRunToken({
      projectId,
      runId: orchestratorRunId,
      db,
    });
    const agent = await issueAgentRunToken({
      agentId,
      projectId,
      runId: agentRunId,
      db,
    });

    await revokeOrchestratorRunTokensForRun(orchestratorRunId, db);
    await revokeAgentRunToken(agent.tokenId, db);

    expect(await lifecycleRows(orchestrator.tokenId)).toHaveLength(0);
    expect(await lifecycleRows(agent.tokenId)).toHaveLength(0);

    const nonManaged = await db
      .select({ tokenId: schema.tokenLifecycleEvents.token_id })
      .from(schema.tokenLifecycleEvents)
      .innerJoin(
        schema.projectTokens,
        eq(schema.tokenLifecycleEvents.token_id, schema.projectTokens.id),
      )
      .where(eq(schema.projectTokens.token_kind, "agent"));

    expect(nonManaged).toHaveLength(0);
  });
});

// T2.5. Not a D13 invariant — the acceptance of the one-line predicate
// hardening that makes D11's "machine revokes only ever touch non-managed
// tokens" true rather than merely conventional. Both halves are the same
// invariant (the predicate narrows to agent kind), so they share one test.
describe("lib/agents/tokens — revokeAgentRunToken predicate", () => {
  it("is a no-op against a managed token id and still revokes agent tokens", async () => {
    const managed = await managedProjectToken();

    await revokeAgentRunToken(managed.tokenId, db);

    expect((await tokenRow(managed.tokenId)).revoked_at).toBeNull();

    const agent = await issueAgentRunToken({
      agentId,
      projectId,
      runId: randomUUID(),
      db,
    });

    await revokeAgentRunToken(agent.tokenId, db);

    expect((await tokenRow(agent.tokenId)).revoked_at).not.toBeNull();
  });
});

// T2.3 acceptance. Revocation is a one-way transition, so the ledger must carry
// exactly one `revoked` row for a token no matter how many times the route is
// called — the DELETE route is idempotent (204 on both outcomes) and callers do
// retry it.
describe("lib/tokens/revoke — lifecycle ledger", () => {
  it("writes exactly one revoked row however many times revoke is called", async () => {
    const issued = await managedProjectToken();

    await revokeToken({ tokenId: issued.tokenId, projectId }, db, actor());
    await revokeToken({ tokenId: issued.tokenId, projectId }, db, actor());

    const revoked = (await lifecycleRows(issued.tokenId)).filter(
      (r: any) => r.event === "revoked",
    );

    expect(revoked).toHaveLength(1);
    expect(revoked[0].actor_user_id).toBe(userId);
  });
});
