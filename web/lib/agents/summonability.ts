import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { type MentionableAgent } from "@/lib/social/mentions";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { agents, agentProjectLinks, agentSchedules } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

/**
 * Run statuses that make a mentioned agent's task already "busy" (ADR-151).
 *
 * A per-concern predicate, deliberately NOT `ACTIVE_RUN_STATUSES` (a
 * portfolio-DISPLAY set). `Pending` belongs here so a summon that queued is
 * not queued twice; `Review` and `Crashed` are deliberately absent because
 * re-mentioning an agent after a finished or dead attempt is the intended
 * rework loop, not a duplicate.
 */
export const MENTION_SUPPRESSION_STATUSES = [
  "Pending",
  "Running",
  "NeedsInput",
  "NeedsInputIdle",
  "HumanWorking",
  "WaitingOnChildren",
] as const;

/**
 * Every agent attached to `projectId`, each carrying `Summonable(agent,
 * project)`.
 *
 * Non-summonable agents are RETURNED, not filtered: a handle naming one still
 * resolves and expands (the chip is historical record) and the comment
 * footnote explains why nothing launched. The consumer re-checks eligibility
 * at consume time, so this flag is a report, never the authorization.
 *
 * This is the ONLY eligibility query for mentions — the write path and the
 * consumer both read it, so the predicate cannot drift between them.
 */
export async function listMentionCandidateAgents(
  dbOrTx: Db | undefined,
  projectId: string,
): Promise<MentionableAgent[]> {
  const _db = (dbOrTx ?? getDb()) as unknown as { select: any };

  const rows = (await _db
    .select({
      id: agents.id,
      name: agents.name,
      packageName: agents.packageName,
      agentEnabled: agents.enabled,
      quarantinedAt: agents.quarantinedAt,
      triggers: agents.triggers,
      linkEnabled: agentProjectLinks.enabled,
      mentionBindings: sql<number>`(
        select count(*) from ${agentSchedules}
        where ${agentSchedules.agentId} = ${agents.id}
          and ${agentSchedules.projectId} = ${agentProjectLinks.projectId}
          and ${agentSchedules.triggerType} = 'mention'
          and ${agentSchedules.enabled} = true
      )`,
    })
    .from(agents)
    .innerJoin(
      agentProjectLinks,
      and(
        eq(agentProjectLinks.agentId, agents.id),
        eq(agentProjectLinks.projectId, projectId),
      ),
    )) as Array<{
    id: string;
    name: string;
    packageName: string;
    agentEnabled: boolean;
    quarantinedAt: Date | null;
    triggers: string[] | null;
    linkEnabled: boolean;
    mentionBindings: number | string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    // The id is `<packageName>:<stem>`; the stem is what a bare handle names.
    stem: row.id.slice(row.packageName.length + 1),
    name: row.name,
    summonable:
      row.linkEnabled &&
      row.agentEnabled &&
      row.quarantinedAt === null &&
      (row.triggers ?? []).includes("domain_event") &&
      Number(row.mentionBindings) > 0,
  }));
}
