import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

import { upsertPackageFile } from "@/lib/flows/editor/package-files-draft";
import {
  flowCanvasHref,
  inlineSelectHref,
  skillScreenHref,
} from "@/lib/local-packages/composition";
import {
  appendManifestFlow,
  PACKAGE_MANIFEST_FILENAME,
  parsePackageManifest,
} from "@/lib/local-packages/manifest";

// Pure, client-safe per-kind artifact scaffolders (ADR-116 P5). Each produces the
// exact working-dir file shape into the draft set and returns where to navigate
// after the create is saved (flow → canvas, skill → skill screen, the rest →
// inline). A flow ALSO appends `manifest.spec.flows[]` (a file-only flow is dead
// weight at install). Collisions reject; nothing is half-written.

export type ScaffoldKind =
  | "flow"
  | "skill"
  | "subagent"
  | "agent"
  | "mcp"
  | "rule";

export type ScaffoldResult =
  | { ok: true; files: AuthoredFlowPackageFile[]; navigate: string }
  | {
      ok: false;
      code: "CONFLICT" | "PRECONDITION" | "CONFIG";
      message: string;
    };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function exists(
  files: ReadonlyArray<AuthoredFlowPackageFile>,
  path: string,
): boolean {
  return files.some((file) => file.path === path);
}

function flowSkeleton(name: string): string {
  return [
    "schemaVersion: 1",
    `name: ${name}`,
    "steps:",
    "  - id: start",
    "    type: agent",
    "    mode: new-session",
    "    prompt: Describe the task.",
    "",
  ].join("\n");
}

function skillStub(name: string): string {
  return [
    `---`,
    `name: ${name}`,
    `description: `,
    `---`,
    ``,
    `# ${name}`,
    ``,
  ].join("\n");
}

function subagentStub(name: string): string {
  return [
    `---`,
    `name: ${name}`,
    `description: `,
    `---`,
    ``,
    `Subagent prompt for ${name}.`,
    ``,
  ].join("\n");
}

function platformAgentStub(name: string): string {
  return [
    `---`,
    `name: ${name}`,
    `description: `,
    `workspace: none`,
    `mode: session`,
    `triggers:`,
    `  - manual`,
    `risk_tier: read_only`,
    `---`,
    ``,
    `Platform agent prompt for ${name}.`,
    ``,
  ].join("\n");
}

function mcpStub(name: string): string {
  return [`id: ${name}`, `transport: stdio`, `command: ""`, ``].join("\n");
}

function ruleStub(name: string): string {
  return [
    `---`,
    `name: ${name}`,
    `description: `,
    `---`,
    ``,
    `Rule body.`,
    ``,
  ].join("\n");
}

export function scaffoldArtifact(opts: {
  kind: ScaffoldKind;
  name: string;
  packageId: string;
  draftFiles: AuthoredFlowPackageFile[];
  // Required for `subagent` — the capability bundle the subagent lands in.
  capability?: string;
}): ScaffoldResult {
  const name = opts.name.trim();

  if (!NAME_RE.test(name)) {
    return {
      ok: false,
      code: "PRECONDITION",
      message: `invalid name: ${JSON.stringify(opts.name)}`,
    };
  }

  const { kind, packageId, draftFiles } = opts;

  switch (kind) {
    case "flow": {
      const path = `flows/${name}/flow.yaml`;

      if (exists(draftFiles, path)) {
        return { ok: false, code: "CONFLICT", message: path };
      }

      const manifestFile = draftFiles.find(
        (f) => f.path === PACKAGE_MANIFEST_FILENAME,
      );
      const parsed = parsePackageManifest(manifestFile?.content ?? "");

      if (!parsed.ok) {
        return {
          ok: false,
          code: "CONFIG",
          message: `manifest unparseable: ${parsed.error}`,
        };
      }

      const withFlow = upsertPackageFile(draftFiles, path, flowSkeleton(name));
      const nextManifest = appendManifestFlow(parsed.raw, {
        id: name,
        path: `flows/${name}`,
      });
      const files = upsertPackageFile(
        withFlow,
        PACKAGE_MANIFEST_FILENAME,
        nextManifest,
      );

      return {
        ok: true,
        files,
        navigate: flowCanvasHref(packageId, `flows/${name}`),
      };
    }
    case "skill": {
      const path = `skills/${name}/SKILL.md`;

      if (exists(draftFiles, path)) {
        return { ok: false, code: "CONFLICT", message: path };
      }

      return {
        ok: true,
        files: upsertPackageFile(draftFiles, path, skillStub(name)),
        navigate: skillScreenHref(packageId, name),
      };
    }
    case "subagent": {
      const cap = (opts.capability ?? "").trim();

      if (!NAME_RE.test(cap)) {
        return {
          ok: false,
          code: "PRECONDITION",
          message: `invalid capability: ${JSON.stringify(opts.capability)}`,
        };
      }
      const path = `capability/${cap}/agents/${name}.md`;

      if (exists(draftFiles, path)) {
        return { ok: false, code: "CONFLICT", message: path };
      }

      return {
        ok: true,
        files: upsertPackageFile(draftFiles, path, subagentStub(name)),
        navigate: inlineSelectHref(packageId, "subagents", name),
      };
    }
    case "agent": {
      const path = `maister-agents/${name}.md`;

      if (exists(draftFiles, path)) {
        return { ok: false, code: "CONFLICT", message: path };
      }

      return {
        ok: true,
        files: upsertPackageFile(draftFiles, path, platformAgentStub(name)),
        navigate: inlineSelectHref(packageId, "agents", name),
      };
    }
    case "mcp": {
      const path = `mcps/${name}.yaml`;

      if (exists(draftFiles, path)) {
        return { ok: false, code: "CONFLICT", message: path };
      }

      return {
        ok: true,
        files: upsertPackageFile(draftFiles, path, mcpStub(name)),
        navigate: inlineSelectHref(packageId, "mcps", name),
      };
    }
    case "rule": {
      const path = `rules/${name}.md`;

      if (exists(draftFiles, path)) {
        return { ok: false, code: "CONFLICT", message: path };
      }

      return {
        ok: true,
        files: upsertPackageFile(draftFiles, path, ruleStub(name)),
        navigate: inlineSelectHref(packageId, "rules", name),
      };
    }
  }
}
