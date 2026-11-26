import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";

import { and, eq, isNull, sql } from "drizzle-orm";

import {
  flowRevisions,
  projectDependencySetupReceipts as receipts,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";

export interface SetupIdentity {
  kind: "flow" | "capability";
  target: string;
  revision: string;
  contentWitness?: string | null;
}

export function physicalSetupKey(input: SetupIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify(["setup-v2", input.target, input.kind, input.revision]),
    )
    .digest("hex");
}

export function legacySetupKey(input: SetupIdentity, script: Buffer): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.target,
        input.revision,
        input.contentWitness ?? input.revision,
        basename(input.target),
      ]),
    )
    .update(script)
    .digest("hex");
}

/** A newly published cache has a platform-owned sibling seal. Existing
 * directories and retained owners never acquire this designation by adoption. */
async function isNewPublication(
  db: Db,
  input: SetupIdentity,
): Promise<boolean> {
  let seal: unknown;

  try {
    seal = JSON.parse(await readFile(input.target + ".material", "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (
    !Array.isArray(seal) ||
    (seal.length !== 3 &&
      !(
        seal.length === 4 &&
        typeof seal[3] === "string" &&
        /^[a-f0-9]{64}$/.test(seal[3])
      )) ||
    seal[2] !== "new-cache-v2" ||
    typeof seal[1] !== "string" ||
    !/^[a-f0-9]{64}$/.test(seal[1])
  )
    return false;
  let revision = input.revision;

  if (input.kind === "flow") {
    const [native] = await db
      .select({ revision: flowRevisions.resolvedRevision })
      .from(flowRevisions)
      .where(eq(flowRevisions.id, input.revision));

    if (!native) return false;
    revision = native.revision;
  }
  if (
    seal[0] !== revision ||
    (input.contentWitness && input.contentWitness !== seal[1])
  )
    return false;
  // A previously dispatched worker can predate the native member row. Retain
  // its exact member/revision evidence even if its original cache was removed.
  const member = input.kind + ":" + basename(input.target).split("@")[0];
  const history =
    await db.execute(sql`SELECT 1 FROM project_dependency_attempts a
    JOIN project_dependency_setup_receipts r ON r.material_key=a.checkpoint->>'setupMaterialKey'
    WHERE r.physical_key IS NULL AND a.member_ref=${member} AND a.resolved_revision=${revision} LIMIT 1`);

  if (history.rows.length) return false;
  const logicalId = basename(input.target).split("@")[0];
  const earlier = await db.execute(sql`WITH prior AS (
    SELECT max(updated_at) AS latest FROM project_dependency_setup_receipts WHERE physical_key IS NULL
  ) SELECT 1 FROM prior WHERE EXISTS (
    SELECT 1 FROM flow_revisions f WHERE ${input.kind}='flow' AND f.flow_ref_id=${logicalId}
      AND f.resolved_revision=${revision} AND f.installed_at<=prior.latest
  ) OR EXISTS (
    SELECT 1 FROM capability_imports c WHERE ${input.kind}='capability' AND c.capability_ref_id=${logicalId}
      AND c.resolved_revision=${revision} AND c.created_at<=prior.latest
  )`);

  return !earlier.rows.length;
}

/** Old receipt keys are irreversible hashes. A matching native revision and
 * script can identify one across projects. An unidentified dispatch cannot
 * positively exclude ownership of the proposed target. */
export async function identifyHistoricalSetups(
  db: Db,
  current: SetupIdentity,
  script: Buffer | null,
): Promise<void> {
  const pending = await db
    .select({ key: receipts.materialKey })
    .from(receipts)
    .where(isNull(receipts.physicalKey));

  if (!pending.length) return;
  const keys = new Set(pending.map((r) => r.key));

  async function identify(input: SetupIdentity, bytes: Buffer) {
    const legacy = legacySetupKey(input, bytes);

    if (!keys.has(legacy)) return;
    await db
      .update(receipts)
      .set({
        physicalKey: physicalSetupKey(input),
        scriptDigest: createHash("sha256").update(bytes).digest("hex"),
        contentWitness: input.contentWitness ?? null,
      })
      .where(
        and(eq(receipts.materialKey, legacy), isNull(receipts.physicalKey)),
      );
    keys.delete(legacy);
  }
  if (script) await identify(current, script);
  if (!keys.size) return;
  const [alreadyBound] = await db
    .select({ key: receipts.materialKey })
    .from(receipts)
    .where(eq(receipts.physicalKey, physicalSetupKey(current)));

  if (alreadyBound || (await isNewPublication(db, current))) return;
  const candidates = await db.execute<{
    kind: "flow" | "capability";
    target: string;
    revision: string;
    witness: string | null;
  }>(sql`
    SELECT 'flow'::text AS kind, installed_path AS target, id AS revision, NULL::text AS witness FROM flow_revisions
    UNION
    SELECT 'capability', installed_path, resolved_revision, manifest->>'contentWitness' FROM capability_imports`);

  for (const row of candidates.rows) {
    try {
      const path = await realpath(row.target);

      await identify(
        {
          kind: row.kind,
          target: path,
          revision: row.revision,
          contentWitness: row.witness,
        },
        await readFile(join(path, "setup.sh")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!keys.size) return;
  }
  const [bound] = await db
    .select({ key: receipts.materialKey })
    .from(receipts)
    .where(eq(receipts.physicalKey, physicalSetupKey(current)));

  if (bound) return;
  throw new MaisterError(
    "CONFLICT",
    "A historical setup receipt cannot be mapped to verified material. Restore the original cached inputs to reconcile it.",
    {
      details: { reason: "legacy_setup_evidence_unmapped" },
    },
  );
}
