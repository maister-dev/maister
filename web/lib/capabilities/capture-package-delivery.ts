import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";

import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { packageSkillSourceDigest } from "../../../runtime/package-skill-tree";

import { captureSessionMcpTargets } from "./session-package-catalog";
import { loadSelectableCapabilities } from "./resolver";
import {
  type BoundDeliveryPin,
  type FlowDeliverySnapshot,
  assertPrivateBoundSessionNames,
  resolvePackageSession,
  sessionNameForPackageNode,
} from "./package-delivery";

import { packageManifestEntrySchema } from "@/lib/config.schema";
import { resolveInstalledAgentDefinition } from "@/lib/agents/effective";
import { agentDefinitionSha256 } from "@/lib/agents/activity-snapshot";
import {
  applyProjectAgentProfile,
  readProjectAgentProfile,
} from "@/lib/agents/project-instance-profile";
import { readPackageMcpScopes } from "@/lib/packages/mcp-scope";
import { MaisterError } from "@/lib/errors";

const inputNodes = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      session: z.string().optional(),
      type: z.string(),
      settings: z.unknown().optional(),
    }),
  ),
});
const bundleRow = z.object({
  id: z.string(),
  root: z.string(),
  installId: z.string().nullable(),
  revision: z.string(),
  name: z.string(),
});
const packageRow = z.object({
  name: z.string(),
  installId: z.string(),
  revision: z.string(),
  shareSkills: z.boolean(),
  skills: z.array(z.string()),
  bundleIds: z.array(z.string()),
});

/** Capture only immutable references, the admitted persona and the project sharing decision. */
export async function capturePackageDelivery(
  db: SqlTransaction,
  input: {
    projectId: string;
    flowPackageInstallId: string | null;
    flowManifest: unknown;
    nonPackageMcpRefs: readonly string[];
  },
): Promise<FlowDeliverySnapshot | undefined> {
  const { rows } = await db.execute(sql`
    SELECT a.package_name AS name,i.id AS "installId",i.resolved_revision AS revision,
           (i.manifest->'spec'->'delivery'->>'version'='1') AS versioned,
           COALESCE((i.manifest->'spec'->'delivery'->>'shareSkills')::boolean, true) AS "shareSkills",
           COALESCE(i.manifest->'inventory'->'skills','[]'::jsonb) AS skills,
           i.installed_path AS root,COALESCE(i.manifest->'spec'->'capabilities','[]'::jsonb) AS declarations,
           ARRAY(SELECT b.id FROM capability_imports b WHERE b.project_id=a.project_id
                  AND b.package_install_id=i.id AND b.package_status='Installed' ORDER BY b.id) AS "bundleIds"
      FROM project_package_attachments a LEFT JOIN package_installs selected ON selected.id=${input.flowPackageInstallId} AND selected.name=a.package_name
      JOIN package_installs i ON i.id=COALESCE(selected.id,a.package_install_id)
     WHERE a.project_id=${input.projectId} ORDER BY a.package_name
  `);

  if (!rows.length) return undefined;
  const packages: FlowDeliverySnapshot["packages"] = rows.map((row) => ({
    ...packageRow.parse(row),
    mcps: [],
    skillDigests: {},
  }));
  const { rows: bundleRows } = await db.execute(sql`
    SELECT id,installed_path AS root,package_install_id AS "installId",resolved_revision AS revision,capability_ref_id AS name
      FROM capability_imports WHERE project_id=${input.projectId} AND package_status='Installed' ORDER BY id`);
  const bundles = bundleRows.map((r) => bundleRow.parse(r));

  for (const row of rows) {
    const pkg = packages.find((p) => p.installId === row.installId)!;
    const declared = z
      .array(packageManifestEntrySchema)
      .parse(row.declarations);

    pkg.bundlePaths = {};
    for (const declaration of declared) {
      let bundle = bundles.find(
        (b) => b.installId === pkg.installId && b.name === declaration.id,
      );

      if (!bundle) {
        const id = "pin:" + pkg.installId + ":" + declaration.id;

        bundle = {
          id,
          root: path.join(z.string().parse(row.root), declaration.path),
          installId: pkg.installId,
          revision: pkg.revision,
          name: declaration.id,
        };
        bundles.push(bundle);
        pkg.bundleIds.push(id);
      }
      pkg.bundlePaths[bundle.id] = declaration.path;
    }
  }
  for (const b of bundles) {
    let pin = packages.find((p) => p.installId === b.installId);

    if (!pin && !b.installId) {
      pin = {
        name: "import:" + b.name,
        installId: "import:" + b.id,
        revision: b.revision,
        skills: [],
        shareSkills: true,
        mcps: [],
        bundleIds: [b.id],
        skillDigests: {},
      };
      packages.push(pin);
    }
    if (!pin) continue;
    const root = path.join(b.root, "skills");
    let entries;

    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skill = path.join(root, entry.name);

      try {
        if (!(await lstat(path.join(skill, "SKILL.md"))).isFile()) continue;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      if (Object.hasOwn(pin.skillDigests!, entry.name))
        throw new MaisterError(
          "CONFIG",
          `Package ${pin.name} has multiple providers for skill ${entry.name}`,
        );
      pin.skillDigests![entry.name] = await packageSkillSourceDigest(
        skill,
        b.root,
      );
    }
  }
  for (const pkg of packages)
    pkg.skills = Object.keys(pkg.skillDigests!).sort();

  const scopes = await readPackageMcpScopes(
    db,
    input.projectId,
    input.flowPackageInstallId,
  );
  const nodes = inputNodes.parse(input.flowManifest).nodes;
  const bindings: Record<string, BoundDeliveryPin> = Object.create(null);

  for (const node of nodes) {
    const settings = z.object({ agent: z.string() }).safeParse(node.settings);

    if (!settings.success || node.type !== "ai_coding") continue;
    const agentId = settings.data.agent;
    const pkg = packages.find((p) => agentId.startsWith(p.name + ":"));

    if (!pkg)
      throw new MaisterError(
        "CONFIG",
        `Node ${node.id} requires unattached agent ${agentId}`,
      );
    const definition = await resolveInstalledAgentDefinition(db, {
      agentId,
      packageInstallId: pkg.installId,
    });
    const { rows: links } = await db.execute(
      sql`SELECT l.enabled FROM agent_project_links l WHERE l.project_id=${input.projectId} AND l.agent_id=${agentId}`,
    );

    if (links[0]?.enabled === false)
      throw new MaisterError(
        "PRECONDITION",
        `Project agent ${agentId} is disabled`,
      );
    const profile = links.length
      ? await readProjectAgentProfile(db, input.projectId, agentId)
      : null;
    const applied = applyProjectAgentProfile(definition.parsed, profile);

    bindings[node.id] = {
      agentId,
      installId: pkg.installId,
      definitionDigest: agentDefinitionSha256(definition.parsed),
      mode: definition.parsed.mode,
      ...(definition.parsed.capabilityProfile?.skills !== undefined
        ? { skills: definition.parsed.capabilityProfile.skills }
        : {}),
      mcpRefs: applied.mcpRefs,
      linkRevision: profile?.revision ?? null,
      promptOverride: profile?.promptOverride ?? null,
    };
  }
  const result: FlowDeliverySnapshot = {
    version: 1,
    flowPackageName:
      packages.find((p) => p.installId === input.flowPackageInstallId)?.name ??
      null,
    packages: packages.map((p) => ({
      ...p,
      mcps: scopes
        .filter((s) => s.installId === p.installId)
        .map(({ refId, effective }) => ({ refId, effective })),
    })),
    targets: await captureSessionMcpTargets(
      db,
      input.projectId,
      await loadSelectableCapabilities(input.projectId, db),
    ),
    bindings,
    nonPackageMcpRefs: [
      ...new Set(
        input.nonPackageMcpRefs.filter(
          (ref) => !scopes.some((s) => s.refId === ref),
        ),
      ),
    ].sort(),
  };

  if (rows.some((row) => row.versioned === true))
    assertPrivateBoundSessionNames(
      nodes,
      new Set(
        nodes
          .filter((n) => bindings[n.id]?.mode === "session")
          .map((n) => n.id),
      ),
    );
  const declaredNames = new Set(nodes.map((n) => n.session ?? "default"));

  for (const n of nodes) {
    if (["ai_coding", "orchestrator", "judge"].includes(n.type))
      resolvePackageSession(result, n.id);
    if (
      bindings[n.id]?.mode === "session" &&
      declaredNames.has(
        sessionNameForPackageNode(result, n.id, n.session ?? "default"),
      )
    )
      throw new MaisterError(
        "CONFIG",
        "A declared session name conflicts with a bound agent's private session",
      );
  }

  return result;
}
