import "server-only";

import type { MaisterYamlV2 } from "@/lib/config.schema";
import type { ProjectDependencyInput } from "./types";

import { assertDependencySource } from "./source";

import { buildCapabilityRefIds } from "@/lib/config";
import { MaisterError } from "@/lib/errors";
import { flowIdSchema, versionTagSchema } from "@/lib/flow-paths";

export function registrationDependencies(
  config: MaisterYamlV2,
): ProjectDependencyInput[] {
  const refs = buildCapabilityRefIds(config);
  const roleRefs = (config.flow_roles ?? []).map((role) => role.ref);
  const capabilityRefIds = {
    mcp: [...refs.mcp],
    skill: [...refs.skill],
    restriction: [...refs.restriction],
    setting: [...refs.setting],
  };
  const declarations: ProjectDependencyInput[] = [
    ...config.flows.map(({ id: logicalId, ...pin }, ordinal) => ({
      kind: "flow" as const,
      logicalId,
      ordinal,
      desired: { ...pin, roleRefs, capabilityRefIds },
    })),
    ...config.packages.map(({ id: logicalId, ...pin }, ordinal) => ({
      kind: "package" as const,
      logicalId,
      ordinal,
      desired: { ...pin, roleRefs, capabilityRefIds },
    })),
    ...config.capability_imports.map(
      ({ id: logicalId, ...desired }, ordinal) => ({
        kind: "capability_import" as const,
        logicalId,
        ordinal,
        desired,
      }),
    ),
  ];

  for (const { kind, logicalId, desired } of declarations) {
    assertDependencySource(desired.source);
    if (
      kind === "flow" &&
      (!flowIdSchema.safeParse(logicalId).success ||
        !versionTagSchema.safeParse(desired.version).success)
    ) {
      throw new MaisterError(
        "CONFIG",
        `Invalid ${kind} identifier or version in maister.yaml.`,
      );
    }
  }

  return declarations;
}
