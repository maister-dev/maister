import type { FlowYamlV1, NodeDef } from "@/lib/config.schema";

import { MaisterError } from "@/lib/errors";
import {
  applyPresentation,
  readPresentation,
} from "@/lib/flows/editor/manifest-io";
import {
  GATE_KINDS,
  NODE_TYPES,
  blankGate,
  blankNode,
} from "@/lib/flows/editor/node-form";

export type NodeType = (typeof NODE_TYPES)[number];
export type GateKind = (typeof GATE_KINDS)[number];

/**
 * Append a blank node of `type` with `id`.
 * Throws MaisterError("CONFIG") if the id already exists in nodes[].
 */
export function addNode(
  manifest: FlowYamlV1,
  type: NodeType,
  id: string,
): FlowYamlV1 {
  const existing = (manifest.nodes ?? []).find((n) => n.id === id);

  if (existing) {
    throw new MaisterError("CONFIG", `Node id "${id}" already exists`);
  }

  const newNode = blankNode(type, id);

  return {
    ...manifest,
    nodes: [
      ...(manifest.nodes ?? []),
      newNode as NonNullable<FlowYamlV1["nodes"]>[number],
    ],
  };
}

/**
 * Remove node `id`:
 * - drops it from nodes[]
 * - scrubs any transitions pointing at it (deletes those outcome entries)
 * - drops it from every node's rework.allowedTargets
 * - drops its presentation entry
 *
 * No-op-safe if absent; always returns a new object.
 */
export function removeNode(manifest: FlowYamlV1, id: string): FlowYamlV1 {
  const filteredNodes = (manifest.nodes ?? [])
    .filter((n) => n.id !== id)
    .map((n) => {
      let changed = false;
      let updatedNode = n;

      // Scrub transitions pointing at `id`
      if (n.transitions) {
        const newTransitions: Record<string, string> = {};

        for (const [outcome, target] of Object.entries(n.transitions)) {
          if (target !== id) {
            newTransitions[outcome] = target;
          } else {
            changed = true;
          }
        }

        if (changed) {
          updatedNode = { ...updatedNode, transitions: newTransitions };
        }
      }

      // Drop from rework.allowedTargets
      if (n.rework?.allowedTargets.includes(id)) {
        const newTargets = n.rework.allowedTargets.filter((t) => t !== id);

        updatedNode = {
          ...updatedNode,
          rework: { ...n.rework, allowedTargets: newTargets },
        };
        changed = true;
      }

      return changed ? updatedNode : n;
    });

  // Drop presentation entry
  const currentPres = readPresentation(manifest);
  const filteredPres = currentPres.filter((p) => p.id !== id);
  const updatedManifest = { ...manifest, nodes: filteredNodes };

  return applyPresentation(updatedManifest, filteredPres);
}

/**
 * Set nodes[fromId].transitions[outcome] = target.
 * If target is null, delete that outcome entry.
 */
export function setTransition(
  manifest: FlowYamlV1,
  fromId: string,
  outcome: string,
  target: string | null,
): FlowYamlV1 {
  const updatedNodes = (manifest.nodes ?? []).map((n) => {
    if (n.id !== fromId) {
      return n;
    }

    const current = n.transitions ?? {};

    if (target === null) {
      const next = { ...current };

      delete next[outcome];

      return { ...n, transitions: next };
    }

    return { ...n, transitions: { ...current, [outcome]: target } };
  });

  return { ...manifest, nodes: updatedNodes };
}

/**
 * Replace nodes[id].settings wholesale.
 */
export function setNodeSettings(
  manifest: FlowYamlV1,
  id: string,
  settings: unknown,
): FlowYamlV1 {
  const updatedNodes = (manifest.nodes ?? []).map((n): NodeDef => {
    if (n.id !== id) {
      return n;
    }

    // NodeDef is a discriminated union; casting through unknown preserves the
    // discriminant while replacing the opaque settings field (validated
    // externally by the side-form before this call).
    return { ...n, settings: settings } as unknown as NodeDef;
  });

  return { ...manifest, nodes: updatedNodes };
}

/**
 * Replace nodes[id].action wholesale.
 */
export function setNodeAction(
  manifest: FlowYamlV1,
  id: string,
  action: unknown,
): FlowYamlV1 {
  const updatedNodes = (manifest.nodes ?? []).map((n): NodeDef => {
    if (n.id !== id) {
      return n;
    }

    // Same rationale: action is a validated object from the side-form; the
    // discriminant `type` is unchanged — only the action payload is swapped.
    return { ...n, action: action } as unknown as NodeDef;
  });

  return { ...manifest, nodes: updatedNodes };
}

/**
 * Add a blank gate of `kind` (id `gateId`) to nodes[nodeId].pre_finish.gates.
 * Throws CONFIG on duplicate gateId within the node.
 */
export function addGate(
  manifest: FlowYamlV1,
  nodeId: string,
  kind: GateKind,
  gateId: string,
): FlowYamlV1 {
  const updatedNodes = (manifest.nodes ?? []).map((n) => {
    if (n.id !== nodeId) {
      return n;
    }

    const existingGates = n.pre_finish?.gates ?? [];
    const dup = existingGates.find((g) => g.id === gateId);

    if (dup) {
      throw new MaisterError(
        "CONFIG",
        `Gate id "${gateId}" already exists on node "${nodeId}"`,
      );
    }

    const newGate = blankGate(kind, gateId) as NonNullable<
      NonNullable<typeof n.pre_finish>["gates"]
    >[number];
    const newGates = [...existingGates, newGate];

    return {
      ...n,
      pre_finish: { ...(n.pre_finish ?? {}), gates: newGates },
    };
  });

  return { ...manifest, nodes: updatedNodes };
}

/**
 * Remove gate `gateId` from nodes[nodeId].pre_finish.gates.
 * No-op if the gate does not exist; always returns a new object.
 */
export function removeGate(
  manifest: FlowYamlV1,
  nodeId: string,
  gateId: string,
): FlowYamlV1 {
  const updatedNodes = (manifest.nodes ?? []).map((n) => {
    if (n.id !== nodeId) {
      return n;
    }

    const existingGates = n.pre_finish?.gates ?? [];
    const filteredGates = existingGates.filter((g) => g.id !== gateId);

    return {
      ...n,
      pre_finish: { ...(n.pre_finish ?? {}), gates: filteredGates },
    };
  });

  return { ...manifest, nodes: updatedNodes };
}

/**
 * Update the presentation layout for a node (merges with existing entry).
 * Delegates to manifest-io applyPresentation.
 */
export function moveNode(
  manifest: FlowYamlV1,
  id: string,
  pos: {
    x: number;
    y: number;
    width?: number;
    height?: number;
    color?: string;
  },
): FlowYamlV1 {
  const current = readPresentation(manifest);
  const existing = current.find((p) => p.id === id) ?? { id };

  const updated = {
    ...existing,
    x: pos.x,
    y: pos.y,
    ...(pos.width !== undefined ? { width: pos.width } : {}),
    ...(pos.height !== undefined ? { height: pos.height } : {}),
    ...(pos.color !== undefined ? { color: pos.color } : {}),
  };

  const merged = [...current.filter((p) => p.id !== id), updated];

  return applyPresentation(manifest, merged);
}
