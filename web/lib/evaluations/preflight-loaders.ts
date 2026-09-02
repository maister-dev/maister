import "server-only";

import { LAUNCHABLE_FLOW_ENABLEMENT_STATES } from "@/lib/flows/enablement-states";
import type { Db } from "@/lib/evaluations/db";
import type { PreflightContractLoaders } from "@/lib/evaluations/recipes";
import type {
  PreflightFlowRevision,
  PreflightMethodRequirements,
  PreflightOverlayCatalog,
} from "@/lib/evaluations/preflight";

import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";

import { loadRunnerCatalog } from "@/lib/acp-runners/catalog";
import { enumerateRunnerSlots } from "@/lib/acp-runners/runner-slots";
import { readAndValidateFormSchemaDoc } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import {
  capabilityRecords,
  evaluationMethodRevisions,
  evaluationProfiles,
  flowRevisions,
  flows,
} from "@/lib/db/schema";
import { MaisterError } from "@/lib/errors";
import { compileManifest } from "@/lib/flows/graph/compile";
import {
  isEngineCompatible,
  isSchemaVersionSupported,
} from "@/lib/flows/engine-version";
import { parseExecutableStoredFlowManifest } from "@/lib/flows/manifest-parser";

const log = pino({
  name: "evaluations-preflight-loaders",
  level: process.env.LOG_LEVEL ?? "info",
});

// Build the exact-compat FlowContractProjection + launch-gate facets the pure
// preflight core consumes. This is the SINGLE assembler shared by preflight
// (T1.1) and controlled-recipe creation (T1.4): the freeze-time contract digest
// and the preflight-time digest must be byte-identical, which only holds if both
// sides derive the projection here. Trust/enablement come from the per-project
// `flows` row; the manifest/engine/schema come from the IMMUTABLE `flowRevisions`
// row pinned by the recipe (never `flows.manifest`, the mutable install pointer).
export async function buildFlowContractProjection(
  args: { projectId: string; flowRefId: string; flowRevisionId: string },
  db?: Db,
): Promise<PreflightFlowRevision> {
  const d = db ?? getDb();

  const [[flowRow], [revisionRow]] = await Promise.all([
    d
      .select({
        projectId: flows.projectId,
        trustStatus: flows.trustStatus,
        enablementState: flows.enablementState,
      })
      .from(flows)
      .where(
        and(
          eq(flows.projectId, args.projectId),
          eq(flows.flowRefId, args.flowRefId),
        ),
      ),
    d
      .select({
        manifest: flowRevisions.manifest,
        schemaVersion: flowRevisions.schemaVersion,
        engineMin: flowRevisions.engineMin,
        engineMax: flowRevisions.engineMax,
        installedPath: flowRevisions.installedPath,
        setupStatus: flowRevisions.setupStatus,
        packageStatus: flowRevisions.packageStatus,
      })
      .from(flowRevisions)
      .where(eq(flowRevisions.id, args.flowRevisionId)),
  ]);

  // Honest absence: a missing flow or a missing pinned revision is a refusal,
  // never a fabricated pass (the eval routes map PRECONDITION -> 404).
  if (!flowRow) {
    throw new MaisterError(
      "PRECONDITION",
      `flow ${args.flowRefId} not found in project ${args.projectId}`,
    );
  }
  if (!revisionRow) {
    throw new MaisterError(
      "PRECONDITION",
      `flow revision not found: ${args.flowRevisionId}`,
    );
  }

  const manifest = parseExecutableStoredFlowManifest(revisionRow.manifest, {
    code: "CONFIG",
    surface: "evaluation-preflight",
    manifestLabel: "flow manifest",
  });
  const graph = compileManifest(manifest);
  const slots = enumerateRunnerSlots(revisionRow.manifest);

  const producedArtifactKinds = new Set<string>();
  const formSchemaRefs: string[] = [];

  for (const node of graph.nodes.values()) {
    for (const produced of node.output?.produces ?? []) {
      producedArtifactKinds.add(produced.kind);
    }
    if (node.nodeType === "form") {
      const formSchema = (node.settings as { form_schema?: string } | undefined)
        ?.form_schema;

      if (typeof formSchema === "string" && formSchema.length > 0) {
        formSchemaRefs.push(formSchema);
      }
    }
  }

  const formKnownFields = new Set<string>();
  const formRequiredFields = new Set<string>();

  for (const relPath of formSchemaRefs) {
    const doc = await readAndValidateFormSchemaDoc(
      revisionRow.installedPath,
      relPath,
    );

    for (const field of doc.fields) {
      formKnownFields.add(field.name);
      if (field.required) formRequiredFields.add(field.name);
    }
  }

  const runnerProfiles = manifest.runner_profiles;
  const engineCompatible = isEngineCompatible(
    revisionRow.engineMin ?? undefined,
    revisionRow.engineMax ?? undefined,
  ).compatible;

  log.debug(
    {
      projectId: args.projectId,
      flowRefId: args.flowRefId,
      flowRevisionId: args.flowRevisionId,
      slotCount: slots.length,
      producedKinds: producedArtifactKinds.size,
      formFields: formKnownFields.size,
      engineCompatible,
    },
    "flow contract projection assembled",
  );

  return {
    flowRefId: args.flowRefId,
    flowRevisionId: args.flowRevisionId,
    projectId: flowRow.projectId,
    trusted: flowRow.trustStatus !== "untrusted",
    enablementLaunchable:
      LAUNCHABLE_FLOW_ENABLEMENT_STATES.has(flowRow.enablementState) &&
      revisionRow.packageStatus === "Installed" &&
      revisionRow.setupStatus !== "pending" &&
      revisionRow.setupStatus !== "failed",
    engineCompatible,
    schemaVersionSupported: isSchemaVersionSupported(revisionRow.schemaVersion),
    // `requiredTaskFields` has no derivation in the codebase and no refusal in
    // the pure core reads it — it is a digest input only. `[]` is self-consistent
    // because this one assembler feeds both the freeze and preflight digests.
    requiredTaskFields: [],
    formRequiredFields: [...formRequiredFields],
    formKnownFields: [...formKnownFields],
    producedArtifactKinds: [...producedArtifactKinds],
    slotKeys: slots.map((s) => s.slotKey),
    ...(runnerProfiles ? { runnerProfiles } : {}),
    // A manifest slot either carries an explicit runner or resolves via the
    // project/platform default chain (`runner === undefined`), so none strictly
    // REQUIRES a recipe binding at preflight time — strict launch-time
    // resolvability is the launch resolver's concern. Empty here matches the
    // pure core's "refuse only an explicitly-unbound required slot" contract.
    requiredSlotKeys: [],
  };
}

// Resolve the selected Method's required artifact/coverage set from the profile's
// method revision. Absent profile -> no coverage gate (empty requirements): a
// preflight without a chosen profile cannot check method coverage, and the pure
// core skips the coverage loop on an empty set rather than fabricating a pass.
async function loadMethodRequirements(
  args: { projectId: string; profileId?: string },
  db: Db,
): Promise<PreflightMethodRequirements> {
  if (!args.profileId) {
    return { qualifiedId: "", requiredArtifactKinds: [] };
  }

  const [row] = await db
    .select({
      qualifiedId: evaluationMethodRevisions.qualifiedId,
      normalizedDefinition: evaluationMethodRevisions.normalizedDefinition,
    })
    .from(evaluationProfiles)
    .innerJoin(
      evaluationMethodRevisions,
      eq(evaluationMethodRevisions.id, evaluationProfiles.methodRevisionId),
    )
    .where(eq(evaluationProfiles.id, args.profileId));

  if (!row) {
    throw new MaisterError(
      "PRECONDITION",
      `evaluation profile not found: ${args.profileId}`,
    );
  }

  const definition = (
    row.normalizedDefinition as {
      definition?: { evidence?: { requiredCoverage?: string[] } };
    } | null
  )?.definition;

  return {
    qualifiedId: row.qualifiedId,
    requiredArtifactKinds: definition?.evidence?.requiredCoverage ?? [],
  };
}

// The set of known capability refs per class for a project's overlay validation.
// Inlined (not imported from lib/experiments, which is removed in the ADR-150
// cut-over) — the predicate is `capability_records WHERE project + not disabled`,
// bucketed by kind; `agent_definition` records back the `subagents` class.
async function loadOverlayCatalog(
  projectId: string,
  db: Db,
): Promise<PreflightOverlayCatalog> {
  const rows = await db
    .select({
      capabilityRefId: capabilityRecords.capabilityRefId,
      kind: capabilityRecords.kind,
    })
    .from(capabilityRecords)
    .where(
      and(
        eq(capabilityRecords.projectId, projectId),
        isNull(capabilityRecords.disabledAt),
      ),
    );

  const catalog: {
    rules: Set<string>;
    skills: Set<string>;
    mcps: Set<string>;
    subagents: Set<string>;
  } = {
    rules: new Set(),
    skills: new Set(),
    mcps: new Set(),
    subagents: new Set(),
  };

  for (const row of rows) {
    if (row.kind === "rule") catalog.rules.add(row.capabilityRefId);
    else if (row.kind === "skill") catalog.skills.add(row.capabilityRefId);
    else if (row.kind === "mcp") catalog.mcps.add(row.capabilityRefId);
    else if (row.kind === "agent_definition")
      catalog.subagents.add(row.capabilityRefId);
  }

  return catalog;
}

// The live PreflightContractLoaders wired over real project data. Injected by the
// preflight and launch routes; tests inject stubs against the same interface.
export function livePreflightLoaders(db?: Db): PreflightContractLoaders {
  const d = db ?? getDb();

  return {
    loadFlowRevision: (args) => buildFlowContractProjection(args, d),
    loadMethodRequirements: (args) => loadMethodRequirements(args, d),
    loadRunnerCatalog: () => loadRunnerCatalog(d),
    loadOverlayCatalog: (projectId) => loadOverlayCatalog(projectId, d),
  };
}
