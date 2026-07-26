import "server-only";

import { and, eq, inArray } from "drizzle-orm";

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

  // THREE single-table reads combined in TS, deliberately NOT one join.
  // `agents`, `agent_project_links` and `agent_schedules` all carry columns
  // named `id` and `enabled`, and under this repo's dual drizzle-orm peer-dep
  // variants (see the FIXME above) a multi-table select mis-mapped those
  // same-named columns in the APP runtime while mapping correctly against the
  // test drizzle instance — every agent came back non-summonable, silently.
  // Flat reads have no ambiguity to get wrong.
  const links = (await _db
    .select({
      agentId: agentProjectLinks.agentId,
      enabled: agentProjectLinks.enabled,
    })
    .from(agentProjectLinks)
    .where(eq(agentProjectLinks.projectId, projectId))) as Array<{
    agentId: string;
    enabled: boolean;
  }>;

  if (links.length === 0) return [];

  const linkEnabledByAgent = new Map(
    links.map((row) => [row.agentId, row.enabled]),
  );
  const attached = (await _db
    .select({
      id: agents.id,
      name: agents.name,
      packageName: agents.packageName,
      enabled: agents.enabled,
      quarantinedAt: agents.quarantinedAt,
      triggers: agents.triggers,
    })
    .from(agents)
    .where(inArray(agents.id, [...linkEnabledByAgent.keys()]))) as Array<{
    id: string;
    name: string;
    packageName: string;
    enabled: boolean;
    quarantinedAt: Date | null;
    triggers: string[] | null;
  }>;

  const bindings = (await _db
    .select({ agentId: agentSchedules.agentId })
    .from(agentSchedules)
    .where(
      and(
        eq(agentSchedules.projectId, projectId),
        eq(agentSchedules.triggerType, "mention"),
        eq(agentSchedules.enabled, true),
      ),
    )) as Array<{ agentId: string }>;
  const bound = new Set(bindings.map((row) => row.agentId));

  return attached.map((row) => ({
    id: row.id,
    // The id is `<packageName>:<stem>`; the stem is what a bare handle names.
    stem: row.id.slice(row.packageName.length + 1),
    name: row.name,
    summonable:
      linkEnabledByAgent.get(row.id) === true &&
      row.enabled &&
      row.quarantinedAt === null &&
      (row.triggers ?? []).includes("domain_event") &&
      bound.has(row.id),
  }));
}
