import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schemaModule from "@/lib/db/schema";
import { hashToken } from "@/lib/tokens/secret";
import { issueToken } from "@/lib/tokens/issue";
import {
  verifyToken,
  TokenAuthError,
  type TokenActor,
} from "@/lib/tokens/verify";
import { recordTokenAudit, bumpTokenLastUsed } from "@/lib/tokens/audit";
import { revokeToken } from "@/lib/tokens/revoke";
import { listTokens, type TokenListItem } from "@/lib/tokens/list";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("tokens_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("lib/tokens — integration (testcontainers)", () => {
  let projectId: string;
  let userId: string;

  beforeAll(async () => {
    projectId = randomUUID();
    userId = randomUUID();

    await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
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
      await revokeToken({ tokenId: issued.tokenId, projectId }, db);

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

      await revokeToken({ tokenId: issued.tokenId, projectId }, db);

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

      await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
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

      await revokeToken({ tokenId: issued.tokenId, projectId }, db);
      const secondResult = await revokeToken(
        { tokenId: issued.tokenId, projectId },
        db,
      );

      expect(secondResult.outcome).toBe("already-revoked");
    });

    it("returns 'not-found' for unknown tokenId", async () => {
      const unknownTokenId = randomUUID();

      const result = await revokeToken(
        { tokenId: unknownTokenId, projectId },
        db,
      );

      expect(result.outcome).toBe("not-found");
    });

    it("returns 'not-found' for cross-project tokenId (existence-hide)", async () => {
      const projectId2 = randomUUID();

      await db.insert(schema.projects).values({ taskKey: `T${crypto.randomUUID().slice(0, 8)}`.toUpperCase(),
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
        db,
      );

      expect(result.outcome).toBe("not-found");
    });
  });
});
