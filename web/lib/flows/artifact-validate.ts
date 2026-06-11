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

import { formSchemaSchema } from "@/lib/config.schema";
import {
  agentFrontmatterSchema,
  ruleGuardrailSchema,
  skillFrontmatterSchema,
  splitFrontmatter,
} from "@/lib/flows/artifact-frontmatter";
import { classifyPackageFilePath } from "@/lib/flows/editor/package-file-tree";
import { shellLintFindings } from "@/lib/flows/shell-lint";

// NEW content-validation codes (spec §6.1), kept disjoint from the existing
// `AuthoredFlowPackageValidationIssueCode` so consumers can widen the union.
export type ArtifactContentIssueCode =
  | "schema_json_invalid"
  | "form_schema_invalid"
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

const AGENT_KNOWN_KEYS = new Set([
  "name",
  "description",
  "tools",
  "model",
  "permissionMode",
  "maxTurns",
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
      validateFrontmatterFile(
        file,
        agentFrontmatterSchema,
        AGENT_KNOWN_KEYS,
        issues,
      );
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
  return /^agents\/[^/]+\.md$/.test(filePath);
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
  file: AuthoredFlowPackageFile,
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

function validateFrontmatterFile(
  file: AuthoredFlowPackageFile,
  schema: typeof skillFrontmatterSchema | typeof agentFrontmatterSchema,
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
// node's `settings.form_schema` and `output.result.schema`, plus legacy
// `steps[].form_schema`. Paths are normalized (leading `./` stripped) so they
// match the persisted `files[].path` (e.g. `schemas/review.json`).
function collectReferencedSchemaPaths(
  manifest: Record<string, unknown>,
): Set<string> {
  const refs = new Set<string>();

  addSchemaRefsFromList(manifest.nodes, refs);
  addSchemaRefsFromList(manifest.steps, refs);

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
    // Legacy linear `steps[]` declare `form_schema` at the top level.
    addRef(entry.form_schema, refs);

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

  const normalized = value.replace(/^\.\//, "");

  if (normalized.length > 0) refs.add(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
