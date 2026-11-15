/* eslint-disable no-console */
// Seeds two company assignments for the admin plus an unrelated user's token,
// and prints their identifiers as JSON. Run with the server-only shim; the
// caller points HOME at a disposable directory for the package cache.
import type { Db } from "@/lib/execution-host/db";

import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";

import { createE2EDbPool } from "./db";

import { resolvePostgresDbUrl } from "@/lib/db/postgres-url";
import { createSpecialistAssignment } from "@/lib/specialist-assignments/store";
import { issueUserAccessToken } from "@/lib/tokens/issue";
import { prepareCompanySpecialistAssignment } from "@/test-support/specialist-assignment-seed";

async function main(): Promise<void> {
  const [adminEmail, marker, objective, otherObjective] = process.argv.slice(2);
  const pool = createE2EDbPool(resolvePostgresDbUrl());

  try {
    const db = drizzle(pool) as unknown as Db;
    const adminId = (
      await pool.query<{ id: string }>("SELECT id FROM users WHERE email=$1", [
        adminEmail,
      ])
    ).rows[0]!.id;
    const outsiderId = randomUUID();

    await pool.query(
      "INSERT INTO users(id,email,role,account_status) VALUES($1,$2,'member','active')",
      [outsiderId, `${outsiderId}@example.test`],
    );
    const prepared = await prepareCompanySpecialistAssignment(db, {
      administratorId: adminId,
      requesterId: adminId,
      version: `rah/e2e-${marker}`,
    });
    const assignment = await createSpecialistAssignment(db, adminId, {
      ...prepared,
      objectiveInput: { ...prepared.objectiveInput, objective },
    });
    const other = await createSpecialistAssignment(db, adminId, {
      ...prepared,
      objectiveInput: { ...prepared.objectiveInput, objective: otherObjective },
      origin: { kind: "manual", interactionId: randomUUID() },
    });
    const token = await issueUserAccessToken(
      {
        ownerUserId: outsiderId,
        name: `e2e-outsider-${marker}`,
        scopes: ["assignments:read", "assignments:cancel"],
      },
      db,
    );

    console.log(
      JSON.stringify({
        assignmentId: assignment.id,
        otherAssignmentId: other.id,
        outsiderSecret: token.secret,
      }),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("seed-specialist-assignments failed:", error);
  process.exitCode = 1;
});
