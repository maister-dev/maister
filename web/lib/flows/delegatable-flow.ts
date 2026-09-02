import "server-only";

import { eq } from "drizzle-orm";
import pino from "pino";

import { hasReadyPlatformRunner } from "@/lib/acp-runners/ready-runner";
import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import type { DelegationSnapshot } from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import {
  describeFlowLaunchabilityRefusal,
  evaluateFlowLaunchability,
} from "@/lib/flows/launchability-gate";
import { resolveEffectiveFlowRevision } from "@/lib/flows/lifecycle";
import {
  classifyStoredFlowManifest,
  flowManifestIncompatibilityDetails,
} from "@/lib/flows/manifest-parser";
import {
  formatFlowRefError,
  resolveFlowRef,
} from "@/lib/flows/resolve-flow-ref";

// ADR-163 REQ-05: this module owns TRUST RESOLUTION and nothing else. The
// delegation order is locate -> establish trust -> execute, and "separate" is a
// property of the code, not a convention: this module MUST NOT import a
// launcher, which `lib/flows/__tests__/delegatable-flow-isolation.test.ts`
// asserts by reading its import list. That is what makes "a refused delegation
// writes zero rows" structurally true rather than merely currently true.

// FIXME(any): dual drizzle-orm peer-dep variants (matches lib/flows/resolve-flow-ref.ts).
const { flows, flowRevisions } = schemaModule as unknown as Record<string, any>;

// FIXME(any): dual drizzle-orm peer-dep variants.
type Db = any;

const log = pino({
  name: "flows-delegatable",
  level: process.env.LOG_LEVEL ?? "info",
});

export type DelegatableFlow = {
  /** The resolved `flows.id` — never the body-supplied ref. */
  flowId: string;
  flowRefId: string;
  /** The immutable pinned revision this delegation would launch. */
  revisionId: string;
  resolvedRevision: string;
  versionLabel: string;
  /** Engine compatibility as evaluated AT RESOLUTION TIME. */
  engineMin: string | null;
  engineMax: string | null;
};

/**
 * Resolve a body-supplied flow reference to a launch-eligible flow, scoped to
 * the bound orchestrator's project.
 *
 * The reference resolves ONLY through `resolveFlowRef` (a `flows.id` or the
 * project's `flows.flow_ref_id`); a package path, git tag, filesystem path,
 * URL, or inline definition never enters this path, and the resolved row's
 * `projectId` is re-asserted afterwards.
 *
 * Launchability is the ONE shared gate (`lib/flows/launchability-gate.ts`) the
 * canonical launcher and the board projection evaluate, plus the board's two
 * host facts (a Ready platform runner, an executable stored manifest) — so a
 * flow this resolver admits is exactly one the board shows as launchable and
 * the launcher will accept, and a refusal never arrives after a carrier task
 * has been written.
 *
 * Throws `MaisterError` and writes nothing, ever.
 */
export async function resolveDelegatableFlow(
  args: { projectId: string; flowId: string },
  db?: Db,
): Promise<DelegatableFlow> {
  const _db = (db ?? getDb()) as Db;
  const { projectId, flowId: ref } = args;

  const resolution = await resolveFlowRef(projectId, ref, _db);

  if (!resolution.ok) {
    log.warn(
      { projectId, ref, reason: "unresolvable_ref" },
      "[delegation.flow] target refused",
    );
    throw new MaisterError(
      "PRECONDITION",
      formatFlowRefError(resolution.detail),
    );
  }

  const flowRows = await _db
    .select()
    .from(flows)
    .where(eq(flows.id, resolution.flowId));
  const flow = flowRows[0];

  if (!flow) {
    log.warn(
      { projectId, ref, reason: "flow_row_missing" },
      "[delegation.flow] target refused",
    );
    throw new MaisterError(
      "PRECONDITION",
      formatFlowRefError({
        field: "flowId",
        expected: "a flow installed in this project",
        received: ref,
        validRefs: [],
      }),
    );
  }

  // Belt to `resolveFlowRef`'s own project scoping: the locator is
  // body-controlled, so the resolved row's tenancy is re-asserted rather than
  // inferred from the query that produced it.
  if (flow.projectId !== projectId) {
    log.warn(
      { projectId, ref, reason: "cross_project" },
      "[delegation.flow] target refused",
    );
    throw new MaisterError(
      "PRECONDITION",
      formatFlowRefError({
        field: "flowId",
        expected: "a flow installed in this project",
        received: ref,
        validRefs: [],
      }),
    );
  }

  const refuse = (
    code: "PRECONDITION" | "CONFIG",
    message: string,
    reason: string,
    details?: Record<string, unknown>,
  ): never => {
    log.warn(
      { projectId, flowId: flow.id, flowRefId: flow.flowRefId, reason },
      "[delegation.flow] target refused",
    );
    throw new MaisterError(code, message, details ? { details } : undefined);
  };

  const effectiveRevisionId = flow.enabledRevisionId
    ? ((await resolveEffectiveFlowRevision(_db, flow)) ??
      flow.enabledRevisionId)
    : null;
  const revisionRows = effectiveRevisionId
    ? await _db
        .select()
        .from(flowRevisions)
        .where(eq(flowRevisions.id, effectiveRevisionId))
    : [];
  const revision = revisionRows[0];

  const verdict = evaluateFlowLaunchability(flow, revision ?? null);

  if (!verdict.ok) {
    refuse(
      verdict.code,
      describeFlowLaunchabilityRefusal(flow.flowRefId, verdict),
      verdict.reason,
      verdict.details,
    );
  }

  if (!(await hasReadyPlatformRunner(_db))) {
    refuse(
      "PRECONDITION",
      `no Ready platform ACP runner is enabled — flow "${flow.flowRefId}" cannot be launched`,
      "no_ready_runner",
    );
  }

  const stored = classifyStoredFlowManifest(revision.manifest);

  if (!stored.compatible) {
    refuse(
      "CONFIG",
      `flow "${flow.flowRefId}" stored manifest cannot be executed by this engine: ${stored.reason.message}`,
      "manifest_incompatible",
      flowManifestIncompatibilityDetails(stored.reason),
    );
  }

  log.debug(
    {
      projectId,
      flowId: flow.id,
      flowRefId: flow.flowRefId,
      revisionId: revision.id,
      enablementState: flow.enablementState,
      trustStatus: flow.trustStatus,
    },
    "[delegation.flow] target resolved",
  );

  return {
    flowId: flow.id,
    flowRefId: flow.flowRefId,
    revisionId: revision.id,
    resolvedRevision: revision.resolvedRevision,
    versionLabel: revision.versionLabel,
    engineMin: revision.engineMin ?? null,
    engineMax: revision.engineMax ?? null,
  };
}

export type FlowDelegationSnapshotInput = Omit<
  Extract<DelegationSnapshot, { kind: "flow" }>,
  "baseBranch" | "targetBranch"
>;

/**
 * The launch-time `delegation_snapshot` a flow child carries — built in ONE
 * place for the three child-creation edges (`run_delegate`, `run_plan`, the
 * as-plan auto-launcher). `baseBranch` / `targetBranch` are deliberately absent:
 * `launchRunStaged` completes them from its own branch resolution (ADR-163 D7),
 * so the snapshot and the workspace cannot disagree.
 */
export function flowDelegationSnapshot(
  resolved: DelegatableFlow,
  args: {
    carrierTaskId: string;
    mode: "task" | "run";
    runnerOverride: string | null;
  },
): FlowDelegationSnapshotInput {
  return {
    kind: "flow",
    flowId: resolved.flowId,
    flowRefId: resolved.flowRefId,
    flowRevisionId: resolved.revisionId,
    resolvedRevision: resolved.resolvedRevision,
    engineMin: resolved.engineMin,
    engineMax: resolved.engineMax,
    carrierTaskId: args.carrierTaskId,
    mode: args.mode,
    runnerOverride: args.runnerOverride,
  };
}
