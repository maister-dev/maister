import "server-only";

import type { FlowYamlV1 } from "@/lib/config.schema";
import type { FlowLayout } from "@/lib/flows/graph/presentation-layout";
import type { ListResult, ReadResult } from "@/lib/flows/package-content";
import type { GraphTopology } from "@/lib/queries/flow-graph-view";

import { join } from "node:path";

import pino from "pino";

import { loadFlowManifest } from "@/lib/config";
import { compileManifest } from "@/lib/flows/graph/compile";
import { buildFlowNodeTooltipsFromManifest } from "@/lib/flows/graph/node-tooltips";
import { presentationLayout } from "@/lib/flows/graph/presentation-layout";
import {
  listInstalledPackageFiles,
  readInstalledPackageFile,
  resolveBundledAgentPath,
  resolveBundledSkillPrefix,
} from "@/lib/flows/package-content";
import { parseAgentDefinition } from "@/lib/agents/definition";
import { splitFrontmatter } from "@/lib/flows/artifact-frontmatter";
import { buildGraphTopology } from "@/lib/queries/flow-graph-view";

const log = pino({
  name: "queries/package-bom",
  level: process.env.LOG_LEVEL ?? "info",
});

// Enriched per-kind bill-of-materials items (M36 T1.2; ADR-115: decoupled from
// install into a shared `PackageSource`). Each kind carries a kind-specific meta
// line the viewer cards render; a member missing/unreadable on disk degrades to
// an id-only shape, never throws. `installed_path` / `working_dir` never leave
// the server.
// `path` = the element's source-relative path (M39 A3), so element-fork copies
// the exact element (for flows, the `id` differs from the dir).
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

// The narrowed manifest fields the BOM derives from. The installed source feeds
// the full `MaisterPackageManifest` (assignable); the local source synthesizes
// `mcps` from `mcps/*.yaml` files (D6) since a working dir authors them as files.
export type PackageBomSpec = {
  flows: ReadonlyArray<{ id: string; path: string }>;
  mcps: ReadonlyArray<{ id: string }>;
};

export type PackageBomInventory = {
  skills: string[];
  agents: string[];
  platformAgents: string[];
};

// The input the shared BOM builder consumes (ADR-115 §D4). `installedPackageSource`
// and the local `localPackageSource` both produce one; the builder never touches
// a DB row or a concrete root path directly.
export interface PackageSource {
  // A short server-side label used only for log lines (install id / package slug).
  logLabel: string;
  spec: PackageBomSpec;
  inventory: PackageBomInventory;
  listFiles(): Promise<ListResult>;
  readFile(rel: string): Promise<ReadResult>;
  // Compile coordinate: loads + parses `<root>/<flowPath>/flow.yaml`.
  loadFlow(flowPath: string): Promise<FlowYamlV1>;
}

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

// Wraps an installed package row into a `PackageSource` — today's behavior,
// unchanged: spec + inventory from the stored `manifest`; files/flows off the
// content-addressed `installedPath` (server-only).
export function installedPackageSource(install: {
  id: string;
  installedPath: string;
  manifest?: { spec: PackageBomSpec; inventory: PackageBomInventory };
}): PackageSource {
  const installedPath = install.installedPath;

  return {
    logLabel: install.id,
    spec: {
      flows: install.manifest?.spec.flows ?? [],
      mcps: install.manifest?.spec.mcps ?? [],
    },
    inventory: {
      skills: install.manifest?.inventory.skills ?? [],
      agents: install.manifest?.inventory.agents ?? [],
      platformAgents: install.manifest?.inventory.platformAgents ?? [],
    },
    listFiles: () => listInstalledPackageFiles({ installedPath }),
    readFile: (rel) => readInstalledPackageFile({ installedPath }, rel),
    loadFlow: (flowPath) =>
      loadFlowManifest(join(installedPath, flowPath, "flow.yaml")),
  };
}

// Bill-of-materials for one package source. Flows compile from disk for
// node/gate/engine counts; skills/rules come from a single confined disk walk;
// platform-agents parse `maister-agents/<stem>.md` for routing metadata (NO
// runner); subagents are read leniently. Every per-element disk/parse failure
// degrades to id-only and is logged — never thrown (ADR-115 §D4).
export async function buildPackageBom(
  source: PackageSource,
): Promise<PackageBom> {
  const flows: PackageBomFlow[] = [];

  for (const flow of source.spec.flows) {
    try {
      const parsed = await source.loadFlow(flow.path);
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
        { source: source.logLabel, kind: "flow", flowId: flow.id },
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

  const skillIds = source.inventory.skills;
  const skills: PackageBomSkill[] = [];
  const rules: PackageBomRule[] = [];
  const listed = await source
    .listFiles()
    .catch(() => ({ bundleMissing: true as const }));

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
        const skillMd = await source.readFile(`${prefix}SKILL.md`);

        if (skillMd.state === "text" && skillMd.content) {
          description = markdownFrontmatterDescription(skillMd.content);
        }
      } catch {
        log.warn(
          { source: source.logLabel, kind: "skill", skillId: id },
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
      { source: source.logLabel, kind: "skills" },
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

  for (const stem of source.inventory.platformAgents) {
    try {
      const read = await source.readFile(`maister-agents/${stem}.md`);

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
        { source: source.logLabel, kind: "platformAgent", stem },
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

  for (const stem of source.inventory.agents) {
    let description = "";
    let subagentPath: string | null = null;

    try {
      const agentPath = resolveBundledAgentPath(agentFiles, stem);

      subagentPath = agentPath ?? null;
      if (agentPath) {
        const read = await source.readFile(agentPath);

        if (read.state === "text" && read.content) {
          const split = splitFrontmatter(read.content);
          const desc = split.ok ? split.frontmatter?.description : undefined;

          if (typeof desc === "string") description = desc;
        }
      }
    } catch {
      log.warn(
        { source: source.logLabel, kind: "subagent", stem },
        "bom subagent degrade",
      );
    }
    subagents.push({ id: stem, path: subagentPath, description });
  }

  const mcps: PackageBomMcp[] = source.spec.mcps.map((m) => ({ id: m.id }));

  log.debug(
    {
      source: source.logLabel,
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
