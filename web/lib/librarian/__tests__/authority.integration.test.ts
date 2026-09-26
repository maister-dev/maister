import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { projectTokens } from "@/lib/db/schema";
import {
  issueLibrarianTurnToken,
  revokeLibrarianTurnToken,
} from "@/lib/librarian/authority";
import {
  actorUserIdForToken,
  socialActorForToken,
  TokenAuthError,
  verifyToken,
} from "@/lib/tokens/verify";
import {
  librarianTurnIdForToken,
  seedActiveUser,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-184: a librarian turn token is minted for one turn, verified per request
// with the owner's live account state, and dies with its turn.

let database: StartedPostgresTestDb;
let db: NodePgDatabase;

async function refusal(secret: string): Promise<string | null> {
  try {
    await verifyToken(secret, db);

    return null;
  } catch (err) {
    return err instanceof TokenAuthError ? err.kind : String(err);
  }
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "librarian_authority",
  });
  db = database.db as unknown as NodePgDatabase;
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

describe("IT-LAU-02 part 2: a turn token is owner-bound and dies with its turn", () => {
  it("verifies as the owner acting through the librarian", async () => {
    const ownerId = await seedActiveUser(db);
    const turnId = librarianTurnIdForToken();
    const issued = await issueLibrarianTurnToken(
      {
        ownerUserId: ownerId,
        turnId,
        scopes: ["tasks:read"],
        expiresAt: new Date(Date.now() + 60_000),
      },
      db,
    );

    const actor = await verifyToken(issued.secret, db);

    expect(actor).toMatchObject({
      tokenKind: "librarian",
      ownerUserId: ownerId,
      projectId: null,
      agentId: null,
      librarianTurnId: turnId,
      actorLabel: `librarian:${ownerId}`,
      boundRunId: null,
      scopes: ["tasks:read"],
    });
    expect(actorUserIdForToken(actor)).toBe(ownerId);
    expect(socialActorForToken(actor)).toEqual({ type: "user", id: ownerId });

    const [row] = await db
      .select()
      .from(projectTokens)
      .where(eq(projectTokens.id, issued.tokenId));

    expect(row.name).toBe(`librarian-turn:${turnId}`);
    expect(row.token_hash).not.toContain(issued.secret);
  });

  it("IT-EDGE-LAU-01: a revoked turn token is refused on its next request", async () => {
    const ownerId = await seedActiveUser(db);
    const turnId = librarianTurnIdForToken();
    const issued = await issueLibrarianTurnToken(
      {
        ownerUserId: ownerId,
        turnId,
        scopes: ["tasks:read"],
        expiresAt: new Date(Date.now() + 60_000),
      },
      db,
    );

    expect(await refusal(issued.secret)).toBeNull();
    expect(await revokeLibrarianTurnToken(turnId, db)).toBe(1);
    expect(await revokeLibrarianTurnToken(turnId, db)).toBe(0);
    expect(await refusal(issued.secret)).toBe("revoked");
  });

  it("refuses an expired turn token", async () => {
    const ownerId = await seedActiveUser(db);
    const turnId = librarianTurnIdForToken();
    const issued = await issueLibrarianTurnToken(
      {
        ownerUserId: ownerId,
        turnId,
        scopes: ["tasks:read"],
        expiresAt: new Date(Date.now() + 60_000),
      },
      db,
    );

    await db
      .update(projectTokens)
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where(eq(projectTokens.id, issued.tokenId));

    expect(await refusal(issued.secret)).toBe("expired");
  });

  it("refuses a wildcard or empty scope grant at issuance", async () => {
    const ownerId = await seedActiveUser(db);

    for (const scopes of [[], ["*"]]) {
      await expect(
        issueLibrarianTurnToken(
          {
            ownerUserId: ownerId,
            turnId: librarianTurnIdForToken(),
            scopes,
            expiresAt: new Date(Date.now() + 60_000),
          },
          db,
        ),
      ).rejects.toMatchObject({ code: "CONFIG" });
    }
  });
});

describe("IT-LAU-10 part 1: owner deactivation applies to a live turn token", () => {
  it("refuses the next request after the owner is disabled or must change password", async () => {
    const ownerId = await seedActiveUser(db);
    const issued = await issueLibrarianTurnToken(
      {
        ownerUserId: ownerId,
        turnId: librarianTurnIdForToken(),
        scopes: ["tasks:read"],
        expiresAt: new Date(Date.now() + 60_000),
      },
      db,
    );

    expect(await refusal(issued.secret)).toBeNull();

    await db.execute(
      sql`UPDATE users SET account_status = 'disabled' WHERE id = ${ownerId}`,
    );
    expect(await refusal(issued.secret)).toBe("owner-unavailable");

    await db.execute(
      sql`UPDATE users SET account_status = 'active', must_change_password = true WHERE id = ${ownerId}`,
    );
    expect(await refusal(issued.secret)).toBe("owner-unavailable");
  });
});
