import "server-only";

import { eq } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { LAUNCHABLE_FLOW_ENABLEMENT_STATES } from "@/lib/flows/enablement-states";
import {
  isEngineCompatible,
  isSchemaVersionSupported,
} from "@/lib/flows/engine-version";
import { resolveEffectiveFlowRevision } from "@/lib/flows/lifecycle";
import { flowManifestIncompatibilityDetails } from "@/lib/flows/manifest-parser";
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
 * The gate sequence mirrors `launchRunStaged`'s in-line sequence exactly —
 * enablement allow-list, trust, pinned revision, package status, setup status,
 * manifest schema version, engine range — so a flow that this resolver admits is
 * one the canonical launcher will also admit. Divergence between the two would
 * mean a delegation that passes trust and then fails mid-launch with a carrier
 * task already written.
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
  ): never => {
    log.warn(
      { projectId, flowId: flow.id, flowRefId: flow.flowRefId, reason },
      "[delegation.flow] target refused",
    );
    throw new MaisterError(code, message);
  };

  if (!flow.enabledRevisionId) {
    refuse(
      "PRECONDITION",
      `flow "${flow.flowRefId}" has no enabled package revision`,
      "no_enabled_revision",
    );
  }
  if (!LAUNCHABLE_FLOW_ENABLEMENT_STATES.has(flow.enablementState)) {
    refuse(
      "PRECONDITION",
      `flow "${flow.flowRefId}" package is ${flow.enablementState}, not launchable (enable it first)`,
      "not_launchable",
    );
  }
  if (flow.trustStatus === "untrusted") {
    refuse(
      "PRECONDITION",
      `flow "${flow.flowRefId}" package is not trusted — confirm trust before launch`,
      "untrusted",
    );
  }

  const effectiveRevisionId =
    (await resolveEffectiveFlowRevision(_db, flow)) ?? flow.enabledRevisionId;
  const revisionRows = await _db
    .select()
    .from(flowRevisions)
    .where(eq(flowRevisions.id, effectiveRevisionId));
  const revision = revisionRows[0];

  // Defence in depth: `flows.enabled_revision_id` is a FK with ON DELETE SET
  // NULL, so a vanished revision degrades into the no-pointer refusal above and
  // this branch is unreachable through the schema. It mirrors the canonical
  // launcher's guard so the two sequences stay identical.
  if (!revision) {
    refuse(
      "PRECONDITION",
      `enabled revision not found for flow "${flow.flowRefId}"`,
      "revision_row_missing",
    );
  }
  if (revision.packageStatus !== "Installed") {
    refuse(
      "PRECONDITION",
      `flow "${flow.flowRefId}" enabled revision is ${revision.packageStatus}, not Installed`,
      "revision_not_installed",
    );
  }
  if (revision.setupStatus === "pending" || revision.setupStatus === "failed") {
    refuse(
      "PRECONDITION",
      `flow "${flow.flowRefId}" package setup is ${revision.setupStatus}`,
      "setup_incomplete",
    );
  }
  if (!isSchemaVersionSupported(revision.schemaVersion)) {
    refuse(
      "CONFIG",
      `flow "${flow.flowRefId}" requires unsupported manifest schemaVersion ${revision.schemaVersion}`,
      "unsupported_schema_version",
    );
  }

  const compat = isEngineCompatible(
    revision.engineMin ?? undefined,
    revision.engineMax ?? undefined,
  );

  if (!compat.compatible) {
    log.warn(
      {
        projectId,
        flowId: flow.id,
        flowRefId: flow.flowRefId,
        reason: "engine_incompatible",
      },
      "[delegation.flow] target refused",
    );
    throw new MaisterError(
      "CONFIG",
      `flow "${flow.flowRefId}" is incompatible with this MAIster engine: ${compat.reason}`,
      {
        details: flowManifestIncompatibilityDetails({
          kind: "engine_incompatible",
          message: compat.reason ?? "engine compatibility check failed",
        }),
      },
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
