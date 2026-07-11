import "server-only";

import pino from "pino";

import { flowYamlV1Schema, type FlowYamlV1 } from "@/lib/config.schema";
import {
  isMaisterError,
  MaisterError,
  type MaisterErrorCode,
} from "@/lib/errors";
import { isEngineCompatible } from "@/lib/flows/engine-version";
import {
  classifyFlowManifestShape,
  LEGACY_STEPS_REFUSAL_MESSAGE,
} from "@/lib/flows/manifest-shape";

const log = pino({
  name: "flow-manifest-parser",
  level: process.env.LOG_LEVEL ?? "info",
});

export type FlowManifestParseContext = {
  code: Extract<MaisterErrorCode, "CONFIG" | "FLOW_INSTALL">;
  surface: string;
  manifestLabel: string;
  flowRefId?: string;
  revision?: string;
};

export type FlowManifestIncompatibility =
  | { kind: "legacy_steps"; message: string }
  | { kind: "invalid_manifest"; message: string }
  | { kind: "engine_incompatible"; message: string };

export const FLOW_MANIFEST_INCOMPATIBILITY_DETAIL =
  "flowManifestIncompatibility" as const;

export function flowManifestIncompatibilityDetails(
  reason: FlowManifestIncompatibility,
): Record<
  typeof FLOW_MANIFEST_INCOMPATIBILITY_DETAIL,
  FlowManifestIncompatibility
> {
  return { [FLOW_MANIFEST_INCOMPATIBILITY_DETAIL]: reason };
}

export function getFlowManifestIncompatibility(
  err: unknown,
): FlowManifestIncompatibility | null {
  if (!isMaisterError(err)) return null;

  const value = err.details?.[FLOW_MANIFEST_INCOMPATIBILITY_DETAIL];

  if (typeof value !== "object" || value === null) return null;

  const candidate = value as { kind?: unknown; message?: unknown };

  if (
    (candidate.kind !== "legacy_steps" &&
      candidate.kind !== "invalid_manifest" &&
      candidate.kind !== "engine_incompatible") ||
    typeof candidate.message !== "string"
  ) {
    return null;
  }

  return { kind: candidate.kind, message: candidate.message };
}

export type GraphOnlyManifestShapeParse =
  | {
      valid: true;
      manifest: FlowYamlV1;
      manifestShape: "graph";
      reason: null;
    }
  | {
      valid: false;
      manifest: null;
      manifestShape: Exclude<
        ReturnType<typeof classifyFlowManifestShape>,
        "graph"
      >;
      reason: Extract<
        FlowManifestIncompatibility,
        { kind: "legacy_steps" | "invalid_manifest" }
      >;
    };

export type StoredFlowManifestCompatibility =
  | {
      compatible: true;
      manifest: FlowYamlV1;
      manifestShape: "graph";
      reason: null;
    }
  | {
      compatible: false;
      manifest: null;
      manifestShape: ReturnType<typeof classifyFlowManifestShape>;
      reason: FlowManifestIncompatibility;
    };

export function classifyGraphOnlyFlowManifestShape(
  value: unknown,
): GraphOnlyManifestShapeParse {
  const manifestShape = classifyFlowManifestShape(value);
  const parsed = flowYamlV1Schema.safeParse(value);

  if (parsed.success) {
    return {
      valid: true,
      manifest: parsed.data,
      manifestShape: "graph",
      reason: null,
    };
  }

  const legacy = manifestShape === "legacy_steps" || manifestShape === "mixed";
  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");

  return {
    valid: false,
    manifest: null,
    manifestShape: manifestShape === "graph" ? "invalid" : manifestShape,
    reason: {
      kind: legacy ? "legacy_steps" : "invalid_manifest",
      message: legacy ? LEGACY_STEPS_REFUSAL_MESSAGE : issues,
    },
  };
}

export function classifyStoredFlowManifest(
  value: unknown,
): StoredFlowManifestCompatibility {
  const shape = classifyGraphOnlyFlowManifestShape(value);

  if (!shape.valid) {
    return {
      compatible: false,
      manifest: null,
      manifestShape: shape.manifestShape,
      reason: shape.reason,
    };
  }

  const engineCompatibility = isEngineCompatible(
    shape.manifest.compat?.engine_min,
    shape.manifest.compat?.engine_max,
  );

  if (!engineCompatibility.compatible) {
    return {
      compatible: false,
      manifest: null,
      manifestShape: "graph",
      reason: {
        kind: "engine_incompatible",
        message:
          engineCompatibility.reason ?? "engine compatibility check failed",
      },
    };
  }

  return {
    compatible: true,
    manifest: shape.manifest,
    manifestShape: "graph",
    reason: null,
  };
}

function refusalMessage(
  reason: FlowManifestIncompatibility,
  manifestLabel: string,
): string {
  if (reason.kind === "legacy_steps") return reason.message;

  if (reason.kind === "engine_incompatible") {
    return `flow manifest in ${manifestLabel} is incompatible with this MAIster engine: ${reason.message}`;
  }

  return `flow.yaml schema errors in ${manifestLabel}: ${reason.message}`;
}

function logManifestRefusal(
  context: FlowManifestParseContext,
  manifestShape: ReturnType<typeof classifyFlowManifestShape>,
  reason: FlowManifestIncompatibility,
): void {
  log.warn(
    {
      surface: context.surface,
      flowRefId: context.flowRefId,
      revision: context.revision,
      manifestShape,
      incompatibilityKind: reason.kind,
      code: context.code,
    },
    "graph-only flow manifest refused",
  );
}

export function parseGraphOnlyFlowManifest(
  value: unknown,
  context: FlowManifestParseContext,
): FlowYamlV1 {
  const shape = classifyGraphOnlyFlowManifestShape(value);

  if (shape.valid) {
    log.debug(
      {
        surface: context.surface,
        flowRefId: context.flowRefId,
        revision: context.revision,
        manifestShape: shape.manifestShape,
      },
      "graph-only flow manifest accepted",
    );

    return shape.manifest;
  }

  logManifestRefusal(context, shape.manifestShape, shape.reason);

  throw new MaisterError(
    context.code,
    refusalMessage(shape.reason, context.manifestLabel),
    { details: flowManifestIncompatibilityDetails(shape.reason) },
  );
}

// Stored manifests are executable only when their graph shape AND declared
// engine range are compatible with this host. Keep this distinct from the
// shape-only parser above: intake and authoring can validate future-engine
// graphs without treating them as executable on the current host.
export function parseExecutableStoredFlowManifest(
  value: unknown,
  context: FlowManifestParseContext,
): FlowYamlV1 {
  const compatibility = classifyStoredFlowManifest(value);

  if (compatibility.compatible) {
    log.debug(
      {
        surface: context.surface,
        flowRefId: context.flowRefId,
        revision: context.revision,
        manifestShape: compatibility.manifestShape,
      },
      "executable stored flow manifest accepted",
    );

    return compatibility.manifest;
  }

  logManifestRefusal(
    context,
    compatibility.manifestShape,
    compatibility.reason,
  );

  throw new MaisterError(
    context.code,
    refusalMessage(compatibility.reason, context.manifestLabel),
    { details: flowManifestIncompatibilityDetails(compatibility.reason) },
  );
}
