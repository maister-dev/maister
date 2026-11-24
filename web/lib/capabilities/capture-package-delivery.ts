import "server-only";

import type { SqlTransaction } from "@/lib/db/sql-types";

import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { packageSkillSourceDigest } from "../../../runtime/package-skill-tree";

import { captureSessionMcpTargets } from "./session-package-catalog";
import { loadSelectableCapabilities } from "./resolver";
import { withBoundPlatformMcpRecords } from "./bound-platform-mcps";
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
import { retryDigest } from "@/lib/agents/retry-guards";
import {
  applyProjectAgentProfile,
  readProjectAgentProfile,
  type ProjectAgentProfile,
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
const packageSourceRow = z.object({
  pin: packageRow,
  root: z.string(),
  declarations: z.array(packageManifestEntrySchema),
  versioned: z.boolean().nullable(),
  trustStatus: z.string(),
  packageStatus: z.string(),
  manifestDigest: z.string(),
  attachmentId: z.string(),
});

export type PackageDeliveryInput = Readonly<{
  projectId: string;
  flowPackageInstallId: string | null;
  flowManifest: unknown;
  nonPackageMcpRefs: readonly string[];
}>;

type PackageDeliverySource = {
  packages: z.infer<typeof packageSourceRow>[];
  bundles: z.infer<typeof bundleRow>[];
  scopes: Awaited<ReturnType<typeof readPackageMcpScopes>>;
  targets: Awaited<ReturnType<typeof captureSessionMcpTargets>>;
  nodes: z.infer<typeof inputNodes>["nodes"];
  assignments: {
    nodeId: string;
    agentId: string;
    installId: string;
    profile: ProjectAgentProfile | null;
  }[];
};

export type PackageDeliveryCapture = (
  db: SqlTransaction,
  input: PackageDeliveryInput,
) => Promise<FlowDeliverySnapshot | undefined>;

async function readPackageDeliverySource(
  db: SqlTransaction,
  input: PackageDeliveryInput,
): Promise<PackageDeliverySource | null> {
  const { rows } = await db.execute(sql`
    SELECT a.package_name AS name,i.id AS "installId",i.resolved_revision AS revision,
           a.id AS "attachmentId", i.package_status AS "packageStatus", i.trust_status AS "trustStatus", i.manifest_digest AS "manifestDigest",
           (i.manifest->'spec'->'delivery'->>'version'='1') AS versioned,
           COALESCE((i.manifest->'spec'->'delivery'->>'shareSkills')::boolean, true) AS "shareSkills",
           COALESCE(i.manifest->'inventory'->'skills','[]'::jsonb) AS skills,
           i.installed_path AS root,COALESCE(i.manifest->'spec'->'capabilities','[]'::jsonb) AS declarations,
           ARRAY(SELECT b.id FROM capability_imports b WHERE b.project_id=a.project_id
                  AND b.package_install_id=i.id AND b.package_status='Installed' ORDER BY b.id) AS "bundleIds"
      FROM project_package_attachments a LEFT JOIN package_installs selected ON selected.id=${input.flowPackageInstallId} AND selected.name=a.package_name
      JOIN package_installs i ON i.id=COALESCE(selected.id,a.package_install_id)
     WHERE a.project_id=${input.projectId} ORDER BY a.package_name FOR SHARE OF a, i
  `);

  if (!rows.length) return null;
  const packages = rows.map((row) =>
    packageSourceRow.parse({ ...row, pin: row }),
  );
  const { rows: bundleRows } = await db.execute(sql`
    SELECT id,installed_path AS root,package_install_id AS "installId",resolved_revision AS revision,capability_ref_id AS name
      FROM capability_imports WHERE project_id=${input.projectId} AND package_status='Installed' ORDER BY id`);
  const nodes = inputNodes.parse(input.flowManifest).nodes;
  const assignments: PackageDeliverySource["assignments"] = [];

  for (const node of nodes) {
    const settings = z.object({ agent: z.string() }).safeParse(node.settings);

    if (!settings.success || node.type !== "ai_coding") continue;
    const agentId = settings.data.agent;
    const pkg = packages.find(({ pin }) => agentId.startsWith(pin.name + ":"));

    if (!pkg)
      throw new MaisterError(
        "CONFIG",
        `Node ${node.id} requires unattached agent ${agentId}`,
      );
    const { rows: links } = await db.execute(
      sql`SELECT l.enabled FROM agent_project_links l WHERE l.project_id=${input.projectId} AND l.agent_id=${agentId} FOR SHARE OF l`,
    );

    if (links[0]?.enabled === false)
      throw new MaisterError(
        "PRECONDITION",
        `Project agent ${agentId} is disabled`,
      );
    assignments.push({
      nodeId: node.id,
      agentId,
      installId: pkg.pin.installId,
      profile: links.length
        ? await readProjectAgentProfile(db, input.projectId, agentId)
        : null,
    });
  }
  const scopes = await readPackageMcpScopes(
    db,
    input.projectId,
    input.flowPackageInstallId,
  );
  const targets = await captureSessionMcpTargets(
    db,
    input.projectId,
    await withBoundPlatformMcpRecords(
      db,
      input.projectId,
      await loadSelectableCapabilities(input.projectId, db),
    ),
  );

  return {
    packages,
    bundles: bundleRows.map((row) => bundleRow.parse(row)),
    scopes,
    targets,
    nodes,
    assignments,
  };
}

/** Capture only immutable references, the admitted persona and the project sharing decision. */
export async function capturePackageDelivery(
  db: SqlTransaction,
  input: PackageDeliveryInput,
): Promise<FlowDeliverySnapshot | undefined> {
  const source = await readPackageDeliverySource(db, input);

  return source ? capturePackageDeliveryFiles(db, input, source) : undefined;
}

/** Seal the filesystem result in preflight, then compare only the SQL source under the launch lock. */
export function preparePackageDeliveryCapture(): {
  prepare: PackageDeliveryCapture;
  recheck: PackageDeliveryCapture;
} {
  const captured = new Map<
    string,
    {
      fingerprint: string;
      delivery: FlowDeliverySnapshot | undefined;
    }
  >();
  const digest = (input: PackageDeliveryInput) =>
    retryDigest([
      input.projectId,
      input.flowPackageInstallId,
      input.flowManifest,
      input.nonPackageMcpRefs,
    ]);
  const changed = (input: PackageDeliveryInput) =>
    new MaisterError(
      "CONFLICT",
      "Package delivery configuration changed during task launch",
      {
        details: {
          reason: "launch_settings_changed",
          projectId: input.projectId,
        },
      },
    );

  return {
    prepare: async (db, input) => {
      const key = digest(input);
      const source = await readPackageDeliverySource(db, input);
      const fingerprint = retryDigest(source);
      const existing = captured.get(key);

      if (existing) {
        if (existing.fingerprint !== fingerprint) throw changed(input);

        return existing.delivery;
      }
      const delivery = source
        ? await capturePackageDeliveryFiles(db, input, source)
        : undefined;

      if (
        source &&
        retryDigest(await readPackageDeliverySource(db, input)) !== fingerprint
      )
        throw changed(input);
      captured.set(key, { fingerprint, delivery });

      return delivery;
    },
    recheck: async (db, input) => {
      const existing = captured.get(digest(input));

      if (
        !existing ||
        retryDigest(await readPackageDeliverySource(db, input)) !==
          existing.fingerprint
      )
        throw changed(input);

      return existing.delivery;
    },
  };
}

async function capturePackageDeliveryFiles(
  db: SqlTransaction,
  input: PackageDeliveryInput,
  source: PackageDeliverySource,
): Promise<FlowDeliverySnapshot> {
  const { nodes, scopes, targets } = source;
  const packages: FlowDeliverySnapshot["packages"] = source.packages.map(
    ({ pin }) => ({
      ...pin,
      bundleIds: [...pin.bundleIds],
      mcps: [],
      skillDigests: {},
    }),
  );
  const bundles = [...source.bundles];

  for (const row of source.packages) {
    const pkg = packages.find((p) => p.installId === row.pin.installId)!;

    pkg.bundlePaths = {};
    for (const declaration of row.declarations) {
      let bundle = bundles.find(
        (b) => b.installId === pkg.installId && b.name === declaration.id,
      );

      if (!bundle) {
        const id = "pin:" + pkg.installId + ":" + declaration.id;

        bundle = {
          id,
          root: path.join(row.root, declaration.path),
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

  const bindings: Record<string, BoundDeliveryPin> = Object.create(null);

  for (const { nodeId, agentId, installId, profile } of source.assignments) {
    const definition = await resolveInstalledAgentDefinition(db, {
      agentId,
      packageInstallId: installId,
    });
    const applied = applyProjectAgentProfile(definition.parsed, profile);

    bindings[nodeId] = {
      agentId,
      installId,
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
    targets,
    bindings,
    nonPackageMcpRefs: [
      ...new Set(
        input.nonPackageMcpRefs.filter(
          (ref) => !scopes.some((s) => s.refId === ref),
        ),
      ),
    ].sort(),
  };

  if (source.packages.some((row) => row.versioned === true))
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
