import { MaisterError } from "@/lib/errors";
import { LAUNCHABLE_FLOW_ENABLEMENT_STATES } from "@/lib/flows/enablement-states";
import {
  isEngineCompatible,
  isSchemaVersionSupported,
} from "@/lib/flows/engine-version";
import {
  type FlowManifestIncompatibility,
  flowManifestIncompatibilityDetails,
} from "@/lib/flows/manifest-parser";

// The ONE launchability decision for a project flow (M10, ADR-021). The
// canonical launcher (`launchRunStaged`), the delegation trust resolver
// (`resolveDelegatableFlow`, ADR-163) and the board projection
// (`isProjectFlowLaunchable`) evaluate it; before this module each carried its
// own copy of these checks, and the copies had already diverged. Pure: the
// callers load the rows and decide how to surface a refusal.

export type FlowLaunchabilityFlow = {
  enabledRevisionId: string | null;
  enablementState: string;
  trustStatus: string;
};

export type FlowLaunchabilityRevision = {
  packageStatus: string;
  setupStatus: string;
  schemaVersion: number;
  engineMin: string | null;
  engineMax: string | null;
};

export type FlowLaunchabilityReason =
  | "no_enabled_revision"
  | "not_launchable"
  | "untrusted"
  | "revision_row_missing"
  | "revision_not_installed"
  | "setup_incomplete"
  | "unsupported_schema_version"
  | "engine_incompatible";

export type FlowLaunchabilityRefusal = {
  ok: false;
  code: "PRECONDITION" | "CONFIG";
  reason: FlowLaunchabilityReason;
  /** The observed value the message names: a state, a status, a version, an engine reason. */
  observed: string;
  details?: Record<string, FlowManifestIncompatibility>;
};

export type FlowLaunchabilityVerdict = { ok: true } | FlowLaunchabilityRefusal;

function refuse(
  code: FlowLaunchabilityRefusal["code"],
  reason: FlowLaunchabilityReason,
  observed: string,
): FlowLaunchabilityRefusal {
  return { ok: false, code, reason, observed };
}

/**
 * Flow-level checks first, then the revision the flow resolved to. `Installed`
 * is deliberately NOT launchable: a package installed from an untrusted source
 * stays `Installed` after `/trust` and must be explicitly `/enable`d, so trust
 * alone never collapses the trust+enable lifecycle into one launchable step.
 */
export function evaluateFlowLaunchability(
  flow: FlowLaunchabilityFlow,
  revision: FlowLaunchabilityRevision | null,
): FlowLaunchabilityVerdict {
  if (!flow.enabledRevisionId) {
    return refuse("PRECONDITION", "no_enabled_revision", "");
  }
  if (!LAUNCHABLE_FLOW_ENABLEMENT_STATES.has(flow.enablementState)) {
    return refuse("PRECONDITION", "not_launchable", flow.enablementState);
  }
  if (flow.trustStatus === "untrusted") {
    return refuse("PRECONDITION", "untrusted", flow.trustStatus);
  }
  if (!revision) {
    return refuse("PRECONDITION", "revision_row_missing", "");
  }
  if (revision.packageStatus !== "Installed") {
    return refuse(
      "PRECONDITION",
      "revision_not_installed",
      revision.packageStatus,
    );
  }
  if (revision.setupStatus === "pending" || revision.setupStatus === "failed") {
    return refuse("PRECONDITION", "setup_incomplete", revision.setupStatus);
  }
  if (!isSchemaVersionSupported(revision.schemaVersion)) {
    return refuse(
      "CONFIG",
      "unsupported_schema_version",
      String(revision.schemaVersion),
    );
  }

  const compat = isEngineCompatible(
    revision.engineMin ?? undefined,
    revision.engineMax ?? undefined,
  );

  if (!compat.compatible) {
    const message = compat.reason ?? "engine compatibility check failed";

    return {
      ...refuse("CONFIG", "engine_incompatible", message),
      details: flowManifestIncompatibilityDetails({
        kind: "engine_incompatible",
        message,
      }),
    };
  }

  return { ok: true };
}

/** The launcher's messages, verbatim — the ext refusal contract pins them. */
export function describeFlowLaunchabilityRefusal(
  flowRefId: string,
  refusal: FlowLaunchabilityRefusal,
): string {
  switch (refusal.reason) {
    case "no_enabled_revision":
      return `flow "${flowRefId}" has no enabled package revision`;
    case "not_launchable":
      return `flow "${flowRefId}" package is ${refusal.observed}, not launchable (enable it first)`;
    case "untrusted":
      return `flow "${flowRefId}" package is not trusted — confirm trust before launch`;
    case "revision_row_missing":
      return `enabled revision not found for flow "${flowRefId}"`;
    case "revision_not_installed":
      return `flow "${flowRefId}" enabled revision is ${refusal.observed}, not Installed`;
    case "setup_incomplete":
      return `flow "${flowRefId}" package setup is ${refusal.observed}`;
    case "unsupported_schema_version":
      return `flow "${flowRefId}" requires unsupported manifest schemaVersion ${refusal.observed}`;
    case "engine_incompatible":
      return `flow "${flowRefId}" is incompatible with this MAIster engine: ${refusal.observed}`;
  }
}

/** Evaluate and throw the typed refusal — the launcher's and the resolver's shape. */
export function assertFlowLaunchable(
  flowRefId: string,
  flow: FlowLaunchabilityFlow,
  revision: FlowLaunchabilityRevision | null,
): void {
  const verdict = evaluateFlowLaunchability(flow, revision);

  if (verdict.ok) return;

  throw new MaisterError(
    verdict.code,
    describeFlowLaunchabilityRefusal(flowRefId, verdict),
    verdict.details ? { details: verdict.details } : undefined,
  );
}
