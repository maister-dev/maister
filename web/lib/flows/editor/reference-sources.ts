export type ReferenceSourceKind = "runner" | "agent" | "schema";

export type ReferenceSourceOption = {
  value: string;
  label: string;
  kind: ReferenceSourceKind;
  hint?: string;
  filePath?: string;
};

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

function slugifySchemaLabel(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.length > 0 ? slug : "schema";
}
