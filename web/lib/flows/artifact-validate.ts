// Client-safe per-kind CONTENT validation (T4.2, spec §6.1). Pure: takes the
// persisted `files[]` + the parsed flow manifest and returns issues — it NEVER
// throws (the server draft-save gate filters the BLOCK subset and raises
// `MaisterError("CONFIG")`; the editor surfaces the full set inline). No
// `server-only`, no node:*, so the editor can import it in the browser bundle.
//
// Kind is inferred from path via `classifyPackageFilePath` (the same rule
// install/bridge use) — there is no stored/overridable kind. The manifest-null
// rule (spec §6.1, M27 gotcha): manifest-reference resolution runs ONLY when the
// manifest parses; file-level BLOCK checks (JSON.parse, frontmatter) run
// regardless of manifest parseability.

import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

import { parse as parseYaml } from "yaml";

import { parseAgentDefinition } from "@/lib/agents/definition";
import {
  OUTPUT_COORDINATOR_ENGINE_MIN,
  formSchemaSchema,
} from "@/lib/config.schema";
import { isMaisterError } from "@/lib/errors-core";
import {
  ruleGuardrailSchema,
  skillFrontmatterSchema,
  splitFrontmatter,
} from "@/lib/flows/artifact-frontmatter";
import { classifyPackageFilePath } from "@/lib/flows/editor/package-file-tree";
import {
  isRootSchemaFilePath,
  schemaRefToFilePath,
} from "@/lib/flows/editor/reference-sources";
import { semverGte } from "@/lib/flows/semver";
import { shellLintFindings } from "@/lib/flows/shell-lint";

// NEW content-validation codes (spec §6.1), kept disjoint from the existing
// `AuthoredFlowPackageValidationIssueCode` so consumers can widen the union.
export type ArtifactContentIssueCode =
  | "schema_json_invalid"
  | "form_schema_invalid"
  | "form_schema_missing"
  | "form_schema_reference_invalid"
  | "frontmatter_missing"
  | "frontmatter_field_missing"
  | "rule_guardrail_shape"
  | "form_schema_unreferenced"
  | "frontmatter_unknown_key"
  | "shell_lint";

export type ArtifactContentSeverity = "block" | "warn";

export type ArtifactContentIssue = {
  severity: ArtifactContentSeverity;
  code: ArtifactContentIssueCode;
  path: string;
  message: string;
};

export type ValidateArtifactContentInput = {
  files: readonly AuthoredFlowPackageFile[];
  // The parsed flow manifest (flow.yaml v1 object) or `null` when the yaml did
  // not parse (persisted RAW with manifest=null — M27 gotcha). Loosely typed:
  // this module only reads form_schema / output.result.schema reference strings.
  manifest: Record<string, unknown> | null;
};

const SKILL_KNOWN_KEYS = new Set([
  "name",
  "description",
  "argument-hint",
  "allowed-tools",
  "disable-model-invocation",
  "model",
]);

const RULE_KNOWN_KEYS = new Set([
  "allowed_paths",
  "forbidden_paths",
  "allowed_commands",
  "require_structured_response",
]);

export function validateArtifactContent(
  input: ValidateArtifactContentInput,
): ArtifactContentIssue[] {
  const issues: ArtifactContentIssue[] = [];
  const referenced =
    input.manifest === null
      ? new Set<string>()
      : collectReferencedSchemaPaths(input.manifest);

  for (const file of input.files) {
    const kind = classifyPackageFilePath(file.path);

    if (kind === "schema") {
      validateSchemaFile(file, referenced, issues);
    } else if (kind === "skill" && isSkillDefinitionPath(file.path)) {
      validateFrontmatterFile(
        file,
        skillFrontmatterSchema,
        SKILL_KNOWN_KEYS,
        issues,
      );
    } else if (
      kind === "agent_definition" &&
      isAgentDefinitionPath(file.path)
    ) {
      validateAgentDefinitionFile(file, issues);
    } else if (kind === "rule") {
      validateRuleFile(file, issues);
    } else if (kind === "script" || kind === "setup") {
      validateShellFile(file, issues);
    }
  }

  return issues;
}

// Frontmatter contracts apply ONLY to the runtime-consumed definition files
// (severity table: `skills/**/SKILL.md`, `agents/*.md`). Aux files under those
// trees (references, fixtures) carry no frontmatter contract and never block.
function isSkillDefinitionPath(filePath: string): boolean {
  return filePath.split("/").at(-1) === "SKILL.md";
}

function isAgentDefinitionPath(filePath: string): boolean {
  return /^(?:maister-agents|agents)\/[^/]+\.md$/.test(filePath);
}

// ADR-089 rework: canonical `maister-agents/*.md` (and the legacy `agents/*`
// alias accepted by imports) is a PLATFORM agent definition — validate
// with the real registration contract (parseAgentDefinition) so a Studio
// draft fails at save time exactly where the package install would.
function validateAgentDefinitionFile(
  file: AuthoredFlowPackageFile,
  issues: ArtifactContentIssue[],
): void {
  const split = splitFrontmatter(file.content);

  if (!split.ok || split.frontmatter === undefined) {
    issues.push({
      severity: "block",
      code: "frontmatter_missing",
      path: file.path,
      message: `${file.path} has missing or unparseable frontmatter (a leading \`---\` yaml block with the agent contract is required).`,
    });

    return;
  }

  const stem = (file.path.split("/").at(-1) ?? file.path).replace(/\.md$/, "");

  try {
    parseAgentDefinition(stem, file.content);
  } catch (err) {
    issues.push({
      severity: "block",
      code: "frontmatter_field_missing",
      path: file.path,
      message: `${file.path}: ${
        isMaisterError(err) || err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

// Shell scripts (`scripts/*`, `setup.sh`) get the heuristic shell-lint pass
// (spec §6.1). Every smell is WARN-only — advisory, never a save BLOCK.
function validateShellFile(
  file: AuthoredFlowPackageFile,
  issues: ArtifactContentIssue[],
): void {
  for (const finding of shellLintFindings(file.content)) {
    issues.push({
      severity: "warn",
      code: "shell_lint",
      path: file.path,
      message: finding.message,
    });
  }
}

function validateSchemaFile(
  file: Pick<AuthoredFlowPackageFile, "path" | "content">,
  referenced: ReadonlySet<string>,
  issues: ArtifactContentIssue[],
): void {
  // Only `.json` schema docs are JSON-parsed + grammar-checked. Non-`.json`
  // files under schemas/ (rare) carry no runtime contract here.
  if (!file.path.endsWith(".json")) return;

  let parsed: unknown;

  try {
    parsed = JSON.parse(file.content);
  } catch {
    issues.push({
      severity: "block",
      code: "schema_json_invalid",
      path: file.path,
      message: `Schema file ${file.path} is not valid JSON.`,
    });

    return;
  }

  const grammar = formSchemaSchema.safeParse(parsed);

  if (grammar.success) return;

  const detail = grammar.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  const isReferenced = referenced.has(file.path);

  issues.push({
    severity: isReferenced ? "block" : "warn",
    code: isReferenced ? "form_schema_invalid" : "form_schema_unreferenced",
    path: file.path,
    message: `${
      isReferenced
        ? "Manifest-referenced form schema"
        : "Form schema (not referenced by the manifest)"
    } ${file.path} is invalid: ${detail}.`,
  });
}

/**
 * Reusable schema-only validation for server lifecycle gates. Callers supply
 * the reference set for the manifests in their validation scope, keeping
 * unreferenced form-schema grammar advisory while malformed JSON always blocks.
 */
export function validateSchemaFiles(
  files: readonly Pick<AuthoredFlowPackageFile, "path" | "content">[],
  referenced: ReadonlySet<string>,
): ArtifactContentIssue[] {
  const issues: ArtifactContentIssue[] = [];

  for (const file of files) {
    if (classifyPackageFilePath(file.path) === "schema") {
      validateSchemaFile(file, referenced, issues);
    }
  }

  return issues;
}

function isRootSchemaReferencePath(value: string): boolean {
  return value === value.trim() && isRootSchemaFilePath(value);
}

function validateReferencedSchemaDocument(
  file: Pick<AuthoredFlowPackageFile, "path" | "content">,
  engineMin: string | undefined,
  issues: ArtifactContentIssue[],
): void {
  let parsed: unknown;

  try {
    parsed = JSON.parse(file.content);
  } catch {
    issues.push({
      severity: "block",
      code: "schema_json_invalid",
      path: file.path,
      message: `Schema file ${file.path} is not valid JSON.`,
    });

    return;
  }

  const grammar = formSchemaSchema.safeParse(parsed);

  if (grammar.success) {
    if (
      schemaDocUsesCoordinatorGrammar(grammar.data) &&
      !semverGte(engineMin ?? "", OUTPUT_COORDINATOR_ENGINE_MIN)
    ) {
      issues.push({
        severity: "block",
        code: "form_schema_invalid",
        path: file.path,
        message: `Manifest-referenced form schema ${file.path} uses the json field type or typed array items but the referencing flow declares compat.engine_min "${engineMin ?? "unset"}" < ${OUTPUT_COORDINATOR_ENGINE_MIN} — bump compat.engine_min to ${OUTPUT_COORDINATOR_ENGINE_MIN}.`,
      });
    }

    return;
  }

  const detail = grammar.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");

  issues.push({
    severity: "block",
    code: "form_schema_invalid",
    path: file.path,
    message: `Manifest-referenced form schema ${file.path} is invalid: ${detail}.`,
  });
}

/**
 * Validates exact documents referenced by form/output nodes. This mirrors the
 * runtime package contract: references resolve from the package-root
 * `schemas/<name>.json` directory, which is copied into every member flow
 * revision. They cannot escape, point outside that root, be missing, or hold
 * invalid form-schema JSON.
 */
export function validateFormSchemaReferences(
  files: readonly Pick<AuthoredFlowPackageFile, "path" | "content">[],
  references: SchemaReferenceFloors,
): ArtifactContentIssue[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const issues: ArtifactContentIssue[] = [];

  for (const reference of [...references.keys()].sort()) {
    if (!isRootSchemaReferencePath(reference)) {
      issues.push({
        severity: "block",
        code: "form_schema_reference_invalid",
        path: reference,
        message: `Form schema reference must resolve to package-root schemas/<name>.json: ${reference}.`,
      });
      continue;
    }

    const file = filesByPath.get(schemaRefToFilePath(reference));

    if (!file) {
      issues.push({
        severity: "block",
        code: "form_schema_missing",
        path: reference,
        message: `Manifest-referenced form schema is missing: ${reference}.`,
      });
      continue;
    }

    validateReferencedSchemaDocument(file, references.get(reference), issues);
  }

  return issues;
}

// ADR-162: a reference paired with the LOWEST `compat.engine_min` among the
// manifests that reference it — a document must satisfy the floor for every
// manifest using it, so the weakest declaration decides.
export type SchemaReferenceFloors = ReadonlyMap<string, string | undefined>;

// Records `manifest`'s schema references and folds its `compat.engine_min` into
// the running minimum for each.
export function addSchemaReferenceFloors(
  manifest: Record<string, unknown>,
  floors: Map<string, string | undefined>,
): void {
  const compat = manifest.compat;
  const engineMin =
    isRecord(compat) && typeof compat.engine_min === "string"
      ? compat.engine_min
      : undefined;

  for (const reference of collectReferencedSchemaPaths(manifest)) {
    if (!floors.has(reference)) {
      floors.set(reference, engineMin);
      continue;
    }
    const current = floors.get(reference);

    // `undefined` (no declared floor) is the weakest possible value. Otherwise
    // keep the lower of the two: a document must satisfy the floor for EVERY
    // manifest that references it. An unparseable declaration also sorts as
    // weaker (semverGte is false), which fails closed.
    if (current === undefined) continue;
    if (engineMin === undefined || !semverGte(engineMin, current)) {
      floors.set(reference, engineMin);
    }
  }
}

// ADR-162 (C-11): true when the document uses a grammar feature that arrived
// with engine 3.6.0 — the `json` field type or a typed array `items`, at any
// nesting depth.
export function schemaDocUsesCoordinatorGrammar(doc: unknown): boolean {
  if (!isRecord(doc)) return false;

  return specListUsesCoordinatorGrammar(doc.fields);
}

function specListUsesCoordinatorGrammar(value: unknown): boolean {
  if (!Array.isArray(value)) return false;

  return value.some((entry) => specUsesCoordinatorGrammar(entry));
}

function specUsesCoordinatorGrammar(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "json") return true;
  if (value.items !== undefined) return true;
  if (specListUsesCoordinatorGrammar(value.fields)) return true;

  return false;
}

function dedupeIssues(
  issues: readonly ArtifactContentIssue[],
): ArtifactContentIssue[] {
  const seen = new Set<string>();

  return issues.filter((issue) => {
    const key = `${issue.severity}:${issue.code}:${issue.path}:${issue.message}`;

    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });
}

function isFlowPackageFilePath(filePath: string): boolean {
  return filePath === "flow.yaml" || /^flows\/.+\/flow\.yaml$/.test(filePath);
}

/**
 * Client-side package-wide validation for Studio lifecycle controls. Every
 * current draft flow contributes its references, so a newly referenced but
 * unchanged invalid schema blocks Commit/Publish before the server rejects it.
 */
export function validatePackageArtifactContent(
  files: readonly AuthoredFlowPackageFile[],
): ArtifactContentIssue[] {
  const references = new Map<string, string | undefined>();

  for (const file of files) {
    if (!isFlowPackageFilePath(file.path)) continue;

    try {
      const manifest = parseYaml(file.content);

      if (isRecord(manifest)) {
        addSchemaReferenceFloors(manifest, references);
      }
    } catch {
      // Flow YAML parse/compile validation is server-authoritative; no inferred
      // reference is trustworthy when the draft itself cannot be parsed.
    }
  }

  return dedupeIssues([
    ...validateArtifactContent({ files, manifest: null }),
    ...validateFormSchemaReferences(files, references),
  ]);
}

function validateFrontmatterFile(
  file: AuthoredFlowPackageFile,
  schema: typeof skillFrontmatterSchema,
  knownKeys: ReadonlySet<string>,
  issues: ArtifactContentIssue[],
): void {
  const split = splitFrontmatter(file.content);

  if (!split.ok || split.frontmatter === undefined) {
    issues.push({
      severity: "block",
      code: "frontmatter_missing",
      path: file.path,
      message: `${file.path} has missing or unparseable frontmatter (a leading \`---\` yaml block with name + description is required).`,
    });

    return;
  }

  const result = schema.safeParse(split.frontmatter);

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");

    issues.push({
      severity: "block",
      code: "frontmatter_field_missing",
      path: file.path,
      message: `${file.path} frontmatter is missing required fields: ${detail}.`,
    });
  }

  pushUnknownFrontmatterKeys(file.path, split.frontmatter, knownKeys, issues);
}

function validateRuleFile(
  file: AuthoredFlowPackageFile,
  issues: ArtifactContentIssue[],
): void {
  const split = splitFrontmatter(file.content);

  // Rule guardrail frontmatter is entirely optional and WARN-only (no web
  // runtime parser exists). Malformed/missing frontmatter does not block a rule.
  if (!split.ok || split.frontmatter === undefined) return;

  const result = ruleGuardrailSchema.safeParse(split.frontmatter);

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");

    issues.push({
      severity: "warn",
      code: "rule_guardrail_shape",
      path: file.path,
      message: `${file.path} rule guardrail frontmatter shape is malformed: ${detail}.`,
    });
  }

  pushUnknownFrontmatterKeys(
    file.path,
    split.frontmatter,
    RULE_KNOWN_KEYS,
    issues,
  );
}

function pushUnknownFrontmatterKeys(
  path: string,
  frontmatter: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
  issues: ArtifactContentIssue[],
): void {
  for (const key of Object.keys(frontmatter)) {
    if (!knownKeys.has(key)) {
      issues.push({
        severity: "warn",
        code: "frontmatter_unknown_key",
        path,
        message: `${path} has an unrecognized frontmatter key "${key}" (preserved verbatim).`,
      });
    }
  }
}

// Collects every schema path the manifest REFERENCES on a runtime path: each
// node's `settings.form_schema` and `output.result.schema`, plus the flow-level
// `result.export.schema` (ADR-165). Paths are normalized
// (leading `./` stripped) so they
// match the persisted `files[].path` (e.g. `schemas/review.json`).
export function collectReferencedSchemaPaths(
  manifest: Record<string, unknown>,
): Set<string> {
  const refs = new Set<string>();

  addSchemaRefsFromList(manifest.nodes, refs);

  // ADR-165: the export schema is a RUNTIME reference — the launcher resolves it
  // from the pinned install path, so it needs the same floor folding and the
  // same "referenced schema files must exist and parse" treatment as a node's.
  const result = manifest.result;

  if (isRecord(result) && isRecord(result.export)) {
    addRef(result.export.schema, refs);
  }

  return refs;
}

function addSchemaRefsFromList(value: unknown, refs: Set<string>): void {
  if (!Array.isArray(value)) return;

  for (const entry of value) {
    if (!isRecord(entry)) continue;

    const settings = entry.settings;

    if (isRecord(settings)) {
      addRef(settings.form_schema, refs);
    }
    const output = entry.output;

    if (isRecord(output)) {
      const resultBlock = output.result;

      if (isRecord(resultBlock)) {
        addRef(resultBlock.schema, refs);
      }
    }
  }
}

function addRef(value: unknown, refs: Set<string>): void {
  if (typeof value !== "string") return;

  // Keep whitespace intact here: the runtime treats it as part of the path,
  // so the lifecycle validator must reject it rather than silently accepting a
  // UI-normalized variant.
  const normalized = value.startsWith("./") ? value.slice(2) : value;

  if (normalized.length > 0) refs.add(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
