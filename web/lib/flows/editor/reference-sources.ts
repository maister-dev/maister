import { SKILL_PATH_RE } from "@/lib/capabilities/package-catalog";

export type ReferenceSourceKind = "runner" | "agent" | "schema";

export type ReferenceSourceOption = {
  value: string;
  label: string;
  kind: ReferenceSourceKind;
  hint?: string;
  filePath?: string;
};

// A plain {value,label} option for the node-form MultiSelectField (structurally
// the component's MultiSelectOption); derived client-side from the package's own
// skills and the platform MCP catalog.
export type CapabilityOption = { value: string; label: string };

export type ReferenceSourceGroup = {
  label: string;
  kind: ReferenceSourceKind;
  options: ReferenceSourceOption[];
};

export type SourceSelectionPatch = {
  agent?: string;
  runner?: string;
};

export type AssistantRunnerSource = {
  id: string;
  label: string;
  adapter: string;
  model?: string | null;
  isDefault: boolean;
};

type PackageFileLike = {
  path: string;
};

type KnownSourceSets = {
  runners: ReadonlySet<string>;
  agents: ReadonlySet<string>;
};

const ROOT_AGENT_PATTERN = /^maister-agents\/([^/]+)\.md$/;
const ROOT_SCHEMA_PATTERN = /^schemas\/([^/]+)\.json$/;

// Skill options for the node-form `skills` multiselect — one per
// `skills/<slug>/SKILL.md` in the package (mirrors buildAgentGroupFromFiles).
export function buildSkillOptions(
  files: readonly PackageFileLike[],
): CapabilityOption[] {
  return files
    .flatMap((file) => {
      const match = SKILL_PATH_RE.exec(file.path);

      if (!match) return [];

      return [{ value: match[1], label: match[1] }];
    })
    .sort(compareCapabilityOptions);
}

// MCP options for the node-form `mcps` multiselect — the platform MCP catalog
// ref ids (the only field read is `id`, so the input stays decoupled).
export function buildMcpOptions(
  mcps: readonly { id: string }[],
): CapabilityOption[] {
  return mcps
    .map((mcp) => ({ value: mcp.id, label: mcp.id }))
    .sort(compareCapabilityOptions);
}

export function buildRunnerGroup(
  runners: readonly AssistantRunnerSource[],
): ReferenceSourceGroup {
  return {
    label: "Runners",
    kind: "runner",
    options: runners.map((runner) => ({
      value: runner.id,
      label: runner.label,
      kind: "runner",
      hint: buildRunnerHint(runner),
    })),
  };
}

export function buildAgentGroupFromFiles(
  packageName: string,
  files: readonly PackageFileLike[],
): ReferenceSourceGroup {
  return {
    label: "Agents",
    kind: "agent",
    options: files
      .flatMap((file) => {
        const match = ROOT_AGENT_PATTERN.exec(file.path);

        if (!match) return [];

        const stem = match[1];

        return [
          {
            value: `${packageName}:${stem}`,
            label: stem,
            kind: "agent" as const,
            filePath: file.path,
          },
        ];
      })
      .sort(compareOptionsByLabel),
  };
}

export function buildSchemaOptions(
  files: readonly PackageFileLike[],
): ReferenceSourceOption[] {
  return files
    .flatMap((file) => {
      const match = ROOT_SCHEMA_PATTERN.exec(file.path);

      if (!match) return [];

      return [
        {
          value: schemaFilePathToRef(file.path),
          label: match[1],
          kind: "schema" as const,
          filePath: file.path,
        },
      ];
    })
    .sort(compareOptionsByLabel);
}

export function schemaRefToFilePath(ref: string): string {
  return ref.trim().replace(/^\.\//, "");
}

export function schemaFilePathToRef(filePath: string): string {
  return `./${schemaRefToFilePath(filePath)}`;
}

export function isRootSchemaFilePath(path: string): boolean {
  return ROOT_SCHEMA_PATTERN.test(schemaRefToFilePath(path));
}

export function deriveSchemaFileName(
  label: string,
  existingFilePaths: readonly string[],
): string {
  const baseSlug = slugifySchemaLabel(label);
  const existing = new Set(existingFilePaths.map(schemaRefToFilePath));
  let candidate = `schemas/${baseSlug}.json`;
  let suffix = 2;

  while (existing.has(candidate)) {
    candidate = `schemas/${baseSlug}-${suffix}.json`;
    suffix += 1;
  }

  return candidate;
}

export function resolveFreeTextSourceKind(
  value: string,
  known: KnownSourceSets,
): Exclude<ReferenceSourceKind, "schema"> {
  const normalized = value.trim();

  if (known.runners.has(normalized)) return "runner";
  if (known.agents.has(normalized)) return "agent";

  return "runner";
}

export function sourcePatchFromSelection(
  kind: Exclude<ReferenceSourceKind, "schema">,
  value: string,
): SourceSelectionPatch {
  if (kind === "agent") return { agent: value, runner: undefined };

  return { runner: value, agent: undefined };
}

function buildRunnerHint(runner: AssistantRunnerSource): string {
  return [runner.adapter, runner.model, runner.isDefault ? "default" : null]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" - ");
}

function compareOptionsByLabel(
  left: ReferenceSourceOption,
  right: ReferenceSourceOption,
): number {
  return left.label.localeCompare(right.label);
}

function compareCapabilityOptions(
  left: CapabilityOption,
  right: CapabilityOption,
): number {
  return left.label.localeCompare(right.label);
}

function slugifySchemaLabel(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : "schema";
}
