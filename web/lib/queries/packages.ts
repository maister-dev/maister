import "server-only";

import type { PackageInstallRow } from "@/components/settings/package-sources-panel";
import type { PackageSourceRow } from "@/components/settings/package-source-modal";
import type { FlowYamlV1 } from "@/lib/config.schema";
import type { DiscoveredPackageEntry } from "@/lib/db/schema";
import type { PackageInstallManifest } from "@/lib/packages/attach";
import type { FlowLayout } from "@/lib/flows/graph/presentation-layout";
import type { GraphTopology } from "@/lib/queries/flow-graph-view";

import { join } from "node:path";

import { and, eq, inArray } from "drizzle-orm";
import pino from "pino";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { loadFlowManifest } from "@/lib/config";
import { compileManifest } from "@/lib/flows/graph/compile";
import { buildFlowNodeTooltipsFromManifest } from "@/lib/flows/graph/node-tooltips";
import { presentationLayout } from "@/lib/flows/graph/presentation-layout";
import {
  classifyVersionTargets,
  defaultPackageSourceUrls,
  deriveUpdateAvailable,
  type PackageVersionTarget,
} from "@/lib/packages/catalog";
import { buildGraphTopology } from "@/lib/queries/flow-graph-view";
import { parseAgentDefinition } from "@/lib/agents/definition";
import { splitFrontmatter } from "@/lib/flows/artifact-frontmatter";
import {
  listInstalledPackageFiles,
  readInstalledPackageFile,
  resolveBundledAgentPath,
  resolveBundledSkillPrefix,
} from "@/lib/flows/package-content";

// FIXME(any): dual drizzle-orm peer-dep variants.
const { packageInstalls, packageSources, projectPackageAttachments } =
  schemaModule as unknown as Record<string, any>;

const log = pino({
  name: "queries/packages",
  level: process.env.LOG_LEVEL ?? "info",
});

export type ProjectPackageAttachmentView = {
  id: string;
  packageInstallId: string;
  packageName: string;
  versionLabel: string;
  resolvedRevision: string;
  trustStatus: string;
  attachedAt: string;
  updateAvailable: boolean;
  // The single newest strictly-newer installed version (default one-click
  // upgrade), and all strictly-older installed versions (explicit downgrade
  // path). An older version is NEVER surfaced as an upgrade.
  upgradeTarget: PackageVersionTarget | null;
  downgradeTargets: PackageVersionTarget[];
  flows: string[];
};

export type AvailablePackageInstallView = {
  id: string;
  name: string;
  versionLabel: string;
  resolvedRevision: string;
  trustStatus: string;
  flows: string[];
};

// DTO projections for the project packages tab (ADR-088). `installed_path`
// never leaves the server.
export async function getProjectPackageAttachments(
  projectId: string,
): Promise<ProjectPackageAttachmentView[]> {
  const db = getDb() as any;
  const attachments = await db
    .select()
    .from(projectPackageAttachments)
    .where(eq(projectPackageAttachments.projectId, projectId));

  if (attachments.length === 0) return [];

  const installs = await db
    .select()
    .from(packageInstalls)
    .where(
      inArray(
        packageInstalls.id,
        attachments.map((a: any) => a.packageInstallId),
      ),
    );
  const installById = new Map<string, any>(installs.map((i: any) => [i.id, i]));
  const sources = await db.select().from(packageSources);
  const discoveredByUrl = new Map<string, DiscoveredPackageEntry[]>(
    sources.map((s: any) => [s.url, s.discovered ?? []]),
  );

  const attachedNames = [
    ...new Set(attachments.map((a: any) => a.packageName as string)),
  ];
  const siblingInstalls = await db
    .select()
    .from(packageInstalls)
    .where(
      and(
        eq(packageInstalls.packageStatus, "Installed"),
        inArray(packageInstalls.name, attachedNames),
      ),
    );

  return attachments.map((att: any) => {
    const install = installById.get(att.packageInstallId);
    const manifest = install?.manifest as PackageInstallManifest | undefined;
    const { upgrade, downgrade } = classifyVersionTargets({
      currentVersionLabel: install?.versionLabel ?? "",
      candidates: install
        ? siblingInstalls
            .filter(
              (s: any) =>
                s.name === att.packageName &&
                s.sourceUrl === install.sourceUrl &&
                s.id !== install.id,
            )
            .map((s: any) => ({
              installId: s.id as string,
              versionLabel: s.versionLabel as string,
            }))
        : [],
    });

    return {
      id: att.id,
      packageInstallId: att.packageInstallId,
      packageName: att.packageName,
      versionLabel: install?.versionLabel ?? "",
      resolvedRevision: install?.resolvedRevision ?? "",
      trustStatus: install?.trustStatus ?? "untrusted",
      attachedAt:
        att.attachedAt instanceof Date
          ? att.attachedAt.toISOString()
          : String(att.attachedAt),
      updateAvailable: install
        ? deriveUpdateAvailable({
            packageName: att.packageName,
            versionLabel: install.versionLabel,
            discovered: discoveredByUrl.get(install.sourceUrl) ?? [],
          })
        : false,
      upgradeTarget: upgrade,
      downgradeTargets: downgrade,
      flows: manifest?.spec.flows.map((f) => f.id) ?? [],
    };
  });
}

export async function getAvailablePackageInstalls(): Promise<
  AvailablePackageInstallView[]
> {
  const db = getDb() as any;
  const installs = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.packageStatus, "Installed"));

  return installs.map((install: any) => {
    const manifest = install.manifest as PackageInstallManifest | undefined;

    return {
      id: install.id,
      name: install.name,
      versionLabel: install.versionLabel,
      resolvedRevision: install.resolvedRevision,
      trustStatus: install.trustStatus,
      flows: manifest?.spec.flows.map((f) => f.id) ?? [],
    };
  });
}

export type StudioPackageInstallView = {
  id: string;
  name: string;
  sourceUrl: string;
  versionLabel: string;
  trustStatus: string;
  counts: {
    flows: number;
    skills: number;
    platformAgents: number;
    subagents: number;
    mcps: number;
    rules: number;
  };
};

// Studio-scoped projection of installed packages: carries `sourceUrl` (for
// package grouping + the Local badge) and per-kind member counts derived from
// the stored manifest — fields the project-packages-tab DTO does not expose.
export async function getStudioPackageInstalls(): Promise<
  StudioPackageInstallView[]
> {
  const db = getDb() as any;
  const installs = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.packageStatus, "Installed"));

  return installs.map((install: any) => {
    const manifest = install.manifest as PackageInstallManifest | undefined;

    return {
      id: install.id,
      name: install.name,
      sourceUrl: install.sourceUrl,
      versionLabel: install.versionLabel,
      trustStatus: install.trustStatus,
      counts: {
        flows: manifest?.spec.flows.length ?? 0,
        skills: manifest?.inventory.skills.length ?? 0,
        platformAgents: manifest?.inventory.platformAgents?.length ?? 0,
        subagents: manifest?.inventory.agents.length ?? 0,
        mcps: manifest?.spec.mcps.length ?? 0,
        // Rules live inside capability bundles and are not inventoried in the
        // manifest (only skills/agents are); a real count needs Phase C disk reads.
        rules: 0,
      },
    };
  });
}

// Props for the platform `PackageSourcesPanel`, shared by the admin `/settings`
// page and the Studio Sources surface. Mirrors the `/settings` package slice;
// `installed_path` never leaves the server.
export async function loadPackageSourcesView(): Promise<{
  sources: PackageSourceRow[];
  installs: PackageInstallRow[];
}> {
  const db = getDb() as any;
  const builtInUrls = new Set(defaultPackageSourceUrls());
  const [pkgSources, pkgInstalls] = await Promise.all([
    db.select().from(packageSources),
    db.select().from(packageInstalls),
  ]);

  return {
    sources: pkgSources.map((s: any) => ({
      id: s.id,
      url: s.url,
      enabled: s.enabled,
      note: s.note ?? null,
      discovered: s.discovered ?? [],
      lastCheckedAt: s.lastCheckedAt ? s.lastCheckedAt.toISOString() : null,
      builtIn: builtInUrls.has(s.url),
    })),
    installs: pkgInstalls.map((i: any) => ({
      id: i.id,
      sourceUrl: i.sourceUrl,
      name: i.name,
      versionLabel: i.versionLabel,
      resolvedRevision: i.resolvedRevision,
      packageStatus: i.packageStatus,
      trustStatus: i.trustStatus,
      flows: (i.manifest?.spec?.flows ?? []).map((f: any) => f.id),
    })),
  };
}

// Enriched per-kind bill-of-materials items (M36 T1.2). Each kind carries a
// kind-specific meta line the viewer cards render; a member missing/unreadable
// on disk degrades to an id-only shape, never throws. `installed_path` never
// leaves the server.
// `path` = the element's source-bundle-relative path (M39 A3), so element-fork
// copies the exact element (for flows, the `id` differs from the dir).
export type PackageBomFlow = {
  id: string;
  path: string;
  nodeCount: number;
  gateCount: number;
  engine: string | null;
  frontmatter: PackageBomFlowFrontmatter;
  graph: PackageBomFlowGraph | null;
};
export type PackageBomFlowFrontmatter = {
  title: string | null;
  summary: string | null;
  labels: string[];
  routeWhen: string | null;
  links: Array<{ kind: string | null; title: string; url: string }>;
  sources: Array<{ component: string; origin: string }>;
};
export type PackageBomFlowGraph = {
  topology: GraphTopology;
  layout: FlowLayout;
  nodeTooltips: Record<string, string>;
};
export type PackageBomSkill = {
  id: string;
  path: string;
  fileCount: number;
  subfolderCount: number;
  description: string;
};
// Routing-relevant agent metadata only — NEVER the runner (resolved per-project
// at launch; design §5.5).
export type PackageBomAgent = {
  id: string;
  path: string;
  description: string;
  triggers: string[];
  riskTier: string;
  workspace: string;
};
export type PackageBomMcp = { id: string };
export type PackageBomRule = { id: string; path: string };
// Capability subagents (capability/**/agents) — raw Claude-subagent .md, never
// strict-parsed: lenient id + description only (materialized into `.claude/` at
// run, NOT platform-agents). `path` is null when the bundle file is unresolved.
export type PackageBomSubagent = {
  id: string;
  path: string | null;
  description: string;
};

export type PackageBom = {
  flows: PackageBomFlow[];
  platformAgents: PackageBomAgent[];
  subagents: PackageBomSubagent[];
  skills: PackageBomSkill[];
  mcps: PackageBomMcp[];
  rules: PackageBomRule[];
};

const EMPTY_FLOW_FRONTMATTER: PackageBomFlowFrontmatter = {
  title: null,
  summary: null,
  labels: [],
  routeWhen: null,
  links: [],
  sources: [],
};

function markdownFrontmatterDescription(content: string): string {
  const split = splitFrontmatter(content);
  const description = split.ok ? split.frontmatter?.description : undefined;

  return typeof description === "string" ? description : "";
}

function flowFrontmatterView(manifest: FlowYamlV1): PackageBomFlowFrontmatter {
  const metadata = manifest.metadata;

  if (!metadata) return EMPTY_FLOW_FRONTMATTER;

  return {
    title: metadata.title ?? null,
    summary: metadata.summary ?? null,
    labels: metadata.labels ?? [],
    routeWhen: metadata.route_when ?? null,
    links: (metadata.links ?? []).map((link) => ({
      kind: link.kind ?? null,
      title: link.title,
      url: link.url,
    })),
    sources: (metadata.sources ?? []).map((source) => ({
      component: source.component,
      origin: source.origin,
    })),
  };
}

// Bill-of-materials for one package install. Flows compile from disk for
// node/gate/engine counts; skills/rules come from a single confined disk walk;
// agents parse their `agents/<stem>.md` for routing metadata (NO runner). Every
// per-element disk failure degrades to id-only and is logged — never thrown.
export async function getStudioPackageBom(
  installId: string,
): Promise<PackageBom | null> {
  const db = getDb() as any;
  const rows = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, installId));
  const install = rows[0];

  if (!install) return null;

  const manifest = install.manifest as PackageInstallManifest | undefined;
  const installedPath = install.installedPath as string;

  const flows: PackageBomFlow[] = [];

  for (const flow of manifest?.spec.flows ?? []) {
    try {
      const parsed = await loadFlowManifest(
        join(installedPath, flow.path, "flow.yaml"),
      );
      const graph = compileManifest(parsed);
      const topology = buildGraphTopology(graph);
      let gateCount = 0;

      for (const node of graph.nodes.values()) gateCount += node.gates.length;
      flows.push({
        id: flow.id,
        path: flow.path,
        nodeCount: graph.order.length,
        gateCount,
        engine: parsed.compat?.engine_min ?? null,
        frontmatter: flowFrontmatterView(parsed),
        graph: {
          topology,
          layout: presentationLayout(parsed),
          nodeTooltips: buildFlowNodeTooltipsFromManifest(parsed),
        },
      });
    } catch {
      log.warn(
        { installId, kind: "flow", flowId: flow.id },
        "bom flow degrade",
      );
      flows.push({
        id: flow.id,
        path: flow.path,
        nodeCount: 0,
        gateCount: 0,
        engine: null,
        frontmatter: EMPTY_FLOW_FRONTMATTER,
        graph: null,
      });
    }
  }

  const skillIds = manifest?.inventory.skills ?? [];
  const skills: PackageBomSkill[] = [];
  const rules: PackageBomRule[] = [];
  const listed = await listInstalledPackageFiles({ installedPath }).catch(
    () => ({ bundleMissing: true as const }),
  );

  if (!listed.bundleMissing) {
    for (const id of skillIds) {
      const prefix =
        resolveBundledSkillPrefix(listed.files, id) ?? `skills/${id}/`;
      const files = listed.files.filter((f) => f.path.startsWith(prefix));
      const subfolders = new Set<string>();

      for (const f of files) {
        const rest = f.path.slice(prefix.length);
        const slash = rest.indexOf("/");

        if (slash > 0) subfolders.add(rest.slice(0, slash));
      }
      let description = "";

      try {
        const skillMd = await readInstalledPackageFile(
          { installedPath },
          `${prefix}SKILL.md`,
        );

        if (skillMd.state === "text" && skillMd.content) {
          description = markdownFrontmatterDescription(skillMd.content);
        }
      } catch {
        log.warn(
          { installId, kind: "skill", skillId: id },
          "bom skill degrade",
        );
      }
      skills.push({
        id,
        path: prefix.replace(/\/+$/, ""),
        fileCount: files.length,
        subfolderCount: subfolders.size,
        description,
      });
    }
    for (const f of listed.files) {
      if (f.kind === "rule") {
        const at = f.path.lastIndexOf("rules/");

        rules.push({
          id: at >= 0 ? f.path.slice(at + "rules/".length) : f.path,
          path: f.path,
        });
      }
    }
  } else {
    log.warn(
      { installId, kind: "skills" },
      "bom bundle missing; skills id-only",
    );
    for (const id of skillIds) {
      skills.push({
        id,
        path: `skills/${id}`,
        fileCount: 0,
        subfolderCount: 0,
        description: "",
      });
    }
  }

  // Platform-agents: package-root `maister-agents/<stem>.md`, strict-parsed for
  // the rich card; any failure degrades to an id-only card (never throws).
  const platformAgents: PackageBomAgent[] = [];

  for (const stem of manifest?.inventory.platformAgents ?? []) {
    try {
      const read = await readInstalledPackageFile(
        { installedPath },
        `maister-agents/${stem}.md`,
      );

      if (read.state !== "text" || !read.content) {
        throw new Error(`platform agent .md not readable (${read.state})`);
      }
      const def = parseAgentDefinition(stem, read.content);

      platformAgents.push({
        id: stem,
        path: `maister-agents/${stem}.md`,
        description: def.description,
        triggers: def.triggers,
        riskTier: def.riskTier,
        workspace: def.workspace,
      });
    } catch {
      log.warn(
        { installId, kind: "platformAgent", stem },
        "bom platform-agent degrade",
      );
      platformAgents.push({
        id: stem,
        path: `maister-agents/${stem}.md`,
        description: "",
        triggers: [],
        riskTier: "",
        workspace: "",
      });
    }
  }

  // Capability subagents: capability/**/agents/<stem>.md. NEVER strict-parsed
  // (they are Claude-subagent .md); lenient description only, never throws.
  const subagents: PackageBomSubagent[] = [];
  const agentFiles = listed.bundleMissing ? [] : listed.files;

  for (const stem of manifest?.inventory.agents ?? []) {
    let description = "";
    let subagentPath: string | null = null;

    try {
      const agentPath = resolveBundledAgentPath(agentFiles, stem);

      subagentPath = agentPath ?? null;
      if (agentPath) {
        const read = await readInstalledPackageFile(
          { installedPath },
          agentPath,
        );

        if (read.state === "text" && read.content) {
          const split = splitFrontmatter(read.content);
          const desc = split.ok ? split.frontmatter?.description : undefined;

          if (typeof desc === "string") description = desc;
        }
      }
    } catch {
      log.warn({ installId, kind: "subagent", stem }, "bom subagent degrade");
    }
    subagents.push({ id: stem, path: subagentPath, description });
  }

  const mcps: PackageBomMcp[] = (manifest?.spec.mcps ?? []).map((m) => ({
    id: m.id,
  }));

  log.debug(
    {
      installId,
      flows: flows.length,
      skills: skills.length,
      platformAgents: platformAgents.length,
      subagents: subagents.length,
      mcps: mcps.length,
      rules: rules.length,
    },
    "bom built",
  );

  return { flows, platformAgents, subagents, skills, mcps, rules };
}

export type StudioFlowGraph = {
  flowId: string;
  topology: GraphTopology;
  layout: FlowLayout;
};

// Read-only graph per member flow of an installed package, for the Studio package
// preview. Each flow.yaml is read from the package's on-disk install path
// (server-controlled `installedPath` + a validated package-relative `path` — no
// user input, no traversal) and compiled. A flow missing on disk or failing to
// parse/compile is omitted — a best-effort preview that never throws.
export async function getStudioPackageFlowGraphs(
  installId: string,
): Promise<StudioFlowGraph[]> {
  const db = getDb() as any;
  const rows = await db
    .select()
    .from(packageInstalls)
    .where(eq(packageInstalls.id, installId));
  const install = rows[0];

  if (!install) return [];

  const manifest = install.manifest as PackageInstallManifest | undefined;
  const graphs: StudioFlowGraph[] = [];

  for (const flow of manifest?.spec.flows ?? []) {
    try {
      const parsed = await loadFlowManifest(
        join(install.installedPath, flow.path, "flow.yaml"),
      );

      graphs.push({
        flowId: flow.id,
        topology: buildGraphTopology(compileManifest(parsed)),
        layout: presentationLayout(parsed),
      });
    } catch {
      // Missing/invalid flow.yaml on disk → omit from the preview, never throw.
    }
  }

  return graphs;
}
