import "server-only";

import type {
  ConsensusRunnerInspection,
  ConsensusRunnerSlotPreview,
} from "@/lib/acp-runners/consensus-preflight";
import type {
  RunSessionResolution,
  RunSessionResolutionInput,
} from "@/lib/acp-runners/resolve";
import type { FlowYamlV1 } from "@/lib/config.schema";

import {
  inspectConsensusRunners,
  toConsensusRunnerSlotPreview,
} from "@/lib/acp-runners/consensus-preflight";
import { resolveRunSessions } from "@/lib/acp-runners/resolve";
import { isMaisterError, MaisterError } from "@/lib/errors";
import { compileManifest } from "@/lib/flows/graph/compile";

export type SessionRunnerInspection = {
  readonly slotKey: string;
  readonly label: string;
  readonly kind: "session";
  readonly mappedRunnerId: string | null;
  readonly sessionName: string;
  readonly declaresRunner: boolean;
  readonly bindable: boolean;
} & (
  | { readonly status: "resolved"; readonly resolution: RunSessionResolution }
  | { readonly status: "unresolved"; readonly error: MaisterError }
);

export type FlowRunnerInspection = {
  readonly primarySessionName: string;
  readonly sessions: readonly SessionRunnerInspection[];
  readonly consensus: readonly ConsensusRunnerInspection[];
};

export type FlowRunnerSlotPreview = Omit<ConsensusRunnerSlotPreview, "kind"> & {
  readonly kind: "session" | ConsensusRunnerSlotPreview["kind"];
};

type FlowRunnerInspectionInput = Omit<
  RunSessionResolutionInput,
  "sessions" | "runnerProfiles" | "runDefaultRunnerId" | "ephemeralOverrides"
> & {
  readonly manifest: FlowYamlV1;
  readonly taskRunnerId?: string | null;
  readonly launchOverrideRunnerId?: string | null;
  readonly sessionRunnerOverrides?: Readonly<Record<string, string | null>>;
};

/** Inspect every session and consensus role with the actual launch precedence. */
export function inspectFlowRunners(
  input: FlowRunnerInspectionInput,
): FlowRunnerInspection {
  const compiledSessions = [
    ...compileManifest(input.manifest).sessions.values(),
  ];
  const sessionSlots =
    compiledSessions.length > 0 ? compiledSessions : [{ name: "default" }];
  const primarySessionName =
    sessionSlots.find((session) => session.name === "default")?.name ??
    sessionSlots[0].name;
  const ephemeralOverrides = {
    ...(input.taskRunnerId ? { [primarySessionName]: input.taskRunnerId } : {}),
    ...(input.sessionRunnerOverrides ?? {}),
    ...(input.launchOverrideRunnerId
      ? { [primarySessionName]: input.launchOverrideRunnerId }
      : {}),
  };
  const sessions = sessionSlots.map((session): SessionRunnerInspection => {
    const slotKey = `session:${session.name}`;
    const binding = input.bindings.find((entry) => entry.slotKey === slotKey);
    const descriptor = {
      slotKey,
      label: session.name,
      kind: "session" as const,
      mappedRunnerId:
        binding?.status === "Mapped" ? binding.mappedRunnerId : null,
      sessionName: session.name,
      declaresRunner: session.runner !== undefined,
      bindable: compiledSessions.length > 0,
    };

    try {
      const [resolution] = resolveRunSessions({
        ...input,
        sessions: [session],
        runnerProfiles: input.manifest.runner_profiles,
        runDefaultRunnerId: input.launchOverrideRunnerId ?? input.taskRunnerId,
        ephemeralOverrides,
      });

      return { ...descriptor, status: "resolved", resolution };
    } catch (error) {
      if (
        !isMaisterError(error) ||
        (error.code !== "CONFIG" && error.code !== "EXECUTOR_UNAVAILABLE")
      ) {
        throw error;
      }

      return { ...descriptor, status: "unresolved", error };
    }
  });
  const primary = sessions.find(
    (session) => session.sessionName === primarySessionName,
  );
  const consensus = inspectConsensusRunners({
    ...input,
    runDefaultRunnerId:
      primary?.status === "resolved" ? primary.resolution.runnerId : null,
  });

  return { primarySessionName, sessions, consensus };
}

/** Only declared slots can be bound through the project binding API. */
export function toFlowRunnerSlotPreviews(
  inspection: FlowRunnerInspection,
): FlowRunnerSlotPreview[] {
  return [
    ...inspection.sessions
      .filter((session) => session.bindable)
      .map(
        (session): FlowRunnerSlotPreview => ({
          slotKey: session.slotKey,
          label: session.label,
          kind: session.kind,
          mappedRunnerId: session.mappedRunnerId,
          runnerId:
            session.status === "resolved" ? session.resolution.runnerId : null,
          errorCode:
            session.status === "unresolved" ? session.error.code : null,
        }),
      ),
    ...inspection.consensus.map(toConsensusRunnerSlotPreview),
  ];
}
