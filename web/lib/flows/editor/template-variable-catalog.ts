import type { FlowYamlV1, FormSchema } from "@/lib/config.schema";

import { formSchemaSchema } from "@/lib/config.schema";
import {
  isRootSchemaFilePath,
  schemaRefToFilePath,
} from "@/lib/flows/editor/reference-sources";

export type TemplateVariableAvailability = "definite" | "conditional";
export type TemplateVariablePresence = "required" | "optional";
export type TemplateVariableSource = "global" | "step" | "artifact" | "rework";

export type TemplateVariablePath = string;

export type TemplateVariableEntry = {
  path: TemplateVariablePath;
  label: string;
  source: TemplateVariableSource;
  availability: TemplateVariableAvailability;
  presence: TemplateVariablePresence;
  insertText: string;
  nodeId?: string;
  valueType?: string;
  description?: string;
};

export type TemplateVariableCatalogWarningCode =
  | "schema_ref_out_of_scope"
  | "schema_missing"
  | "schema_invalid";

export type TemplateVariableCatalogWarning = {
  code: TemplateVariableCatalogWarningCode;
  nodeId: string;
  schemaRef: string;
  message: string;
};

export type TemplateVariableCatalogResult = {
  entries: TemplateVariableEntry[];
  warnings: TemplateVariableCatalogWarning[];
  unavailablePaths: string[];
};

export type TemplateVariablePackageFile = {
  path: string;
  content: string;
};

export type BuildTemplateVariableCatalogInput = {
  manifest: FlowYamlV1;
  selectedNodeId: string;
  files: readonly TemplateVariablePackageFile[];
};

export type TemplateVariableUsageWarningCode =
  | "missing_default"
  | "unknown_path"
  | "unavailable_path";

export type TemplateVariableUsageWarning = {
  code: TemplateVariableUsageWarningCode;
  severity: "warning" | "error";
  path: string;
  message: string;
};

export type TemplateVariableToken = {
  raw: string;
  path: string;
  defaulted: boolean;
  start: number;
  end: number;
  entry?: TemplateVariableEntry;
};

export type TemplateVariableUsageResult = {
  tokens: TemplateVariableToken[];
  warnings: TemplateVariableUsageWarning[];
};

type ProducerAvailability = {
  id: string;
  type: string;
  availability: TemplateVariableAvailability;
  node: NodeLike | StepLike;
};

type NodeLike = NonNullable<FlowYamlV1["nodes"]>[number];
type StepLike = NonNullable<FlowYamlV1["steps"]>[number];
type EdgeMap = Map<string, Set<string>>;
type SchemaField = FormSchema["fields"][number];

const TEMPLATE_PATH_RE = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

export const STATIC_TEMPLATE_VARIABLES: readonly TemplateVariableEntry[] = [
  staticEntry("task.id"),
  staticEntry("task.title"),
  staticEntry("task.prompt"),
  staticEntry("task.attemptNumber"),
  staticEntry("run.id"),
  staticEntry("run.attemptNumber"),
  staticEntry("run.projectSlug"),
  staticEntry("executor.id"),
  staticEntry("executor.agent"),
  staticEntry("executor.model"),
  staticEntry("executor.router", "optional"),
];

export function buildTemplateVariableCatalog({
  manifest,
  selectedNodeId,
  files,
}: BuildTemplateVariableCatalogInput): TemplateVariableCatalogResult {
  const entries: TemplateVariableEntry[] = [];
  const warnings: TemplateVariableCatalogWarning[] = [];
  const unavailablePaths = [
    `steps.${selectedNodeId}.output`,
    `steps.${selectedNodeId}.vars`,
    `steps.${selectedNodeId}.exitCode`,
  ];
  const schemaFiles = new Map(files.map((file) => [file.path, file.content]));
  const producers = manifest.nodes
    ? graphProducers(manifest.nodes, selectedNodeId)
    : legacyProducers(manifest.steps ?? [], selectedNodeId);

  for (const producer of producers) {
    addProducerEntries(entries, warnings, schemaFiles, producer);
  }

  entries.push(...STATIC_TEMPLATE_VARIABLES);

  return {
    entries,
    warnings,
    unavailablePaths,
  };
}

export function analyzeTemplateVariableUsage(
  prompt: string,
  catalog: TemplateVariableCatalogResult,
): TemplateVariableUsageResult {
  const entries = new Map(catalog.entries.map((entry) => [entry.path, entry]));
  const unavailablePaths = new Set(catalog.unavailablePaths);
  const tokens: TemplateVariableToken[] = [];
  const warnings: TemplateVariableUsageWarning[] = [];

  for (const token of scanTemplateTokens(prompt)) {
    const entry = entries.get(token.path);
    const resolvedToken = { ...token, entry };

    tokens.push(resolvedToken);

    if (!entry) {
      if (unavailablePaths.has(token.path)) {
        warnings.push({
          code: "unavailable_path",
          severity: "warning",
          path: token.path,
          message: "Variable is not available for the selected node.",
        });
        continue;
      }

      warnings.push({
        code: "unknown_path",
        severity: "error",
        path: token.path,
        message: "Variable is not known at the selected node.",
      });
      continue;
    }

    if (
      !token.defaulted &&
      (entry.availability === "conditional" || entry.presence === "optional")
    ) {
      warnings.push({
        code: "missing_default",
        severity: "warning",
        path: token.path,
        message: "Variable may be absent at runtime; add a default.",
      });
    }
  }

  return { tokens, warnings };
}

function staticEntry(
  path: string,
  presence: TemplateVariablePresence = "required",
): TemplateVariableEntry {
  return createEntry({
    path,
    source: "global",
    availability: "definite",
    presence,
  });
}

function createEntry(input: {
  path: string;
  source: TemplateVariableSource;
  availability: TemplateVariableAvailability;
  presence: TemplateVariablePresence;
  nodeId?: string;
  valueType?: string;
  description?: string;
}): TemplateVariableEntry {
  const presence =
    input.availability === "conditional" ? "optional" : input.presence;

  return {
    path: input.path,
    label: input.path,
    source: input.source,
    availability: input.availability,
    presence,
    insertText:
      input.availability === "definite" && presence === "required"
        ? input.path
        : `${input.path} ?? ''`,
    nodeId: input.nodeId,
    valueType: input.valueType,
    description: input.description,
  };
}

function graphProducers(
  nodes: readonly NodeLike[],
  selectedNodeId: string,
): ProducerAvailability[] {
  const ids = new Set(nodes.map((node) => node.id));
  const edges = buildEdges(nodes, ids);
  const entryId = nodes[0]?.id;

  if (!entryId) return [];

  return nodes.flatMap((node) => {
    if (node.id === selectedNodeId) return [];
    if (!canReach(node.id, selectedNodeId, edges)) return [];

    const availability = canReach(entryId, selectedNodeId, edges, node.id)
      ? "conditional"
      : "definite";

    return [
      {
        id: node.id,
        type: node.type,
        availability,
        node,
      },
    ];
  });
}

function legacyProducers(
  steps: readonly StepLike[],
  selectedNodeId: string,
): ProducerAvailability[] {
  const selectedIndex = steps.findIndex((step) => step.id === selectedNodeId);

  if (selectedIndex <= 0) return [];

  return steps.slice(0, selectedIndex).map((step) => ({
    id: step.id,
    type: step.type,
    availability: "definite",
    node: step,
  }));
}

function buildEdges(nodes: readonly NodeLike[], ids: Set<string>): EdgeMap {
  const edges: EdgeMap = new Map(nodes.map((node) => [node.id, new Set()]));

  for (const node of nodes) {
    const outgoing = edges.get(node.id);

    if (!outgoing) continue;

    for (const target of Object.values(node.transitions ?? {})) {
      if (ids.has(target)) outgoing.add(target);
    }

    for (const target of node.rework?.allowedTargets ?? []) {
      if (ids.has(target)) outgoing.add(target);
    }

    for (const target of decideTargets(node)) {
      if (ids.has(target)) outgoing.add(target);
      const transitionTarget = node.transitions?.[target];

      if (transitionTarget && ids.has(transitionTarget)) {
        outgoing.add(transitionTarget);
      }
    }

    const mismatchTarget = node.output?.result?.on_mismatch;

    if (mismatchTarget && mismatchTarget !== "retry") {
      const transitionTarget = node.transitions?.[mismatchTarget];

      if (transitionTarget && ids.has(transitionTarget)) {
        outgoing.add(transitionTarget);
      }
    }
  }

  return edges;
}

function decideTargets(node: NodeLike): string[] {
  return (node.decide?.cases ?? []).map((decision) => decision.target);
}

function canReach(
  start: string,
  target: string,
  edges: EdgeMap,
  blocked?: string,
): boolean {
  if (start === blocked) return false;
  if (start === target) return true;

  const visited = new Set<string>();
  const stack = [start];

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current || visited.has(current) || current === blocked) continue;
    if (current === target) return true;

    visited.add(current);

    for (const next of edges.get(current) ?? []) {
      if (!visited.has(next)) stack.push(next);
    }
  }

  return false;
}

function addProducerEntries(
  entries: TemplateVariableEntry[],
  warnings: TemplateVariableCatalogWarning[],
  schemaFiles: ReadonlyMap<string, string>,
  producer: ProducerAvailability,
): void {
  addStepRootEntries(entries, producer);
  addSchemaEntries(entries, warnings, schemaFiles, producer);
  addArtifactEntries(entries, producer);
  addReworkCommentEntry(entries, producer);
}

function addStepRootEntries(
  entries: TemplateVariableEntry[],
  producer: ProducerAvailability,
): void {
  entries.push(
    createEntry({
      path: `steps.${producer.id}.output`,
      source: "step",
      availability: producer.availability,
      presence: "required",
      nodeId: producer.id,
      valueType: "string",
    }),
  );
  entries.push(
    createEntry({
      path: `steps.${producer.id}.vars`,
      source: "step",
      availability: producer.availability,
      presence: "required",
      nodeId: producer.id,
      valueType: "object",
    }),
  );
  entries.push(
    createEntry({
      path: `steps.${producer.id}.exitCode`,
      source: "step",
      availability: producer.availability,
      presence: isCliLike(producer.type) ? "required" : "optional",
      nodeId: producer.id,
      valueType: "number",
    }),
  );
}

function addSchemaEntries(
  entries: TemplateVariableEntry[],
  warnings: TemplateVariableCatalogWarning[],
  schemaFiles: ReadonlyMap<string, string>,
  producer: ProducerAvailability,
): void {
  for (const schemaRef of schemaRefsForProducer(producer.node)) {
    const result = resolveSchema(schemaFiles, producer.id, schemaRef);

    if (!result.ok) {
      warnings.push(result.warning);
      continue;
    }

    for (const entry of entriesForFields(
      producer,
      result.schema.fields,
      `steps.${producer.id}.vars`,
      true,
    )) {
      entries.push(entry);
    }
  }
}

function addArtifactEntries(
  entries: TemplateVariableEntry[],
  producer: ProducerAvailability,
): void {
  const output = nodeOutput(producer.node);

  for (const artifact of output?.produces ?? []) {
    entries.push(
      createEntry({
        path: `artifacts.${artifact.id}.kind`,
        source: "artifact",
        availability: producer.availability,
        presence: "required",
        nodeId: producer.id,
        valueType: "string",
      }),
      createEntry({
        path: `artifacts.${artifact.id}.uri`,
        source: "artifact",
        availability: producer.availability,
        presence: "optional",
        nodeId: producer.id,
        valueType: "string",
      }),
      createEntry({
        path: `artifacts.${artifact.id}.validity`,
        source: "artifact",
        availability: producer.availability,
        presence: "required",
        nodeId: producer.id,
        valueType: "string",
      }),
      createEntry({
        path: `artifacts.${artifact.id}.nodeId`,
        source: "artifact",
        availability: producer.availability,
        presence: "optional",
        nodeId: producer.id,
        valueType: "string",
      }),
    );
  }
}

function addReworkCommentEntry(
  entries: TemplateVariableEntry[],
  producer: ProducerAvailability,
): void {
  const commentsVar = nodeRework(producer.node)?.commentsVar;

  if (!commentsVar || !TEMPLATE_PATH_RE.test(commentsVar)) return;

  entries.push(
    createEntry({
      path: commentsVar,
      source: "rework",
      availability: "conditional",
      presence: "optional",
      nodeId: producer.id,
      valueType: "string",
    }),
  );
}

function entriesForFields(
  producer: ProducerAvailability,
  fields: readonly SchemaField[],
  prefix: string,
  parentRequired: boolean,
): TemplateVariableEntry[] {
  return fields.flatMap((field) => {
    const fieldRequired = parentRequired && field.required === true;
    const path = `${prefix}.${field.name}`;
    const entry = createEntry({
      path,
      source: "step",
      availability: producer.availability,
      presence: fieldRequired ? "required" : "optional",
      nodeId: producer.id,
      valueType: field.type,
    });

    if (field.type !== "object") return [entry];

    return [
      entry,
      ...entriesForFields(
        producer,
        field.fields ?? [],
        path,
        fieldRequired,
      ),
    ];
  });
}

function resolveSchema(
  schemaFiles: ReadonlyMap<string, string>,
  nodeId: string,
  schemaRef: string,
):
  | { ok: true; schema: FormSchema }
  | { ok: false; warning: TemplateVariableCatalogWarning } {
  const schemaPath = schemaRefToFilePath(schemaRef);

  if (!isRootSchemaFilePath(schemaPath)) {
    return {
      ok: false,
      warning: {
        code: "schema_ref_out_of_scope",
        nodeId,
        schemaRef,
        message: "Schema ref must point to a root schemas/*.json file.",
      },
    };
  }

  const content = schemaFiles.get(schemaPath);

  if (content === undefined) {
    return {
      ok: false,
      warning: {
        code: "schema_missing",
        nodeId,
        schemaRef,
        message: "Schema file is not loaded in the package draft.",
      },
    };
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    const result = formSchemaSchema.safeParse(parsed);

    if (!result.success) {
      return {
        ok: false,
        warning: {
          code: "schema_invalid",
          nodeId,
          schemaRef,
          message: result.error.issues
            .map((issue) => issue.message)
            .join("; "),
        },
      };
    }

    return { ok: true, schema: result.data };
  } catch (error) {
    return {
      ok: false,
      warning: {
        code: "schema_invalid",
        nodeId,
        schemaRef,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function schemaRefsForProducer(node: NodeLike | StepLike): string[] {
  const refs: string[] = [];
  const output = nodeOutput(node);
  const settings = nodeSettings(node);
  const legacyFormSchema = nodeLegacyFormSchema(node);

  if (output?.result?.schema) refs.push(output.result.schema);
  if (typeof settings?.form_schema === "string") refs.push(settings.form_schema);
  if (legacyFormSchema) refs.push(legacyFormSchema);

  return refs;
}

function isCliLike(type: string): boolean {
  return type === "cli" || type === "check";
}

function nodeOutput(
  node: NodeLike | StepLike,
): NonNullable<NodeLike["output"]> | undefined {
  return "output" in node ? node.output : undefined;
}

function nodeSettings(node: NodeLike | StepLike): { form_schema?: string } {
  return "settings" in node ? node.settings ?? {} : {};
}

function nodeLegacyFormSchema(node: NodeLike | StepLike): string | undefined {
  return "form_schema" in node ? node.form_schema : undefined;
}

function nodeRework(
  node: NodeLike | StepLike,
): { commentsVar?: string } | undefined {
  return "rework" in node ? node.rework : undefined;
}

type ParsedTemplateToken = {
  raw: string;
  path: string;
  defaulted: boolean;
  start: number;
  end: number;
};

function scanTemplateTokens(prompt: string): ParsedTemplateToken[] {
  const tokens: ParsedTemplateToken[] = [];
  let cursor = 0;

  while (cursor < prompt.length) {
    const start = prompt.indexOf("{{", cursor);

    if (start === -1) break;

    const close = findMustacheClose(prompt, start);

    if (close === -1) break;

    const raw = prompt.slice(start + 2, close).trim();
    const parsed = parseVariableToken(raw);

    if (parsed) {
      tokens.push({
        raw,
        path: parsed.path,
        defaulted: parsed.defaulted,
        start,
        end: close + 2,
      });
    }

    cursor = close + 2;
  }

  return tokens;
}

function parseVariableToken(
  raw: string,
): { path: string; defaulted: boolean } | null {
  if (raw === "" || "#/^!>&".includes(raw[0] ?? "")) return null;

  const defaultExpression = parseDefaultExpression(raw);

  if (defaultExpression) {
    return { path: defaultExpression.path, defaulted: true };
  }

  if (!TEMPLATE_PATH_RE.test(raw)) return null;

  return { path: raw, defaulted: false };
}

function findMustacheClose(template: string, start: number): number {
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = start + 2; index < template.length - 1; index += 1) {
    const char = template[index];

    if (quote !== null) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "}" && template[index + 1] === "}") return index;
  }

  return -1;
}

function parseDefaultExpression(
  raw: string,
): { path: string; literal: string } | null {
  const match = raw.match(/^([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\?\?\s*/);

  if (!match) return null;

  const literalInput = raw.slice(match[0].length);
  const literal = readQuotedLiteral(literalInput);

  if (!literal) return null;
  if (literalInput.slice(literal.end).trim() !== "") return null;

  return { path: match[1], literal: literal.value };
}

function readQuotedLiteral(
  input: string,
): { value: string; end: number } | null {
  const quote = input[0];

  if (quote !== "'" && quote !== '"') return null;

  let value = "";
  let escaped = false;

  for (let index = 1; index < input.length; index += 1) {
    const char = input[index];

    if (escaped) {
      if (char === "n") value += "\n";
      else if (char === "r") value += "\r";
      else if (char === "t") value += "\t";
      else value += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === quote) return { value, end: index + 1 };

    value += char;
  }

  return null;
}
