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

type CapabilityIdentity = {
  capabilityRefId: string;
  kind: string;
  source: string;
  revision: string | null;
};

export function includeCapturedPlatformMcpTargets(
  records: readonly CapabilityIdentity[],
  delivery: FlowDeliverySnapshot | undefined,
): CapabilityIdentity[] {
  return [
    ...records,
    ...(delivery?.targets ?? [])
      .filter(
        (target) =>
          target.source === "platform" &&
          !records.some(
            (record) =>
              record.kind === "mcp" &&
              record.source === target.source &&
              record.capabilityRefId === target.refId,
          ),
      )
      .map((target) => ({
        capabilityRefId: target.refId,
        kind: "mcp",
        source: target.source,
        revision: target.revision,
      })),
  ];
}

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
    const ordered = [...pins].sort((a, b) => {
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      if (a.installId !== b.installId)
        return a.installId < b.installId ? -1 : 1;

      return 0;
    });
    const pin = ordered[0]!;
    const digest = pin.skillDigests?.[slug];

    if (
      ordered.length > 1 &&
      (!digest ||
        ordered.some((owner) => owner.skillDigests?.[slug] !== digest))
    )
      throw new MaisterError(
        "CONFIG",
        `Skill "${slug}" is provided by multiple shared packages: ${ordered
          .map((p) => `${p.name} (${p.installId})`)
          .join(", ")}`,
      );

    return {
      slug,
      packageName: pin.name,
      installId: pin.installId,
      revision: pin.revision,
      ...(digest ? { digest } : {}),
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
