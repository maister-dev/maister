import "server-only";

import { parse as parseYaml } from "yaml";

import { parseAgentDefinition } from "@/lib/agents/definition";
import { validateSubagentMarkdown } from "@/lib/agents/subagent-definition";
import { flowYamlV1Schema } from "@/lib/config.schema";
import {
  addSchemaReferenceFloors,
  collectReferencedSchemaPaths,
  validateFormSchemaReferences,
  validateSchemaFiles,
} from "@/lib/flows/artifact-validate";
import {
  skillFrontmatterSchema,
  splitFrontmatter,
} from "@/lib/flows/artifact-frontmatter";
import { classifyPackageFilePath } from "@/lib/flows/editor/package-file-tree";
import { semverGte } from "@/lib/flows/engine-version";
import { buildAuthoredFlowGraph } from "@/lib/queries/authored-flow-graph";
import { validatePackageManifestYaml } from "@/lib/local-packages/manifest";

// (M39 ADR-105, Phase A3) The commit-time validation gate. Owner decision: we
// ASSUME every already-committed artifact is valid, so a commit normally
// validates only files that THIS commit changes. Cross-file schema references
// are the deliberate exception: a changed flow, changed schema, or deleted
// referenced schema validates the exact target document. `validatePackageArtifacts`
// is fed ALL working-dir files (for cross-file checks like skill ↔ SKILL.md) but
// reports only this scoped delta. An empty result = the commit may proceed; any
// entry HARD-BLOCKS the commit (the route throws so nothing is written).
// Server-side: `buildAuthoredFlowGraph`/`compileManifest` are server-only.

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
    // Everything else (readme/setup/script/template/asset) is freeform —
    // no commit-time content contract.
  }

  errors.push(...validateLifecycleSchemaArtifacts(input, changed));

  return errors;
}

function validateLifecycleSchemaArtifacts(
  input: {
    readonly files: readonly PackageArtifactFile[];
    readonly changedPaths: readonly string[];
  },
  changed: ReadonlySet<string>,
): PackageArtifactError[] {
  const allReferences = new Set<string>();
  const changedFlowReferences = new Set<string>();
  // ADR-162: lowest declared compat.engine_min per reference, so a json/items
  // document referenced by a below-floor manifest blocks here too.
  const referenceFloors = new Map<string, string | undefined>();

  for (const file of input.files) {
    if (!isFlowPath(file.path)) continue;

    let manifest: unknown;

    try {
      manifest = parseYaml(file.content);
    } catch {
      continue;
    }

    if (
      typeof manifest !== "object" ||
      manifest === null ||
      Array.isArray(manifest)
    ) {
      continue;
    }

    addSchemaReferenceFloors(
      manifest as Record<string, unknown>,
      referenceFloors,
    );

    const references = collectReferencedSchemaPaths(
      manifest as Record<string, unknown>,
    );

    for (const reference of references) {
      allReferences.add(reference);
      if (changed.has(file.path)) changedFlowReferences.add(reference);
    }
  }

  // ADR-165: a package-level `result_profiles` entry is a RUNTIME schema
  // reference too — the delegation path resolves it from the pinned revision at
  // launch. Mirror the installer here, or a profile pointing at a missing or
  // below-floor document would install-fail after passing every Studio gate.
  // The floor is the LOWEST member flow's, matching `addSchemaReferenceFloors`.
  const lowestMemberFloor = lowestFloor([...referenceFloors.values()]);

  for (const reference of collectPackageResultProfileSchemaPaths(input.files)) {
    allReferences.add(reference);
    if (!referenceFloors.has(reference)) {
      referenceFloors.set(reference, lowestMemberFloor);
    }
    changedFlowReferences.add(reference);
  }

  const schemaCandidates = input.files.filter(
    (file) =>
      classifyPackageFilePath(file.path) === "schema" && changed.has(file.path),
  );
  const referencesToValidate = new Map<string, string | undefined>(
    [
      ...changedFlowReferences,
      ...[...allReferences].filter((reference) => changed.has(reference)),
    ].map((reference) => [reference, referenceFloors.get(reference)]),
  );
  const issues = [
    ...validateSchemaFiles(schemaCandidates, allReferences),
    ...validateFormSchemaReferences(input.files, referencesToValidate),
  ];
  const seen = new Set<string>();

  return issues
    .filter((issue) => issue.severity === "block")
    .filter((issue) => {
      const key = `${issue.code}:${issue.path}:${issue.message}`;

      if (seen.has(key)) return false;
      seen.add(key);

      return true;
    })
    .map((issue) => ({ path: issue.path, message: issue.message }));
}

// ADR-165: the schema paths a package manifest's `result_profiles` block
// references, normalized the way `collectReferencedSchemaPaths` normalizes
// (leading `./` stripped) so they match the persisted `files[].path`.
function collectPackageResultProfileSchemaPaths(
  files: readonly PackageArtifactFile[],
): Set<string> {
  const refs = new Set<string>();

  for (const file of files) {
    if (classifyPackageFilePath(file.path) !== "manifest") continue;

    let doc: unknown;

    try {
      doc = parseYaml(file.content);
    } catch {
      continue;
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) continue;

    const declared = (doc as { result_profiles?: unknown }).result_profiles;

    if (typeof declared !== "object" || declared === null) continue;

    for (const entry of Object.values(declared as Record<string, unknown>)) {
      const schema = (entry as { schema?: unknown })?.schema;

      if (typeof schema !== "string" || schema.length === 0) continue;
      refs.add(schema.startsWith("./") ? schema.slice(2) : schema);
    }
  }

  return refs;
}

// The weakest of a set of declared floors: `undefined` (no declaration) wins
// outright, otherwise the lowest version. A profile document must satisfy the
// floor of EVERY member flow that could resolve it.
function lowestFloor(
  floors: readonly (string | undefined)[],
): string | undefined {
  let lowest: string | undefined;
  let seen = false;

  for (const floor of floors) {
    if (floor === undefined) return undefined;
    if (!seen || !semverGte(floor, lowest as string)) lowest = floor;
    seen = true;
  }

  return lowest;
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
