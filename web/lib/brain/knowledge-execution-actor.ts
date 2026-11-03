import "server-only";

import type { NativeKnowledgeActor } from "@/lib/company/types";
import type { SqlDatabase } from "@/lib/db/sql-types";

import { sql } from "drizzle-orm";
import pino from "pino";

import { currentKnowledgeNodeAttemptPolicy } from "./knowledge-node-policy";

import {
  knowledgeAccessCaptureSchema,
  nativeKnowledgeActorSchema,
} from "@/lib/company/types";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "knowledge-execution-actor",
  level: process.env.LOG_LEVEL ?? "info",
});

/** Freeze the actually resolved professional role before its first native Flow prompt. */
export async function recordNativeKnowledgeActor(
  db: SqlDatabase,
  input: Readonly<{
    runId: string;
    nodeAttemptId: string;
    actor: NativeKnowledgeActor;
  }>,
): Promise<void> {
  const actor = nativeKnowledgeActorSchema.safeParse(input.actor);

  if (!actor.success)
    throw new MaisterError("CONFIG", "Native Flow role attestation is invalid");
  await db.transaction(async (tx) => {
    const row = (
      await tx.execute(sql`
      SELECT r.project_id,r.knowledge_access,n.knowledge_actor,n.status FROM runs r JOIN node_attempts n ON n.run_id=r.id
      WHERE r.id=${input.runId} AND r.run_kind='flow' AND r.status IN ('Running','NeedsInput','NeedsInputIdle','WaitingOnChildren')
        AND n.id=${input.nodeAttemptId} AND ${currentKnowledgeNodeAttemptPolicy("n", sql`r.id`, sql`r.current_step_id`)}
        AND n.node_type IN ('ai_coding','judge','orchestrator') FOR UPDATE OF r,n
    `)
    ).rows[0];
    const capture = knowledgeAccessCaptureSchema.safeParse(
      row?.knowledge_access,
    );

    if (
      !row ||
      (row.status === "Succeeded" && row.knowledge_actor === null) ||
      !capture.success ||
      capture.data.state !== "complete"
    )
      throw new MaisterError(
        "PRECONDITION",
        "Native Flow role requires an active current attempt and complete server-owned source capture",
        { details: { reason: "knowledge_capture_profile_required" } },
      );
    if (row.knowledge_actor !== null) {
      const prior = nativeKnowledgeActorSchema.safeParse(row.knowledge_actor);

      if (!prior.success)
        throw new MaisterError(
          "CONFIG",
          "Stored native node role attestation is invalid",
        );
      if (contentDigest(prior.data) !== contentDigest(actor.data))
        throw new MaisterError(
          "CONFLICT",
          "The node's executing role or package definition changed; start a fresh attempt to adopt the new identity",
          { details: { reason: "native_knowledge_actor_changed" } },
        );
    }
    const bound = (
      await tx.execute(sql`
      SELECT a.id FROM agents a JOIN project_package_attachments pa ON pa.package_name=a.package_name
      JOIN package_installs pin ON pin.id=pa.package_install_id AND pin.name=a.package_name
      WHERE a.id=${actor.data.agentId} AND a.package_name=${actor.data.packageName} AND a.enabled AND a.quarantined_at IS NULL
        AND pa.project_id=${row.project_id} AND pin.id=${actor.data.packageInstallId} AND pin.package_status='Installed' AND pin.trust_status IN ('trusted','trusted_by_policy')
      FOR SHARE OF a,pa,pin
    `)
    ).rows[0];

    if (!bound)
      throw new MaisterError(
        "UNAUTHORIZED",
        "The native Flow role's current trusted attachment is unavailable",
      );
    if (row.knowledge_actor !== null) return;
    await tx.execute(
      sql`UPDATE node_attempts SET knowledge_actor=${JSON.stringify(actor.data)}::jsonb WHERE id=${input.nodeAttemptId} AND knowledge_actor IS NULL`,
    );
    log.debug(
      {
        runId: input.runId,
        nodeAttemptId: input.nodeAttemptId,
        agentId: actor.data.agentId,
        packageInstallId: actor.data.packageInstallId,
        definitionSha256: actor.data.definitionSha256,
      },
      "native Flow role attested before prompt dispatch",
    );
  });
}
