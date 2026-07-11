import "server-only";

import pino from "pino";

import { flowYamlV1Schema, type FlowYamlV1 } from "@/lib/config.schema";
import { MaisterError, type MaisterErrorCode } from "@/lib/errors";
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

export type FlowManifestIncompatibility = {
  kind: "legacy_steps" | "invalid_manifest";
  message: string;
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
      manifestShape: Exclude<
        ReturnType<typeof classifyFlowManifestShape>,
        "graph"
      >;
      reason: FlowManifestIncompatibility;
    };

export function classifyStoredFlowManifest(
  value: unknown,
): StoredFlowManifestCompatibility {
  const manifestShape = classifyFlowManifestShape(value);
  const parsed = flowYamlV1Schema.safeParse(value);

  if (parsed.success) {
    return {
      compatible: true,
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
    compatible: false,
    manifest: null,
    manifestShape: manifestShape === "graph" ? "invalid" : manifestShape,
    reason: {
      kind: legacy ? "legacy_steps" : "invalid_manifest",
      message: legacy ? LEGACY_STEPS_REFUSAL_MESSAGE : issues,
    },
  };
}

export function parseGraphOnlyFlowManifest(
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
      "graph-only flow manifest accepted",
    );

    return compatibility.manifest;
  }

  const message =
    compatibility.reason.kind === "legacy_steps"
      ? compatibility.reason.message
      : `flow.yaml schema errors in ${context.manifestLabel}: ${compatibility.reason.message}`;

  log.warn(
    {
      surface: context.surface,
      flowRefId: context.flowRefId,
      revision: context.revision,
      manifestShape: compatibility.manifestShape,
      code: context.code,
    },
    "graph-only flow manifest refused",
  );

  throw new MaisterError(context.code, message);
}
