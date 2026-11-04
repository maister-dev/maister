import { randomUUID } from "node:crypto";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { generateToken, hashToken } from "@/lib/tokens/secret";
import { issueToken } from "@/lib/tokens/issue";
import { updateProjectToken } from "@/lib/tokens/update";
import {
  verifyToken,
  TokenAuthError,
  type TokenActor,
} from "@/lib/tokens/verify";
import { recordTokenAudit, bumpTokenLastUsed } from "@/lib/tokens/audit";
import { revokeToken, SYSTEM_REVOKE_ACTOR } from "@/lib/tokens/revoke";
import { listTokens, type TokenListItem } from "@/lib/tokens/list";
import { tokenHasScope } from "@/lib/tokens/scopes";
import {
  issueOrchestratorRunToken,
  ORCHESTRATOR_TOKEN_SCOPES,
} from "@/lib/agents/tokens";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = schemaModule as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "tokens_test",
  });

  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

describe("lib/tokens — integration (testcontainers)", () => {
  let projectId: string;
  let userId: string;

  beforeAll(async () => {
    projectId = randomUUID();
    userId = randomUUID();

    await db.insert(schema.projects).values({
      taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
      id: projectId,
      slug: "test-project",
      name: "Test Project",
      repoPath: "/tmp/test",
      maisterYamlPath: "/tmp/test/maister.yaml",
    });

    await db.insert(schema.users).values({
      id: userId,
      name: "Test Owner",
      email: "test@example.com",
      role: "member",
      accountStatus: "active",
      passwordHash: "x",
    });
  });

  describe("issueToken + verifyToken round-trip", () => {
    it("machine issuance records a durable Run binding independently of its display name", async () => {
      const runId = randomUUID();

      await db.insert(schema.runs).values({
        id: runId,
        projectId,
        runKind: "flow",
        flowVersion: "v1",
        status: "Running",
      });
      const issued = await issueOrchestratorRunToken({ projectId, runId, db });
      const result = await testDatabase.pool.query<{
        boundRunId: string | null;
        originKind: string | null;
      }>(
        `SELECT to_jsonb(t)->>'bound_run_id' AS "boundRunId", to_jsonb(t)->>'origin_kind' AS "originKind" FROM project_tokens t WHERE id=$1`,
        [issued.tokenId],
      );

      expect(result.rows).toEqual([
        { boundRunId: runId, originKind: "orchestrator_run" },
      ]);
    });

    it("keeps rotated credentials unusable over HTTP and explicitly revokes the exact stored family without changing first retirement time", async () => {
      const runId = randomUUID();

      await db.insert(schema.runs).values({
        id: runId,
        projectId,
        runKind: "flow",
        flowVersion: "v1",
        status: "Running",
      });
      const first = await issueOrchestratorRunToken({ projectId, runId, db });

      await testDatabase.pool.query(
        "UPDATE project_tokens SET name='renamed-private' WHERE id=$1",
        [first.tokenId],
      );
      await expect(
        updateProjectToken(
          { projectId, tokenId: first.tokenId },
          { scopes: ["runs:delegate"] },
          SYSTEM_REVOKE_ACTOR,
          db,
        ),
      ).rejects.toMatchObject({ code: "PRECONDITION" });
      expect(
        (await listTokens(projectId, db)).some(
          (row) => row.id === first.tokenId,
        ),
      ).toBe(false);
      expect((await verifyToken(first.secret, db)).boundRunId).toBe(runId);
      const second = await issueOrchestratorRunToken({ projectId, runId, db });
      const retired = await testDatabase.pool.query<{
        revoked_at: Date;
        revocation_reason: string;
      }>(
        "SELECT revoked_at,revocation_reason FROM project_tokens WHERE id=$1",
        [first.tokenId],
      );

      expect(retired.rows[0]!.revocation_reason).toBe("rotation");
      await expect(verifyToken(first.secret, db)).rejects.toMatchObject({
        kind: "revoked",
      });
      expect((await verifyToken(second.secret, db)).boundRunId).toBe(runId);
      expect(
        await revokeToken(
          { projectId, tokenId: first.tokenId },
          SYSTEM_REVOKE_ACTOR,
          db,
        ),
      ).toEqual({ outcome: "revoked" });
      await expect(verifyToken(second.secret, db)).rejects.toMatchObject({
        kind: "revoked",
      });
      const final = await testDatabase.pool.query<{
        id: string;
        revoked_at: Date;
        revocation_reason: string;
      }>(
        "SELECT id,revoked_at,revocation_reason FROM project_tokens WHERE bound_run_id=$1",
        [runId],
      );

      expect(final.rows).toHaveLength(2);
      expect(
        final.rows.every((row) => row.revocation_reason === "revoked"),
      ).toBe(true);
      expect(
        final.rows.find((row) => row.id === first.tokenId)!.revoked_at,
      ).toEqual(retired.rows[0]!.revoked_at);
      await expect(
        testDatabase.pool.query(
          "UPDATE project_tokens SET revocation_reason='rotation' WHERE id=$1",
          [first.tokenId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        testDatabase.pool.query(
          "UPDATE project_tokens SET revoked_at=NULL,revocation_reason=NULL WHERE id=$1",
          [first.tokenId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      expect(
        (await listTokens(projectId, db)).some(
          (row) => row.id === first.tokenId,
        ),
      ).toBe(false);
    });

    it("retires an unstamped private legacy generation without inventing origin and preserves same-name project/kind/scope peers", async () => {
      const runId = randomUUID();
      const otherProjectId = randomUUID();

      await db.insert(schema.runs).values({
        id: runId,
        projectId,
        runKind: "flow",
        flowVersion: "v1",
        status: "Running",
      });
      await db.insert(schema.projects).values({
        id: otherProjectId,
        slug: otherProjectId,
        name: "Peer",
        taskKey: `P${otherProjectId.slice(0, 6)}`.toUpperCase(),
        repoPath: "/tmp/peer",
        maisterYamlPath: "/tmp/peer/maister.yaml",
      });
      const rows = [
        {
          project_id: projectId,
          token_kind: "project",
          scopes: [...ORCHESTRATOR_TOKEN_SCOPES],
          owner_user_id: null,
        },
        {
          project_id: otherProjectId,
          token_kind: "project",
          scopes: [...ORCHESTRATOR_TOKEN_SCOPES],
          owner_user_id: null,
        },
        {
          project_id: projectId,
          token_kind: "project",
          scopes: ["tasks:read"],
          owner_user_id: null,
        },
        {
          project_id: projectId,
          token_kind: "user",
          scopes: [...ORCHESTRATOR_TOKEN_SCOPES],
          owner_user_id: userId,
        },
      ].map((row) => ({
        ...row,
        id: randomUUID(),
        name: `orchestrator-run:${runId}`,
        ...generateToken(),
        expires_at: new Date(Date.now() + 60_000),
      }));

      for (const row of rows)
        await db.insert(schema.projectTokens).values({
          id: row.id,
          name: row.name,
          project_id: row.project_id,
          token_kind: row.token_kind,
          owner_user_id: row.owner_user_id,
          scopes: row.scopes,
          prefix: row.prefix,
          token_hash: row.hash,
          expires_at: row.expires_at,
        });
      await issueOrchestratorRunToken({ projectId, runId, db });
      const retired = await testDatabase.pool.query<{
        revoked_at: Date | null;
        origin_kind: string | null;
        bound_run_id: string | null;
        revocation_reason: string | null;
      }>(
        "SELECT revoked_at,origin_kind,bound_run_id,revocation_reason FROM project_tokens WHERE id=$1",
        [rows[0]!.id],
      );

      expect(retired.rows[0]).toMatchObject({
        origin_kind: null,
        bound_run_id: null,
        revocation_reason: "revoked",
      });
      expect(retired.rows[0]!.revoked_at).toBeInstanceOf(Date);
      for (const peer of rows.slice(1))
        expect((await verifyToken(peer.secret, db)).tokenId).toBe(peer.id);
      await expect(
        testDatabase.pool.query(
          "UPDATE project_tokens SET origin_kind='orchestrator_run',bound_run_id=$2 WHERE id=$1",
          [rows[0]!.id, runId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("issues a token and verifies it successfully", async () => {
      const issued = await issueToken(
        {
          projectId,
          name: "Test API Token",
          createdByUserId: userId,
        },
        db,
      );

      expect(issued).toMatchObject({
        tokenId: expect.any(String),
        secret: expect.stringMatching(/^mai_/),
        prefix: expect.any(String),
        name: "Test API Token",
        createdAt: expect.any(Date),
      });

      // Verify the token
      const actor: TokenActor = await verifyToken(issued.secret, db);

      expect(actor).toMatchObject({
        tokenId: issued.tokenId,
        projectId,
        actorLabel: `token:Test API Token`,
        scopes: ["*"],
      });
    });

    it("issues a user-owned token with explicit scopes and verifies owner metadata", async () => {
      const issued = await issueToken(
        {
          projectId,
          name: "Personal webhook",
          createdByUserId: userId,
          tokenKind: "user",
          ownerUserId: userId,
          scopes: ["tasks:create"],
        },
        db,
      );

      const tokenRows = await db
        .select()
        .from(schema.projectTokens)
        .where(eq(schema.projectTokens.id, issued.tokenId))
        .limit(1);

      expect(tokenRows[0]).toMatchObject({
        token_kind: "user",
        owner_user_id: userId,
        scopes: ["tasks:create"],
      });

      const actor: TokenActor = await verifyToken(issued.secret, db);

      expect(actor).toMatchObject({
        tokenId: issued.tokenId,
        projectId,
        tokenKind: "user",
        ownerUserId: userId,
        actorLabel: "token:Personal webhook",
        scopes: ["tasks:create"],
      });
    });
  });

  describe("verifyToken error cases", () => {
    it("throws TokenAuthError('invalid') for unknown token prefix", async () => {
      const unknownToken = "mai_unknown1234567890";

      await expect(verifyToken(unknownToken, db)).rejects.toThrow(
        TokenAuthError,
      );
      try {
        await verifyToken(unknownToken, db);
        throw new Error("should have thrown");
      } catch (err) {
        if (err instanceof TokenAuthError) {
          expect(err.kind).toBe("invalid");
        } else {
          throw err;
        }
      }
    });

    it("throws TokenAuthError('invalid') for hash mismatch (right prefix, wrong secret)", async () => {
      const issued = await issueToken(
        {
          projectId,
          name: "Hash Mismatch Token",
          createdByUserId: userId,
        },
        db,
      );

      // Tamper with the secret but keep the prefix
      const tamperedSecret = issued.prefix + "corrupted_suffix_here";

      await expect(verifyToken(tamperedSecret, db)).rejects.toThrow(
        TokenAuthError,
      );
      try {
        await verifyToken(tamperedSecret, db);
        throw new Error("should have thrown");
      } catch (err) {
        if (err instanceof TokenAuthError) {
          expect(err.kind).toBe("invalid");
        } else {
          throw err;
        }
      }
    });

    it("throws TokenAuthError('expired') for an expired token", async () => {
      const pastDate = new Date();

      pastDate.setHours(pastDate.getHours() - 1);

      const issued = await issueToken(
        {
          projectId,
          name: "Expired Token",
          createdByUserId: userId,
          expiresAt: pastDate,
        },
        db,
      );

      await expect(verifyToken(issued.secret, db)).rejects.toThrow(
        TokenAuthError,
      );
      try {
        await verifyToken(issued.secret, db);
        throw new Error("should have thrown");
      } catch (err) {
        if (err instanceof TokenAuthError) {
          expect(err.kind).toBe("expired");
        } else {
          throw err;
        }
      }
    });

    it("throws TokenAuthError('revoked') for a revoked token", async () => {
      const issued = await issueToken(
        {
          projectId,
          name: "Revoked Token",
          createdByUserId: userId,
        },
        db,
      );

      // Revoke the token
      await revokeToken(
        { tokenId: issued.tokenId, projectId },
        SYSTEM_REVOKE_ACTOR,
        db,
      );

      await expect(verifyToken(issued.secret, db)).rejects.toThrow(
        TokenAuthError,
      );
      try {
        await verifyToken(issued.secret, db);
        throw new Error("should have thrown");
      } catch (err) {
        if (err instanceof TokenAuthError) {
          expect(err.kind).toBe("revoked");
        } else {
          throw err;
        }
      }
    });

    it("prefers 'revoked' over 'expired' when a token is both revoked AND past expiry", async () => {
      const pastDate = new Date();

      pastDate.setHours(pastDate.getHours() - 1);

      const issued = await issueToken(
        {
          projectId,
          name: "Revoked + Expired Token",
          createdByUserId: userId,
          expiresAt: pastDate,
        },
        db,
      );

      await revokeToken(
        { tokenId: issued.tokenId, projectId },
        SYSTEM_REVOKE_ACTOR,
        db,
      );

      try {
        await verifyToken(issued.secret, db);
        throw new Error("should have thrown");
      } catch (err) {
        if (err instanceof TokenAuthError) {
          // verify.ts checks revoked_at before expires_at — revoked wins.
          expect(err.kind).toBe("revoked");
        } else {
          throw err;
        }
      }
    });

    it("fails closed for a user token whose owner is disabled", async () => {
      const disabledUserId = randomUUID();

      await db.insert(schema.users).values({
        id: disabledUserId,
        email: `disabled-token-owner-${disabledUserId.slice(0, 8)}@example.test`,
        name: "Disabled Token Owner",
        role: "member",
        accountStatus: "disabled",
      });

      const issued = await issueToken(
        {
          projectId,
          name: "Disabled owner user token",
          ownerUserId: disabledUserId,
          createdByUserId: userId,
          scopes: ["tasks:read"],
          tokenKind: "user",
        },
        db,
      );

      await expect(verifyToken(issued.secret, db)).rejects.toMatchObject({
        kind: "owner-unavailable",
      });
    });

    it("fails closed for a user token whose owner must change password", async () => {
      const resetUserId = randomUUID();

      await db.insert(schema.users).values({
        id: resetUserId,
        email: `reset-token-owner-${resetUserId.slice(0, 8)}@example.test`,
        name: "Reset Token Owner",
        role: "member",
        accountStatus: "active",
        mustChangePassword: true,
      });

      const issued = await issueToken(
        {
          projectId,
          name: "Password reset owner user token",
          ownerUserId: resetUserId,
          createdByUserId: userId,
          scopes: ["tasks:read"],
          tokenKind: "user",
        },
        db,
      );

      await expect(verifyToken(issued.secret, db)).rejects.toMatchObject({
        kind: "owner-unavailable",
      });
    });

    it("database rejects manually inserted user tokens without an owner", async () => {
      const { prefix, hash } = generateToken();

      await expect(
        db.insert(schema.projectTokens).values({
          id: randomUUID(),
          project_id: projectId,
          name: "Ownerless user token",
          token_kind: "user",
          owner_user_id: null,
          prefix,
          token_hash: hash,
          scopes: ["tasks:read"],
        }),
      ).rejects.toThrow();
    });
  });

  describe("scope helpers", () => {
    it("does not let wildcard satisfy the exact human HITL response scope", () => {
      expect(tokenHasScope(["*"], "hitl:respond:human")).toBe(false);
      expect(tokenHasScope(["hitl:respond:human"], "hitl:respond:human")).toBe(
        true,
      );
    });
  });

  describe("token_hash storage", () => {
    it("stores only the sha256 hash, never the plaintext secret", async () => {
      const issued = await issueToken(
        {
          projectId,
          name: "Hash Storage Token",
          createdByUserId: userId,
        },
        db,
      );

      // Query the token row directly
      const row = await db
        .select()
        .from(schema.projectTokens)
        .where(eq(schema.projectTokens.id, issued.tokenId))
        .limit(1);

      expect(row).toHaveLength(1);
      const token = row[0];

      // Verify hash is stored
      expect(token.token_hash).toBe(hashToken(issued.secret));

      // Verify plaintext secret is NOT stored
      expect(token.token_hash).not.toBe(issued.secret);
      expect(token).not.toHaveProperty("secret");
    });
  });

  describe("recordTokenAudit", () => {
    it("writes exactly one audit log row with the given fields", async () => {
      const issued = await issueToken(
        {
          projectId,
          name: "Audit Token",
          createdByUserId: userId,
        },
        db,
      );

      await recordTokenAudit(
        {
          tokenId: issued.tokenId,
          projectId,
          actorLabel: `token:${issued.name}`,
          scopeUsed: "tasks:create",
          endpoint: "POST /api/v1/ext/projects/test/tasks",
          method: "POST",
          result: "ok",
          statusCode: 201,
        },
        db,
      );

      // Query the audit log
      const auditRows = await db
        .select()
        .from(schema.tokenAuditLog)
        .where(eq(schema.tokenAuditLog.token_id, issued.tokenId));

      expect(auditRows).toHaveLength(1);
      const audit = auditRows[0];

      expect(audit).toMatchObject({
        token_id: issued.tokenId,
        project_id: projectId,
        actor_label: `token:${issued.name}`,
        scope_used: "tasks:create",
        endpoint: "POST /api/v1/ext/projects/test/tasks",
        method: "POST",
        result: "ok",
        status_code: 201,
      });
    });
  });

  describe("bumpTokenLastUsed", () => {
    it("updates last_used_at to now()", async () => {
      const issued = await issueToken(
        {
          projectId,
          name: "Bump Token",
          createdByUserId: userId,
        },
        db,
      );

      const beforeBump = await db
        .select()
        .from(schema.projectTokens)
        .where(eq(schema.projectTokens.id, issued.tokenId))
        .limit(1);

      expect(beforeBump[0].last_used_at).toBeNull();

      await bumpTokenLastUsed(issued.tokenId, db);

      const afterBump = await db
        .select()
        .from(schema.projectTokens)
        .where(eq(schema.projectTokens.id, issued.tokenId))
        .limit(1);

      expect(afterBump[0].last_used_at).not.toBeNull();
    });
  });

  describe("listTokens", () => {
    it("returns TokenListItem[] without hash or secret", async () => {
      await issueToken(
        {
          projectId,
          name: "List Token 1",
          createdByUserId: userId,
        },
        db,
      );

      await issueToken(
        {
          projectId,
          name: "List Token 2",
          createdByUserId: userId,
        },
        db,
      );

      const items = await listTokens(projectId, db);

      expect(items.length).toBeGreaterThanOrEqual(2);
      items.forEach((item: TokenListItem) => {
        expect(item).toHaveProperty("id");
        expect(item).toHaveProperty("name");
        expect(item).toHaveProperty("kind");
        expect(item).toHaveProperty("ownerUserId");
        expect(item).toHaveProperty("ownerLabel");
        expect(item).toHaveProperty("scopes");
        expect(item).toHaveProperty("prefix");
        expect(item).toHaveProperty("createdAt");
        // NEVER contains hash or secret
        expect(item).not.toHaveProperty("token_hash");
        expect(item).not.toHaveProperty("secret");
        expect((item as any).token_hash).toBeUndefined();
        expect((item as any).secret).toBeUndefined();
      });
    });

    it("returns owner label for user-owned tokens", async () => {
      const issued = await issueToken(
        {
          projectId,
          name: "Owned List Token",
          createdByUserId: userId,
          tokenKind: "user",
          ownerUserId: userId,
          scopes: ["tasks:create"],
        },
        db,
      );

      const items = await listTokens(projectId, db);
      const listed = items.find((item) => item.id === issued.tokenId);

      expect(listed).toMatchObject({
        kind: "user",
        ownerUserId: userId,
        ownerLabel: "Test Owner",
        scopes: ["tasks:create"],
      });
    });

    it("orders tokens by created_at DESC", async () => {
      const projectId2 = randomUUID();

      await db.insert(schema.projects).values({
        taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
        id: projectId2,
        slug: "test-project-2",
        name: "Test Project 2",
        repoPath: "/tmp/test2",
        maisterYamlPath: "/tmp/test2/maister.yaml",
      });

      await issueToken(
        {
          projectId: projectId2,
          name: "Token A",
          createdByUserId: userId,
        },
        db,
      );

      // Slight delay to ensure different created_at times
      await new Promise((resolve) => setTimeout(resolve, 100));

      await issueToken(
        {
          projectId: projectId2,
          name: "Token B",
          createdByUserId: userId,
        },
        db,
      );

      const items = await listTokens(projectId2, db);

      expect(items[0].name).toBe("Token B");
      expect(items[1].name).toBe("Token A");
    });
  });

  describe("revokeToken", () => {
    it("returns 'revoked' on first call", async () => {
      const issued = await issueToken(
        {
          projectId,
          name: "Revoke Token 1",
          createdByUserId: userId,
        },
        db,
      );

      const result = await revokeToken(
        { tokenId: issued.tokenId, projectId },
        SYSTEM_REVOKE_ACTOR,
        db,
      );

      expect(result.outcome).toBe("revoked");
    });

    it("returns 'already-revoked' on second call", async () => {
      const issued = await issueToken(
        {
          projectId,
          name: "Revoke Token 2",
          createdByUserId: userId,
        },
        db,
      );

      await revokeToken(
        { tokenId: issued.tokenId, projectId },
        SYSTEM_REVOKE_ACTOR,
        db,
      );
      const secondResult = await revokeToken(
        { tokenId: issued.tokenId, projectId },
        SYSTEM_REVOKE_ACTOR,
        db,
      );

      expect(secondResult.outcome).toBe("already-revoked");
    });

    it("returns 'not-found' for unknown tokenId", async () => {
      const unknownTokenId = randomUUID();

      const result = await revokeToken(
        { tokenId: unknownTokenId, projectId },
        SYSTEM_REVOKE_ACTOR,
        db,
      );

      expect(result.outcome).toBe("not-found");
    });

    it("returns 'not-found' for cross-project tokenId (existence-hide)", async () => {
      const projectId2 = randomUUID();

      await db.insert(schema.projects).values({
        taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
        id: projectId2,
        slug: "test-project-cross",
        name: "Test Project Cross",
        repoPath: "/tmp/test-cross",
        maisterYamlPath: "/tmp/test-cross/maister.yaml",
      });

      const issued = await issueToken(
        {
          projectId,
          name: "Cross Project Token",
          createdByUserId: userId,
        },
        db,
      );

      // Try to revoke with a different projectId
      const result = await revokeToken(
        { tokenId: issued.tokenId, projectId: projectId2 },
        SYSTEM_REVOKE_ACTOR,
        db,
      );

      expect(result.outcome).toBe("not-found");
    });
  });
});
