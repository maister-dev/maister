import "server-only";

import type { ScratchAdapterLaunch } from "@/lib/db/schema";
import type { ResolvedCapabilityProfile } from "@/lib/capabilities/types";

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { atomicWriteJson, atomicWriteText } from "@/lib/atomic";
import { MaisterError } from "@/lib/errors";

export type MaterializeCapabilityProfileArgs = {
  runId: string;
  worktreePath: string;
  profile: ResolvedCapabilityProfile;
  executor?: {
    executorRefId: string;
    agent: string;
    model: string;
    router: string | null;
  };
  workMode?: "auto" | "plan_first" | "manual_approval";
  reasoningEffort?: "low" | "high" | "extra" | "ultra";
};

export type MaterializedCapabilityProfile = {
  rootPath: string;
  profilePath: string;
  instructionsPath: string;
  adapterLaunch: ScratchAdapterLaunch;
};

function assertInsideWorktree(worktreePath: string, childPath: string): void {
  const relative = path.relative(worktreePath, childPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new MaisterError(
      "PRECONDITION",
      `capability materialization path is outside worktree: ${childPath}`,
    );
  }
}

function instructionLines(profile: ResolvedCapabilityProfile): string[] {
  const entries = [...profile.enforced, ...profile.instructed];

  if (entries.length === 0) {
    return ["# Capability profile", "", "No capabilities selected."];
  }

  return [
    "# Capability profile",
    "",
    `Plan mode: ${profile.planMode}`,
    `Work mode: ${profile.workMode}`,
    `Reasoning effort: ${profile.reasoningEffort}`,
    "",
    ...entries.map(
      (entry) =>
        `- ${entry.kind}/${entry.capabilityRefId}: ${entry.enforceability}`,
    ),
  ];
}

export async function materializeCapabilityProfile(
  args: MaterializeCapabilityProfileArgs,
): Promise<MaterializedCapabilityProfile> {
  const worktreePath = path.resolve(args.worktreePath);
  const rootPath = path.join(
    worktreePath,
    ".maister",
    "capabilities",
    args.runId,
  );

  assertInsideWorktree(worktreePath, rootPath);
  await mkdir(rootPath, { recursive: true });

  const profilePath = path.join(rootPath, "profile.json");
  const instructionsPath = path.join(rootPath, "instructions.md");
  const materializedProfile = {
    ...args.profile,
    executor: args.executor ?? null,
    workMode: args.workMode ?? args.profile.workMode,
    reasoningEffort: args.reasoningEffort ?? args.profile.reasoningEffort,
    provisioningBoundary:
      "Selected capabilities are provided as profile/instructions handoff only; native adapter provisioning is future work.",
  };

  await atomicWriteJson(profilePath, materializedProfile);
  await atomicWriteText(
    instructionsPath,
    `${instructionLines(materializedProfile).join("\n")}\n`,
  );

  return {
    rootPath,
    profilePath,
    instructionsPath,
    adapterLaunch: {
      env: {
        MAISTER_CAPABILITY_PROFILE_PATH: profilePath,
        MAISTER_CAPABILITY_INSTRUCTIONS_PATH: instructionsPath,
      },
    },
  };
}
