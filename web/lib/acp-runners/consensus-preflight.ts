import "server-only";

import type {
  ResolvedRunnerSlot,
  RunnerCatalogEntry,
  RunnerSlotBinding,
} from "@/lib/acp-runners/resolve";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { MaisterErrorCode } from "@/lib/errors-core";

import { resolveConsensusRunner } from "@/lib/acp-runners/resolve";
import { enumerateRunnerSlots } from "@/lib/acp-runners/runner-slots";
import { isMaisterError, MaisterError } from "@/lib/errors";

type ConsensusRunnerSlot = {
  readonly slotKey: string;
  readonly label: string;
  readonly kind: "consensus_participant" | "consensus_synthesizer";
  readonly mappedRunnerId: string | null;
};

export type ConsensusRunnerInspection = ConsensusRunnerSlot &
  (
    | { readonly status: "resolved"; readonly resolution: ResolvedRunnerSlot }
    | { readonly status: "unresolved"; readonly error: MaisterError }
  );

export type ConsensusRunnerSlotPreview = ConsensusRunnerSlot & {
  readonly runnerId: string | null;
  readonly errorCode: MaisterErrorCode | null;
};

/** Resolve every runner-bearing consensus role before any draft can start. */
export function inspectConsensusRunners(input: {
  readonly manifest: FlowYamlV1;
  readonly bindings: readonly RunnerSlotBinding[];
  readonly runDefaultRunnerId: string | null;
  readonly project: { readonly defaultRunnerId?: string | null };
  readonly platform: { readonly defaultRunnerId?: string | null };
  readonly runners: readonly RunnerCatalogEntry[];
}): ConsensusRunnerInspection[] {
  return enumerateRunnerSlots(input.manifest).flatMap(
    (slot): ConsensusRunnerInspection[] => {
      if (slot.kind === "session" || slot.runner === undefined) return [];

      const binding = input.bindings.find(
        (entry) => entry.slotKey === slot.slotKey,
      );
      const descriptor: ConsensusRunnerSlot = {
        slotKey: slot.slotKey,
        label: slot.label,
        kind: slot.kind,
        mappedRunnerId:
          binding?.status === "Mapped" ? binding.mappedRunnerId : null,
      };

      try {
        const resolution = resolveConsensusRunner({
          slotKey: slot.slotKey,
          slot: slot.runner,
          runnerProfiles: input.manifest.runner_profiles,
          binding,
          runDefaultRunnerId: input.runDefaultRunnerId,
          project: input.project,
          platform: input.platform,
          runners: input.runners,
        });

        return [{ ...descriptor, status: "resolved", resolution }];
      } catch (error) {
        if (
          !isMaisterError(error) ||
          (error.code !== "CONFIG" && error.code !== "EXECUTOR_UNAVAILABLE")
        ) {
          throw error;
        }

        return [{ ...descriptor, status: "unresolved", error }];
      }
    },
  );
}

/** Keep diagnostic messages and provider snapshots on the server. */
export function toConsensusRunnerSlotPreview(
  inspection: ConsensusRunnerInspection,
): ConsensusRunnerSlotPreview {
  return {
    slotKey: inspection.slotKey,
    label: inspection.label,
    kind: inspection.kind,
    mappedRunnerId: inspection.mappedRunnerId,
    runnerId:
      inspection.status === "resolved" ? inspection.resolution.runnerId : null,
    errorCode:
      inspection.status === "unresolved" ? inspection.error.code : null,
  };
}
