import type { FlowMetadata, FlowYamlV1, NodeDef } from "@/lib/config.schema";

import { MaisterError } from "@/lib/errors-core";
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
 * When `pos` is given, the canvas spawn {x,y} is written into `presentation` at
 * add time (audit b) so a freshly added node's position survives serialize→
 * reload. Omitting `pos` leaves presentation untouched (back-compat).
 */
export function addNode(
  manifest: FlowYamlV1,
  type: NodeType,
  id: string,
  pos?: { x: number; y: number },
): FlowYamlV1 {
  const existing = (manifest.nodes ?? []).find((n) => n.id === id);

  if (existing) {
    throw new MaisterError("CONFIG", `Node id "${id}" already exists`);
  }

  const newNode = blankNode(type, id);

  const withNode: FlowYamlV1 = {
    ...manifest,
    nodes: [
      ...(manifest.nodes ?? []),
      newNode as NonNullable<FlowYamlV1["nodes"]>[number],
    ],
  };

  return pos ? moveNode(withNode, id, pos) : withNode;
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
 * True if `fromId` already declares a transition for `outcome`. Pure read used
 * by the typed-edge connect modal (D7) to warn that confirming will retarget the
 * existing edge rather than add a new one. No-throw; unknown source → false.
 */
export function outcomeExistsForSource(
  manifest: FlowYamlV1,
  fromId: string,
  outcome: string,
): boolean {
  const node = (manifest.nodes ?? []).find((n) => n.id === fromId);

  return node?.transitions?.[outcome] !== undefined;
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
 * Replace the node with id `id` wholesale (same array position). Used by the
 * side-form, which edits a node's detail fields (action/settings/transitions/
 * rework/output/finish/gates) and emits the full rebuilt node. No-op-safe if
 * the id is absent; always returns a new object. The caller keeps the id stable
 * (renames are not handled here — transitions pointing at the old id would
 * dangle).
 */
export function replaceNode(
  manifest: FlowYamlV1,
  id: string,
  node: NonNullable<FlowYamlV1["nodes"]>[number],
): FlowYamlV1 {
  const updatedNodes = (manifest.nodes ?? []).map((n) =>
    n.id === id ? node : n,
  );

  return { ...manifest, nodes: updatedNodes };
}

// Prune a metadata draft to a schema-valid shape: trim strings, drop empties,
// filter blank label rows and incomplete link/source rows. Returns null when
// nothing survives (so the caller can drop the key rather than emit `{}`, which
// the strict flowMetadataSchema rejects).
function pruneMetadata(m: FlowMetadata): FlowMetadata | null {
  const out: FlowMetadata = {};
  const title = m.title?.trim();
  const summary = m.summary?.trim();
  const routeWhen = m.route_when?.trim();

  if (title) out.title = title;
  if (summary) out.summary = summary;
  if (routeWhen) out.route_when = routeWhen;

  const labels = (m.labels ?? [])
    .map((label) => label.trim())
    .filter((label) => label.length > 0);

  if (labels.length > 0) out.labels = labels;

  const links = (m.links ?? [])
    .filter((link) => link.title.trim() && link.url.trim())
    .map((link) => {
      const kind = link.kind?.trim();

      return {
        ...(kind ? { kind } : {}),
        title: link.title.trim(),
        url: link.url.trim(),
      };
    });

  if (links.length > 0) out.links = links;

  const sources = (m.sources ?? [])
    .filter((source) => source.component.trim() && source.origin.trim())
    .map((source) => ({
      component: source.component.trim(),
      origin: source.origin.trim(),
    }));

  if (sources.length > 0) out.sources = sources;

  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Replace the flow-level `metadata` block (title/summary/labels/route_when/
 * links/sources). Raw + immutable, mirroring replaceNode: blank rows are KEPT so
 * the side-form's add-row affordance works mid-edit. The canvas→YAML serialize
 * boundary prunes them via pruneManifestMetadata, exactly as node list fields are
 * pruned there (pruneEmptyListEntries) — never per-keystroke.
 */
export function setMetadata(
  manifest: FlowYamlV1,
  next: FlowMetadata,
): FlowYamlV1 {
  return { ...manifest, metadata: next };
}

/**
 * Serialize-time cleanup of the metadata block: trims strings, drops empties and
 * blank label rows, filters incomplete link/source rows, and removes the
 * `metadata` key entirely when nothing survives — so the strict flowMetadataSchema
 * never sees `metadata: {}` or a blank row. Pure; no-op when metadata is absent.
 */
export function pruneManifestMetadata(manifest: FlowYamlV1): FlowYamlV1 {
  if (manifest.metadata === undefined) return manifest;

  const cleaned = pruneMetadata(manifest.metadata);

  if (cleaned) return { ...manifest, metadata: cleaned };

  const rest = { ...manifest };

  delete rest.metadata;

  return rest;
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
