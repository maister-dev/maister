import "server-only";

import type { KnowledgeTransaction } from "./knowledge-access";
import type { KnowledgeAccessWalk } from "./knowledge-restrictions";
import type { KnowledgePrincipal, KnowledgeReference } from "./knowledge-types";

import { sql } from "drizzle-orm";

import {
  authorizeKnowledgeRevisionRead,
  unavailableKnowledgeReference,
} from "./knowledge-restrictions";
import { inspectKnowledgeWitness } from "./knowledge-witnesses";

export function matchesReferenceWitness(
  reference: KnowledgeReference,
  revision: number | null,
  version: unknown,
  sha256: unknown,
): boolean {
  return (
    (reference.revision === undefined || reference.revision === revision) &&
    (reference.version === undefined || reference.version === version) &&
    (reference.sha256 === undefined || reference.sha256 === sha256)
  );
}

/** Resolve an exact Brain record revision or immutable witness under current source policy. */
export async function inspectKnowledgeEvidenceReference(
  tx: KnowledgeTransaction,
  principal: KnowledgePrincipal,
  reference: KnowledgeReference,
  access: KnowledgeAccessWalk = { visited: [], remaining: 256 },
): Promise<KnowledgeAccessWalk> {
  if (reference.kind === "knowledge" && reference.revision !== undefined) {
    const authorized = await authorizeKnowledgeRevisionRead(
      tx,
      principal,
      reference.id,
      reference.revision,
      access,
    );
    const row = (
      await tx.execute(
        sql`SELECT content_sha256 FROM brain_record_revisions WHERE record_id=${reference.id} AND revision=${reference.revision}`,
      )
    ).rows[0];

    if (
      !row ||
      !matchesReferenceWitness(
        reference,
        reference.revision,
        String(reference.revision),
        row.content_sha256,
      )
    )
      throw unavailableKnowledgeReference();

    return authorized;
  }
  if (reference.kind === "witness" && reference.revision === undefined) {
    const inspection = await inspectKnowledgeWitness(
      tx,
      principal,
      reference.id,
      access,
    );

    if (
      !matchesReferenceWitness(
        reference,
        null,
        inspection.witness.sourceVersion,
        inspection.witness.sha256,
      )
    )
      throw unavailableKnowledgeReference();

    return inspection.access;
  }
  throw unavailableKnowledgeReference();
}
