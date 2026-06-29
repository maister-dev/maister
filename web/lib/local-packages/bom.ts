import "server-only";

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import pino from "pino";

import { loadFlowManifest } from "@/lib/config";
import { MaisterError } from "@/lib/errors";
import {
  listInstalledPackageFiles,
  readInstalledPackageFile,
  resolveConfinedFlowYaml,
} from "@/lib/flows/package-content";
import { isMcpDescriptorPath, mcpStem } from "@/lib/local-packages/composition";
import {
  PACKAGE_MANIFEST_FILENAME,
  parsePackageManifest,
} from "@/lib/local-packages/manifest";
import {
  buildPackageBom,
  type PackageBom,
  type PackageBomInventory,
  type PackageSource,
} from "@/lib/queries/package-bom";

// Re-exported for existing importers/tests (the predicate is shared with the
// client-safe composition helpers — ADR-116 §D6).
export { isMcpDescriptorPath } from "@/lib/local-packages/composition";

const log = pino({
  name: "local-packages/bom",
  level: process.env.LOG_LEVEL ?? "info",
});

// (ADR-116 §D4) The install-time `collectInventory` (lib/packages/attach.ts)
// walks a real pkgRoot; this is its file-list variant for the local source, where
// the BOM is computed over a working-dir file walk. Layout-agnostic to match the
// BOM's own resolvers (`resolveBundledSkillPrefix`/`resolveBundledAgentPath`),
// which already locate members under either the capability-nested
// (`<cap>/skills/<id>/`, `<cap>/agents/<stem>.md`) or root layout:
// - skill   ← any `…/skills/<name>/<child>` (a child proves it is a real dir)
// - subagent← any `…/agents/<stem>.md` segment (NOT `maister-agents/`)
// - platform← root `maister-agents/<stem>.md`
export function collectInventoryFromFiles(
  files: ReadonlyArray<{ path: string }>,
): PackageBomInventory {
  const skills = new Set<string>();
  const agents = new Set<string>();
  const platformAgents = new Set<string>();

  for (const file of files) {
    const segs = file.path.split("/").filter((s) => s.length > 0);

    const si = segs.indexOf("skills");

    // A skill dir is `skills/<name>/<something>` — require a child segment so a
    // bare `skills/<name>` (which never appears in a file list anyway) is ignored.
    if (si >= 0 && segs.length > si + 2 && segs[si + 1]) {
      skills.add(segs[si + 1]);
    }

    const ai = segs.indexOf("agents");

    if (ai >= 0 && ai === segs.length - 2 && segs[ai + 1].endsWith(".md")) {
      agents.add(segs[ai + 1].replace(/\.md$/, ""));
    }

    if (
      segs.length === 2 &&
      segs[0] === "maister-agents" &&
      segs[1].endsWith(".md")
    ) {
      platformAgents.add(segs[1].replace(/\.md$/, ""));
    }
  }

  return {
    skills: [...skills].sort(),
    agents: [...agents].sort(),
    platformAgents: [...platformAgents].sort(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function manifestMcpIds(raw: Record<string, unknown>): string[] {
  if (!Array.isArray(raw.mcps)) return [];

  return raw.mcps.flatMap((entry) =>
    isRecord(entry) && typeof entry.id === "string" ? [entry.id] : [],
  );
}

// Build a `PackageSource` over a local package's working dir (ADR-116 §D4). The
// manifest is parsed from `maister-package.yaml`; inventory is COMPUTED from a
// confined file walk (no stored inventory exists for a working dir); MCPs are the
// union of manifest-declared ids and `mcps/*.yaml` file stems (D6). Every read is
// confined to `workingDir` by the same realpath guards the installed source uses.
export async function localPackageSource(opts: {
  workingDir: string;
  logLabel: string;
}): Promise<PackageSource> {
  const { workingDir, logLabel } = opts;

  const manifestText = await readFile(
    join(workingDir, PACKAGE_MANIFEST_FILENAME),
    "utf8",
  ).catch(() => "");
  const parsed = parsePackageManifest(manifestText);

  if (!parsed.ok) {
    log.warn(
      { source: logLabel, error: parsed.error },
      "local package manifest unparseable; BOM degrades to files-only",
    );
  }

  const listed = await listInstalledPackageFiles({
    installedPath: workingDir,
  }).catch(() => ({ bundleMissing: true as const }));
  const files = listed.bundleMissing ? [] : listed.files;

  const flows = parsed.ok ? parsed.model.flows : [];
  const inventory = collectInventoryFromFiles(files);

  const declaredMcpIds = parsed.ok ? manifestMcpIds(parsed.raw) : [];
  const fileMcpIds = files
    .filter((f) => isMcpDescriptorPath(f.path))
    .map((f) => mcpStem(f.path));
  const mcps = [...new Set([...declaredMcpIds, ...fileMcpIds])].map((id) => ({
    id,
  }));

  log.debug(
    {
      source: logLabel,
      flows: flows.length,
      skills: inventory.skills.length,
      subagents: inventory.agents.length,
      platformAgents: inventory.platformAgents.length,
      mcps: mcps.length,
    },
    "local package source built",
  );

  return {
    logLabel,
    spec: { flows, mcps },
    inventory,
    listFiles: () => Promise.resolve(listed),
    readFile: (rel) =>
      readInstalledPackageFile({ installedPath: workingDir }, rel),
    loadFlow: async (flowPath) => {
      const real = await resolveConfinedFlowYaml(workingDir, flowPath);

      if (!real) {
        throw new MaisterError(
          "PRECONDITION",
          `flow path escapes the package working dir: ${flowPath}`,
        );
      }

      return loadFlowManifest(real);
    },
  };
}

// The local-package bill-of-materials — server-computed from the last-saved disk
// state of the working dir (ADR-116 §D5). Drives the tabbed composition view.
export async function getLocalPackageBom(pkg: {
  slug: string;
  workingDir: string;
}): Promise<PackageBom> {
  return buildPackageBom(
    await localPackageSource({
      workingDir: pkg.workingDir,
      logLabel: pkg.slug,
    }),
  );
}
