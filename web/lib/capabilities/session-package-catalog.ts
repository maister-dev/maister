import "server-only";

import type { AgentMcpTarget } from "./mcp-targets";
import type { CapabilityCatalogRecord } from "./types";
import type {
  FlowDeliverySnapshot,
  PackageSkillWitness,
} from "./package-delivery";
import type { SqlTransaction } from "@/lib/db/sql-types";
import type { ResolvedCapabilitySet } from "@/lib/db/schema";

import { sql } from "drizzle-orm";

import {
  loadSelectableCapabilities,
  pinCatalogToSnapshot,
  type McpBindingInput,
} from "./resolver";
import { agentMcpTargets } from "./mcp-targets";

import {
  loadProjectMcpBindings,
  loadProjectMcpOverlays,
} from "@/lib/mcp/binding-service";
import { packageManifestMcpSchema } from "@/lib/config.schema";
import { packageMcpMaterial } from "@/lib/packages/mcp-material";
import { MaisterError } from "@/lib/errors";

/** Readiness is a probe observation. The canonical identity seals executable configuration and the project overlay. */
export async function captureSessionMcpTargets(
  db: SqlTransaction,
  projectId: string,
  catalog: CapabilityCatalogRecord[],
): Promise<AgentMcpTarget[]> {
  const [bindings, overlays] = await Promise.all([
    loadProjectMcpBindings(projectId, db),
    loadProjectMcpOverlays(projectId, db),
  ]);
  const records = catalog.filter((r) => r.kind === "mcp");

  return agentMcpTargets(
    records.map((r) => r.capabilityRefId),
    records,
    bindings,
    overlays,
  );
}
/** Preserve admitted content while rechecking attachment, original release trust and the current target. */
export async function resolveCurrentPackageSessionCatalog(
  db: SqlTransaction,
  input: {
    projectId: string;
    snapshot: ResolvedCapabilitySet;
    delivery: FlowDeliverySnapshot;
    skills: PackageSkillWitness[];
    selected: readonly string[];
    required: readonly string[];
    bindings: readonly McpBindingInput[];
  },
): Promise<{
  catalog: CapabilityCatalogRecord[];
  mcps: string[];
  withheld: string[];
}> {
  const { snapshot, delivery } = input;
  const live = pinCatalogToSnapshot(
    await loadSelectableCapabilities(input.projectId, db),
    snapshot,
  );
  const retained = delivery.packages.filter(
    (p) => !p.installId.startsWith("import:"),
  );
  const { rows } = await db.execute(sql`
    SELECT i.id,i.name,i.manifest->'spec'->'mcps' AS mcps,i.trust_status AS trust FROM package_installs i
      JOIN project_package_attachments a ON a.package_name=i.name AND a.project_id=${input.projectId}
     WHERE i.id=ANY(${sql.param(retained.map((p) => p.installId))}::text[]) AND i.package_status='Installed'
  `);

  for (const skill of input.skills) {
    if (
      !skill.installId.startsWith("import:") &&
      !rows.some(
        (row) =>
          row.id === skill.installId &&
          ["trusted", "trusted_by_policy"].includes(String(row.trust)),
      )
    )
      throw new MaisterError(
        "PRECONDITION",
        `Package access or trust was revoked for ${skill.packageName}:${skill.slug}`,
      );
  }
  const catalog: CapabilityCatalogRecord[] = live.filter(
    (r) => r.kind !== "mcp",
  );

  for (const record of live.filter((r) => r.kind === "mcp")) {
    const ref = record.capabilityRefId;
    const witness = snapshot.mcps.find((m) => m.refId === ref);

    if (!witness) continue;
    const binding = input.bindings.find((b) => b.refId === ref);

    if (binding && !binding.enabled) continue;
    if (
      witness.boundTarget &&
      (binding?.targetId !== witness.boundTarget.id ||
        binding.targetKind !== witness.boundTarget.kind)
    )
      continue;
    if (
      !witness.boundTarget &&
      binding &&
      binding.targetId !== (record.source === "platform" ? ref : record.id)
    )
      continue;
    if (record.source !== "flow-package") {
      if (witness.sha === record.revision) catalog.push(record);
      continue;
    }
    const pkg = retained.find((p) => p.mcps.some((m) => m.refId === ref));

    if (!pkg) continue;
    const row = rows.find(
      (r) =>
        r.id === pkg.installId &&
        ["trusted", "trusted_by_policy"].includes(String(r.trust)),
    );

    if (!row || !Array.isArray(row.mcps)) continue;
    const source = row.mcps
      .map((m) => packageManifestMcpSchema.parse(m))
      .find((m) => m.id === ref);

    if (!source || !source.transport) continue;
    catalog.push({
      ...record,
      revision: pkg.revision,
      material: packageMcpMaterial(source, pkg.installId),
    });
  }
  const now = await captureSessionMcpTargets(db, input.projectId, catalog);
  const matches = (ref: string): boolean => {
    if (!delivery.targets) return true;
    const before = delivery.targets.find((t) => t.refId === ref),
      current = now.find((t) => t.refId === ref);

    return (
      !!before &&
      !!current &&
      before.source === current.source &&
      before.revision === current.revision &&
      before.materialSha256 === current.materialSha256 &&
      (before.source === "flow-package" || before.recordId === current.recordId)
    );
  };
  const mcps = input.selected.filter(
    (ref) =>
      matches(ref) &&
      catalog.some((c) => c.kind === "mcp" && c.capabilityRefId === ref),
  );
  const withheld = input.selected.filter((ref) => !mcps.includes(ref));

  for (const ref of input.required)
    if (!mcps.includes(ref))
      throw new MaisterError(
        "PRECONDITION",
        `Required MCP ${ref} is unavailable under its captured target`,
      );

  return { catalog, mcps, withheld };
}
