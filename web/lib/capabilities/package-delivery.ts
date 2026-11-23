import { createHash } from "node:crypto";

import { MaisterError } from "@/lib/errors";

export type PackageDeliveryPin = {
  name: string;
  installId: string;
  revision: string;
  skills: string[];
  shareSkills: boolean;
  mcps: { refId: string; effective: "project" | "package" }[];
  bundleIds: string[];
  bundlePaths?: Record<string, string>;
  skillDigests?: Record<string, string>;
};

export type BoundDeliveryPin = {
  agentId: string;
  installId: string;
  definitionDigest: string;
  mode: "session" | "subagent";
  skills?: string[];
  mcpRefs: string[];
  promptOverride: string | null;
  linkRevision: number | null;
};

export type FlowDeliverySnapshot = {
  version: 1;
  flowPackageName: string | null;
  packages: PackageDeliveryPin[];
  bindings: Record<string, BoundDeliveryPin>;
  nonPackageMcpRefs: string[];
  targets?: import("./mcp-targets").AgentMcpTarget[];
};

export type PackageSkillWitness = {
  slug: string;
  packageName: string;
  installId: string;
  revision: string;
  digest?: string;
};

export function sessionNameForPackageNode(
  delivery: FlowDeliverySnapshot | undefined,
  nodeId: string,
  declaredName: string,
): string {
  const bound = delivery?.bindings[nodeId];
  if (bound?.mode !== "session") return declaredName;
  return (
    "bound-" +
    createHash("sha256")
      .update(JSON.stringify([nodeId, bound.agentId]))
      .digest("hex")
      .slice(0, 32)
  );
}

/** Higher-ranked owners shadow libraries. Equal-rank independent providers cannot silently exchange bytes. */
export function resolvePackageSession(
  delivery: FlowDeliverySnapshot,
  nodeId: string,
  nodeMcps?: readonly string[],
): { skills: PackageSkillWitness[]; mcps: string[] } {
  const bound =
    delivery.bindings[nodeId]?.mode === "session"
      ? delivery.bindings[nodeId]
      : undefined;
  const skills = new Map<
    string,
    { rank: number; pins: PackageDeliveryPin[] }
  >();
  const sharedMcps = new Set<string>();
  const localMcps = new Set<string>(delivery.nonPackageMcpRefs);
  for (const pkg of delivery.packages) {
    const agentOwner = pkg.installId === bound?.installId;
    const flowOwner = pkg.name === delivery.flowPackageName;
    const rank = agentOwner ? 3 : flowOwner ? 2 : pkg.shareSkills ? 1 : 0;
    for (const ref of pkg.mcps) {
      if (ref.effective === "project") sharedMcps.add(ref.refId);
      if (!bound && flowOwner) localMcps.add(ref.refId);
    }
    if (!rank) continue;
    for (const slug of agentOwner && bound?.skills !== undefined
      ? bound.skills
      : pkg.skills) {
      const existing = skills.get(slug);
      if (!existing || existing.rank < rank)
        skills.set(slug, { rank, pins: [pkg] });
      else if (existing.rank === rank) existing.pins.push(pkg);
    }
  }
  for (const ref of bound?.mcpRefs ?? []) localMcps.add(ref);
  const selected = Array.from(skills, ([slug, { pins }]) => {
    if (pins.length !== 1)
      throw new MaisterError(
        "CONFIG",
        `Skill "${slug}" is provided by multiple shared packages: ${pins
          .map((p) => p.name)
          .sort()
          .join(", ")}`,
      );
    const pin = pins[0]!;
    return {
      slug,
      packageName: pin.name,
      installId: pin.installId,
      revision: pin.revision,
      ...(pin.skillDigests?.[slug] ? { digest: pin.skillDigests[slug] } : {}),
    };
  }).sort((a, b) => a.slug.localeCompare(b.slug));
  return {
    skills: selected,
    mcps: [...new Set([...(nodeMcps ?? localMcps), ...sharedMcps])].sort(),
  };
}

export function assertPrivateBoundSessionNames(
  nodes: readonly { id: string; session?: string }[],
  boundNodeIds: ReadonlySet<string>,
): void {
  for (const node of nodes) {
    if (
      !boundNodeIds.has(node.id) ||
      !node.session ||
      node.session === "default"
    )
      continue;
    const sibling = nodes.find(
      (other) => other.id !== node.id && other.session === node.session,
    );
    if (sibling)
      throw new MaisterError(
        "CONFIG",
        `Session agent node ${node.id} cannot share named session ${node.session} with ${sibling.id}; assign separate session names`,
      );
  }
}

export function publicCapabilitySet<
  T extends { delivery?: FlowDeliverySnapshot },
>(snapshot: T): Omit<T, "delivery"> {
  const { delivery: _delivery, ...visible } = snapshot;
  return visible;
}
