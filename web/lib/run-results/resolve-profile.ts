import type {
  RunResultContract,
  ResultProfileMap,
} from "@/lib/run-results/types";

import { eq } from "drizzle-orm";
import pino from "pino";

import { RAH_ENGINE_MIN } from "@/lib/config.schema";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { semverGte } from "@/lib/flows/engine-version";
import { buildAgentProfileContract } from "@/lib/run-results/contract";

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/services/tasks.ts).
const { flowRevisions, runs } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "run-result-profile",
  level: process.env.LOG_LEVEL ?? "info",
});

// ADR-165 (T5.2 / C-5.3): `resultProfile` is a NAME, resolved through an
// ALLOW-LIST keyed on the PARENT run's pinned `flow_revisions.result_profiles`.
// Never a path, never an inline schema, never a live catalog row.
//
// This module deliberately imports NO launcher (`services/runs`,
// `agents/launch`, `flows/runner`). All three creation edges call it, and a
// launcher import would make that impossible without a cycle — and would invite
// a second, edge-local copy of the rule.

const SHA_PREFIX_LEN = 12;

export type ResolveResultProfileArgs = {
  parentRunId: string;
  name: string;
};

/**
 * Resolve `name` against the parent run's pinned revision and build the child's
 * contract. Throws `CONFIG` (→ 422) on every miss.
 */
export async function resolveResultProfile(
  db: Db,
  args: ResolveResultProfileArgs,
): Promise<RunResultContract> {
  const parentRows = (await db
    .select({ flowRevisionId: runs.flowRevisionId })
    .from(runs)
    .where(eq(runs.id, args.parentRunId))) as {
    flowRevisionId: string | null;
  }[];
  const flowRevisionId = parentRows[0]?.flowRevisionId ?? null;

  if (!flowRevisionId) {
    log.warn(
      { parentRunId: args.parentRunId, name: args.name, reason: "no_revision" },
      "[delegation.profile] refused",
    );
    throw new MaisterError(
      "CONFIG",
      `unknown result profile "${args.name}": the delegating run is not pinned to a flow revision, so it declares none`,
    );
  }

  const revisionRows = (await db
    .select({
      flowRefId: flowRevisions.flowRefId,
      resolvedRevision: flowRevisions.resolvedRevision,
      engineMin: flowRevisions.engineMin,
      resultProfiles: flowRevisions.resultProfiles,
    })
    .from(flowRevisions)
    .where(eq(flowRevisions.id, flowRevisionId))) as {
    flowRefId: string;
    resolvedRevision: string;
    engineMin: string | null;
    resultProfiles: ResultProfileMap | null;
  }[];
  const revision = revisionRows[0];

  if (!revision) {
    throw new MaisterError(
      "CONFIG",
      `unknown result profile "${args.name}": the delegating run's pinned flow revision is missing`,
    );
  }

  // R4 — the engine floor, checked EXPLICITLY. Without it a pre-3.7.0 parent
  // whose revision happens to carry a profile map (a package installed after the
  // upgrade) would silently gain the feature.
  if (!semverGte(revision.engineMin ?? "", RAH_ENGINE_MIN)) {
    log.warn(
      {
        parentRunId: args.parentRunId,
        name: args.name,
        engineMin: revision.engineMin ?? "(unset)",
        reason: "engine_floor",
      },
      "[delegation.profile] refused",
    );
    throw new MaisterError(
      "CONFIG",
      `resultProfile requires the delegating flow's engine_min >= ${RAH_ENGINE_MIN} (it declares "${revision.engineMin ?? "(unset)"}")`,
    );
  }

  const profile = revision.resultProfiles?.[args.name];

  if (!profile) {
    const known = Object.keys(revision.resultProfiles ?? {}).sort();

    log.warn(
      {
        parentRunId: args.parentRunId,
        name: args.name,
        known,
        reason: "unknown_name",
      },
      "[delegation.profile] refused",
    );
    throw new MaisterError(
      "CONFIG",
      `unknown result profile "${args.name}" — the delegating run's pinned package declares ${known.length > 0 ? known.map((k) => `"${k}"`).join(", ") : "none"}`,
    );
  }

  const contract = buildAgentProfileContract({
    profileName: args.name,
    flowRefId: revision.flowRefId,
    resolvedRevision: revision.resolvedRevision,
    sourceFlowRevisionId: flowRevisionId,
    schemaStem: profile.schemaStem,
    schemaVersion: profile.schemaVersion,
    schema: profile.schema,
    sha256: profile.sha256,
  });

  log.info(
    {
      parentRunId: args.parentRunId,
      kind: "agent_profile",
      profileName: args.name,
      schemaRef: contract.schemaRef,
      sha256Prefix: profile.sha256.slice(0, SHA_PREFIX_LEN),
    },
    "[run-result.contract] agent profile resolved",
  );

  return contract;
}

/**
 * `resolveResultProfile` when a name was given, `null` otherwise.
 *
 * The three creation edges each have a slightly different way of learning the
 * name (a body field, a plan entry, a task's `delegation_spec`); folding the
 * "was one given?" branch in here keeps the rule itself in one place.
 */
export async function resolveResultContractForDelegation(
  db: Db,
  args: { parentRunId: string; name: string | null | undefined },
): Promise<RunResultContract | null> {
  if (!args.name) return null;

  return resolveResultProfile(db, {
    parentRunId: args.parentRunId,
    name: args.name,
  });
}
