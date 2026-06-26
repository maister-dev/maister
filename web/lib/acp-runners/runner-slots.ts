import "server-only";

import type { FlowYamlV1, RunnerSlot } from "@/lib/config.schema";

import { runnerSlotProfileRef } from "@/lib/config.schema";
import { compileManifest } from "@/lib/flows/graph/compile";

// M42 (ADR-114): a bindable runner slot in a flow revision. `slotKey` is the
// stable per-slot binding key:
//   - `session:<name>`                          (one per logical session)
//   - `consensus:<nodeId>:<participantId>`       (one per runner-bearing participant)
//   - `consensus:<nodeId>:synthesizer`           (the consensus synthesizer)
// Slots are NEVER deduped by intent — two identical-intent consensus
// participants are distinct, independently-bindable slots.
export type RunnerSlotKind =
  | "session"
  | "consensus_participant"
  | "consensus_synthesizer";

export type RunnerSlotDescriptor = {
  slotKey: string;
  kind: RunnerSlotKind;
  // A human label for the binding UI (the session name or `nodeId · participant`).
  label: string;
  // The slot's declared runner config (profile-ref string OR inline object).
  // Undefined for the implicit `default` session with no explicit runner —
  // that slot resolves via the precedence chain, not a binding.
  runner?: RunnerSlot;
  // The `runner_profiles` ref string when `runner` is a bare string; undefined
  // for an inline-object config.
  profileRef?: string;
};

function slotFor(
  slotKey: string,
  kind: RunnerSlotKind,
  label: string,
  runner: RunnerSlot | undefined,
): RunnerSlotDescriptor {
  const profileRef = runnerSlotProfileRef(runner);

  return {
    slotKey,
    kind,
    label,
    ...(runner !== undefined ? { runner } : {}),
    ...(profileRef !== undefined ? { profileRef } : {}),
  };
}

// Enumerate every bindable runner slot in a compiled flow manifest: one per
// logical session plus one per runner-bearing consensus participant and the
// consensus synthesizer. Order is deterministic (sessions first, then consensus
// nodes in graph order).
export function enumerateRunnerSlots(
  manifest: FlowYamlV1,
): RunnerSlotDescriptor[] {
  const graph = compileManifest(manifest);
  const slots: RunnerSlotDescriptor[] = [];

  for (const session of graph.sessions.values()) {
    slots.push(
      slotFor(`session:${session.name}`, "session", session.name, session.runner),
    );
  }

  for (const node of graph.nodes.values()) {
    if (node.nodeType !== "consensus" || node.source.kind !== "node") continue;

    const def = node.source.node;

    if (def.type !== "consensus") continue;

    for (const participant of def.participants) {
      if (participant.runner === undefined) continue; // agent-bound: no runner slot

      slots.push(
        slotFor(
          `consensus:${node.id}:${participant.id}`,
          "consensus_participant",
          `${node.id} · ${participant.id}`,
          participant.runner,
        ),
      );
    }

    if (def.synthesizer.runner !== undefined) {
      slots.push(
        slotFor(
          `consensus:${node.id}:synthesizer`,
          "consensus_synthesizer",
          `${node.id} · synthesizer`,
          def.synthesizer.runner,
        ),
      );
    }
  }

  return slots;
}
