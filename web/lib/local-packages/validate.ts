import "server-only";

import { parse as parseYaml } from "yaml";

import { parseAgentDefinition } from "@/lib/agents/definition";
import { validateSubagentMarkdown } from "@/lib/agents/subagent-definition";
import { flowYamlV1Schema } from "@/lib/config.schema";
import {
  skillFrontmatterSchema,
  splitFrontmatter,
} from "@/lib/flows/artifact-frontmatter";
import { classifyPackageFilePath } from "@/lib/flows/editor/package-file-tree";
import { buildAuthoredFlowGraph } from "@/lib/queries/authored-flow-graph";
import { validatePackageManifestYaml } from "@/lib/local-packages/manifest";

// (M39 ADR-105, Phase A3) The commit-time validation gate. Owner decision: we
// ASSUME every already-committed artifact is valid, so a commit only has to
// validate the files that THIS commit changes. `validatePackageArtifacts` is fed
// ALL working-dir files (for cross-file checks like skill ↔ SKILL.md) but only
// reports issues on the paths in `changedPaths`. An empty result = the commit
// may proceed; any entry HARD-BLOCKS the commit (the route throws so nothing is
// written). Server-side: `buildAuthoredFlowGraph`/`compileManifest` are
// server-only.

export type PackageArtifactError = { path: string; message: string };

export type PackageArtifactFile = { path: string; content: string };

export function validatePackageArtifacts(input: {
  // ALL working-dir files (so a changed `skills/<id>/**` file can check whether
  // its sibling `SKILL.md` exists). Deletions are absent (they have no content).
  files: PackageArtifactFile[];
  // ONLY the paths changed in this commit. Validation is scoped to these.
  changedPaths: string[];
}): PackageArtifactError[] {
  const errors: PackageArtifactError[] = [];
  const byPath = new Map(input.files.map((f) => [f.path, f.content]));
  const changed = new Set(input.changedPaths);

  for (const path of changed) {
    const content = byPath.get(path);

    // A deleted path (in changedPaths but absent from files) carries nothing to
    // validate — the working dir no longer holds it.
    if (content === undefined) continue;

    const kind = classifyPackageFilePath(path);

    if (kind === "manifest") {
      validateManifest(path, content, errors);
    } else if (isFlowPath(path)) {
      // flow.yaml classifies as "asset" (no flow leaf) — match it explicitly.
      validateFlow(path, content, errors);
    } else if (isAgentDefinitionPath(path)) {
      // Narrower than `kind === "agent_definition"`: only top-level `.md`
      // definitions, never nested aux files under the dir.
      validateAgentDefinition(path, content, errors);
    } else if (kind === "skill") {
      validateSkill(path, content, input.files, errors);
    } else if (kind === "subagent") {
      validateSubagent(path, content, errors);
    }
    // Everything else (readme/setup/script/schema/template/asset) is freeform —
    // no commit-time content contract.
  }

  return errors;
}

// A flow manifest the canvas compiles. `classifyPackageFilePath` has no "flow"
// leaf (flow files classify as "asset"), so we match the runtime's flow
// enumeration explicitly: the root single-flow `flow.yaml`, or a per-flow
// `flows/<id>/flow.yaml` (the manifest's `flows[].path` joined with `/flow.yaml`
// — see `lib/queries/packages.ts`). Keyed on the `flow.yaml` BASENAME: a bare
// `flows/notes.yaml` or an aux `flows/<id>/schema.yaml` is NOT a flow (it stays
// a freeform asset). Matching every `flows/*.ya?ml` would compile-check, and
// thus hard-block, legitimate non-flow yaml living under flows/.
function isFlowPath(path: string): boolean {
  return path === "flow.yaml" || /^flows\/.+\/flow\.yaml$/.test(path);
}

// A package-root platform-agent definition (`maister-agents/<stem>.md` or
// `agents/<stem>.md`) — the registration contract applies. Aux files under
// those dirs (nested, non-.md) are not definitions.
function isAgentDefinitionPath(path: string): boolean {
  return /^(?:maister-agents|agents)\/[^/]+\.md$/.test(path);
}

function validateManifest(
  path: string,
  content: string,
  errors: PackageArtifactError[],
): void {
  for (const issue of validatePackageManifestYaml(content)) {
    errors.push({ path, message: issue });
  }
}

function validateFlow(
  path: string,
  content: string,
  errors: PackageArtifactError[],
): void {
  let data: unknown;

  try {
    data = parseYaml(content);
  } catch (err) {
    errors.push({
      path,
      message: `flow YAML parse error: ${asMessage(err)}`,
    });

    return;
  }

  const parsed = flowYamlV1Schema.safeParse(data);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        path,
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      });
    }

    return;
  }

  // The schema parses but the graph may still fail to compile (unknown
  // transition target, gate/rework shape, engine-floor, …) — compile throws a
  // MaisterError(CONFIG); surface it as the flow's error.
  try {
    buildAuthoredFlowGraph(parsed.data, 0);
  } catch (err) {
    errors.push({ path, message: `flow does not compile: ${asMessage(err)}` });
  }
}

function validateAgentDefinition(
  path: string,
  content: string,
  errors: PackageArtifactError[],
): void {
  const stem = (path.split("/").at(-1) ?? path).replace(/\.md$/, "");

  try {
    parseAgentDefinition(stem, content);
  } catch (err) {
    errors.push({ path, message: asMessage(err) });
  }
}

// Capability subagents (M39 A4): LENIENT frontmatter (name + description
// required; tools/model/color + custom keys preserved). NEVER strict — they are
// Claude subagents materialized into `.claude/agents/`, not platform agents.
function validateSubagent(
  path: string,
  content: string,
  errors: PackageArtifactError[],
): void {
  for (const issue of validateSubagentMarkdown(content)) {
    errors.push({ path, message: issue });
  }
}

function validateSkill(
  path: string,
  content: string,
  files: readonly PackageArtifactFile[],
  errors: PackageArtifactError[],
): void {
  // A changed `**/SKILL.md` must carry name+description frontmatter (mirrors
  // lib/flows/artifact-validate.ts).
  if (path.split("/").at(-1) === "SKILL.md") {
    const split = splitFrontmatter(content);

    if (!split.ok || split.frontmatter === undefined) {
      errors.push({
        path,
        message:
          "SKILL.md has missing or unparseable frontmatter (a leading `---` yaml block with name + description is required).",
      });

      return;
    }

    const result = skillFrontmatterSchema.safeParse(split.frontmatter);

    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");

      errors.push({
        path,
        message: `SKILL.md frontmatter is missing required fields: ${detail}.`,
      });
    }

    return;
  }

  // A changed `skills/<id>/**` file (not the SKILL.md itself) requires the skill
  // dir to carry a SKILL.md — a skill bundle without its definition is invalid.
  const skillDir = skillDirOf(path);

  if (skillDir && !files.some((f) => f.path === `${skillDir}/SKILL.md`)) {
    const id = skillDir.slice("skills/".length);

    errors.push({
      path,
      message: `skill ${id} is missing SKILL.md (every skill bundle needs a skills/${id}/SKILL.md).`,
    });
  }
}

// `skills/<id>/...` → `skills/<id>`; anything shallower (e.g. a stray
// `skills/foo.md`) has no bundle dir → null.
function skillDirOf(path: string): string | null {
  const parts = path.split("/");

  if (parts[0] !== "skills" || parts.length < 3) return null;

  return `skills/${parts[1]}`;
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
