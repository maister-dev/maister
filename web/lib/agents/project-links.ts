import "server-only";

import type { AgentExecutionPolicyRecommendation } from "@/lib/db/schema";

import { and, eq } from "drizzle-orm";
import pino from "pino";

import {
  assertAgentPackageAttachable,
  listEnabledPackageRefs,
} from "@/lib/agents/effective";
import { revokeAgentProjectTokens } from "@/lib/agents/tokens";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { isDomainEventKind } from "@/lib/domain-events/taxonomy";
import { MaisterError } from "@/lib/errors";
import {
  nextFireAt,
  validateCronExpression,
  validateTimezone,
} from "@/lib/run-schedules/cron";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { agentProjectLinks, agents, agentSchedules, platformAcpRunners } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "agent-project-links",
  level: process.env.LOG_LEVEL ?? "info",
});

export type AgentScheduleInput = {
  triggerType: "cron" | "event";
  cronExpr?: string;
  timezone?: string;
  eventKinds?: string[];
  enabled?: boolean;
};

export type AttachedAgentView = {
  agent: Record<string, unknown>;
  linkId: string;
  enabled: boolean;
  runnerOverrideId: string | null;
  // (ADR-106) Per-instance overrides; null → fall back to the agent
  // `recommended` (then project/platform default). Effective resolution +
  // launch snapshot live in lib/agents/execution-policy.ts (Phase 5).
  branchBase: string | null;
  executionPolicyOverride: AgentExecutionPolicyRecommendation | null;
  schedules: Array<{
    triggerType: "cron" | "event";
    cronExpr?: string;
    timezone?: string;
    eventKinds?: string[];
    enabled: boolean;
  }>;
};

async function validateRunnerOverride(
  db: any,
  runnerId: string,
): Promise<void> {
  const rows = await db
    .select({ id: platformAcpRunners.id })
    .from(platformAcpRunners)
    .where(
      and(
        eq(platformAcpRunners.id, runnerId),
        eq(platformAcpRunners.enabled, true),
      ),
    );

  if (rows.length === 0) {
    throw new MaisterError(
      "CONFIG",
      `runner ${runnerId} is not an enabled catalog runner`,
    );
  }
}

// Validates one trigger binding and computes the cron next_fire_at (the
// dispatcher claims off it). Throws CONFIG — the route maps it to 422.
function normalizeSchedule(
  input: AgentScheduleInput,
  now: Date,
): Record<string, unknown> {
  if (input.triggerType === "cron") {
    if (!input.cronExpr || !input.timezone) {
      throw new MaisterError(
        "CONFIG",
        "cron schedules require cronExpr and timezone",
      );
    }
    validateTimezone(input.timezone);
    validateCronExpression(input.cronExpr, input.timezone);

    return {
      triggerType: "cron",
      cronExpr: input.cronExpr,
      timezone: input.timezone,
      nextFireAt: nextFireAt(input.cronExpr, input.timezone, now),
      eventMatch: null,
      enabled: input.enabled ?? true,
    };
  }

  const kinds = input.eventKinds ?? [];

  if (kinds.length === 0) {
    throw new MaisterError(
      "CONFIG",
      "event schedules require at least one eventKind",
    );
  }
  for (const kind of kinds) {
    if (!isDomainEventKind(kind)) {
      throw new MaisterError("CONFIG", `unknown domain-event kind: ${kind}`);
    }
  }

  return {
    triggerType: "event",
    cronExpr: null,
    timezone: null,
    nextFireAt: null,
    eventMatch: { kinds },
    enabled: input.enabled ?? true,
  };
}

function scheduleToView(row: Record<string, any>): {
  triggerType: "cron" | "event";
  cronExpr?: string;
  timezone?: string;
  eventKinds?: string[];
  enabled: boolean;
} {
  if (row.triggerType === "cron") {
    return {
      triggerType: "cron",
      cronExpr: row.cronExpr as string,
      timezone: row.timezone as string,
      enabled: row.enabled as boolean,
    };
  }

  return {
    triggerType: "event",
    eventKinds: (row.eventMatch?.kinds ?? []) as string[],
    enabled: row.enabled as boolean,
  };
}

export async function getProjectAgentsView(
  projectId: string,
  db?: Db,
): Promise<{
  attached: AttachedAgentView[];
  available: Array<Record<string, unknown>>;
}> {
  const _db = (db ?? getDb()) as unknown as { select: any };

  const linkRows = (await _db
    .select({ link: agentProjectLinks, agent: agents })
    .from(agentProjectLinks)
    .innerJoin(agents, eq(agentProjectLinks.agentId, agents.id))
    .where(eq(agentProjectLinks.projectId, projectId))) as Array<{
    link: Record<string, any>;
    agent: Record<string, any>;
  }>;

  const scheduleRows = (await _db
    .select()
    .from(agentSchedules)
    .where(eq(agentSchedules.projectId, projectId))) as Array<
    Record<string, any>
  >;

  const attached = linkRows.map(({ link, agent }) => ({
    agent,
    linkId: link.id as string,
    enabled: link.enabled as boolean,
    runnerOverrideId: (link.runnerOverrideId ?? null) as string | null,
    branchBase: (link.branchBase ?? null) as string | null,
    executionPolicyOverride: (link.executionPolicyOverride ??
      null) as AgentExecutionPolicyRecommendation | null,
    schedules: scheduleRows
      .filter((s) => s.agentId === agent.id)
      .map(scheduleToView),
  }));

  const linkedIds = new Set(attached.map((a) => a.agent.id as string));

  // Attachable = catalog agents whose providing package is attached to THIS
  // project (ADR-106: attachment IS the enable) and that are not already
  // linked here. enabledRefs is the set of attached package names.
  const enabledRefs = await listEnabledPackageRefs(projectId, _db);
  const catalogAgents = (await _db.select().from(agents)) as Array<
    Record<string, any>
  >;
  const available = catalogAgents.filter(
    (a) => !linkedIds.has(a.id) && enabledRefs.has(a.packageName as string),
  );

  return { attached, available };
}

export async function attachAgent(
  input: {
    projectId: string;
    agentId: string;
    enabled?: boolean;
    runnerOverrideId?: string | null;
  },
  db?: Db,
): Promise<{ linkId: string }> {
  const _db = db ?? getDb();

  const agentRows = await _db
    .select()
    .from(agents)
    .where(eq(agents.id, input.agentId));
  const agent = agentRows[0];

  if (!agent) {
    throw new MaisterError(
      "PRECONDITION",
      `agent ${input.agentId} is not registered`,
    );
  }

  // RD4 attach gate: the providing package must be configured + enabled in
  // the target project, so the attachment can always name its effective
  // definition source.
  await assertAgentPackageAttachable(
    { agentId: input.agentId, projectId: input.projectId },
    _db,
  );

  if (input.runnerOverrideId != null) {
    await validateRunnerOverride(_db, input.runnerOverrideId);
  }

  const inserted = await _db
    .insert(agentProjectLinks)
    .values({
      agentId: input.agentId,
      projectId: input.projectId,
      enabled: input.enabled ?? true,
      runnerOverrideId: input.runnerOverrideId ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: agentProjectLinks.id });

  if (inserted.length === 0) {
    throw new MaisterError(
      "CONFLICT",
      `agent ${input.agentId} is already attached`,
    );
  }

  log.info(
    { agentId: input.agentId, projectId: input.projectId },
    "agent attached to project",
  );

  return { linkId: inserted[0].id as string };
}

export async function updateAgentLink(
  input: {
    projectId: string;
    agentId: string;
    patch: {
      enabled?: boolean;
      runnerOverrideId?: string | null;
      branchBase?: string | null;
      executionPolicyOverride?: AgentExecutionPolicyRecommendation | null;
      schedules?: AgentScheduleInput[];
    };
  },
  db?: Db,
): Promise<void> {
  const _db = db ?? getDb();

  const linkRows = await _db
    .select()
    .from(agentProjectLinks)
    .where(
      and(
        eq(agentProjectLinks.agentId, input.agentId),
        eq(agentProjectLinks.projectId, input.projectId),
      ),
    );

  if (linkRows.length === 0) {
    throw new MaisterError(
      "PRECONDITION",
      `agent ${input.agentId} is not attached`,
    );
  }

  if (input.patch.runnerOverrideId != null) {
    await validateRunnerOverride(_db, input.patch.runnerOverrideId);
  }

  const now = new Date();
  const normalizedSchedules = input.patch.schedules?.map((s) =>
    normalizeSchedule(s, now),
  );

  await (_db as any).transaction(async (tx: any) => {
    const set: Record<string, unknown> = { updatedAt: now };

    if (input.patch.enabled !== undefined) set.enabled = input.patch.enabled;
    if (input.patch.runnerOverrideId !== undefined) {
      set.runnerOverrideId = input.patch.runnerOverrideId;
    }
    // SET/CLEAR symmetry (ADR-106 instance overrides): an explicit value sets,
    // explicit null clears → effective resolution falls back to the agent
    // `recommended` then project/platform default.
    if (input.patch.branchBase !== undefined) {
      set.branchBase = input.patch.branchBase;
    }
    if (input.patch.executionPolicyOverride !== undefined) {
      set.executionPolicyOverride = input.patch.executionPolicyOverride;
    }

    await tx
      .update(agentProjectLinks)
      .set(set)
      .where(eq(agentProjectLinks.id, linkRows[0].id));

    // ADR-089 rotation guarantee: disabling an attachment revokes its live
    // agent tokens in the same tx, not only detach — a disabled link blocks
    // future launches but must not leave an in-flight token valid to its TTL.
    if (input.patch.enabled === false) {
      await revokeAgentProjectTokens({
        agentId: input.agentId,
        projectId: input.projectId,
        db: tx,
      });
    }

    // Full replacement of this project's trigger bindings (spec contract).
    if (normalizedSchedules !== undefined) {
      await tx
        .delete(agentSchedules)
        .where(
          and(
            eq(agentSchedules.agentId, input.agentId),
            eq(agentSchedules.projectId, input.projectId),
          ),
        );
      for (const schedule of normalizedSchedules) {
        await tx.insert(agentSchedules).values({
          agentId: input.agentId,
          projectId: input.projectId,
          ...schedule,
        });
      }
    }

    // T6.2 (ADR-106): toggling the agent gates its triggers. Disabling forces
    // every schedule off so the CRON dispatcher — which filters only
    // agent_schedules.enabled, never joining the link — skips it instead of
    // firing-then-refusing and burning the catch-up window (the event
    // dispatcher already joins agent_project_links.enabled). A same-patch
    // schedules replacement keeps its own per-schedule `enabled` (the explicit
    // edit wins), EXCEPT under a disable which still forces all off; re-enabling
    // without a schedules edit restores them.
    if (input.patch.enabled === false) {
      await tx
        .update(agentSchedules)
        .set({ enabled: false })
        .where(
          and(
            eq(agentSchedules.agentId, input.agentId),
            eq(agentSchedules.projectId, input.projectId),
          ),
        );
    } else if (
      input.patch.enabled === true &&
      normalizedSchedules === undefined
    ) {
      await tx
        .update(agentSchedules)
        .set({ enabled: true })
        .where(
          and(
            eq(agentSchedules.agentId, input.agentId),
            eq(agentSchedules.projectId, input.projectId),
          ),
        );
    }
  });

  log.info(
    {
      agentId: input.agentId,
      projectId: input.projectId,
      schedules: normalizedSchedules?.length,
    },
    "agent link updated",
  );
}

// Detach (ADR-089 rotation guarantee): link + bindings removed and every
// live token for the (agent, project) pair revoked, in ONE transaction.
export async function detachAgent(
  input: { projectId: string; agentId: string },
  db?: Db,
): Promise<void> {
  const _db = db ?? getDb();

  const removed = await (_db as any).transaction(async (tx: any) => {
    await tx
      .delete(agentSchedules)
      .where(
        and(
          eq(agentSchedules.agentId, input.agentId),
          eq(agentSchedules.projectId, input.projectId),
        ),
      );

    const deleted = await tx
      .delete(agentProjectLinks)
      .where(
        and(
          eq(agentProjectLinks.agentId, input.agentId),
          eq(agentProjectLinks.projectId, input.projectId),
        ),
      )
      .returning({ id: agentProjectLinks.id });

    if (deleted.length === 0) return false;

    await revokeAgentProjectTokens({
      agentId: input.agentId,
      projectId: input.projectId,
      db: tx,
    });

    return true;
  });

  if (!removed) {
    throw new MaisterError(
      "PRECONDITION",
      `agent ${input.agentId} is not attached`,
    );
  }

  log.info(
    { agentId: input.agentId, projectId: input.projectId },
    "agent detached from project",
  );
}
