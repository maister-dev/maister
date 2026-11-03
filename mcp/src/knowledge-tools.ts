import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import schemas from "../../runtime/knowledge-tool-input.schema.json";

export type KnowledgeToolName = keyof typeof schemas;
const descriptions: Readonly<Record<KnowledgeToolName, string>> = {
  knowledge_search:
    "Search accessible structured company/project knowledge. Ownership does not grant visibility. Results separate observations, assumptions, confirmation and freshness. Use the exact returned identities and revisions for follow-up; retrieval rank never confirms a claim.",
  knowledge_get:
    "Inspect an accessible structured record and its exact revision, server attribution, confirmation, missing support and unresolved conflicts. Omit revision to select the current head. Missing or inaccessible references never authorize invented citations.",
  knowledge_evidence:
    "Inspect bounded captured evidence for an accessible record revision. Preserve witness identities, content hashes and source versions in findings. Follow nextCursor to inspect the remaining original proof. Capture time is not observation time.",
  knowledge_conflicts:
    "Inspect accessible conflicting claims through bounded pages. Each edge retains the original opposing record revision. A score or a newer claim does not resolve a conflict; inaccessible claims remain withheld.",
  knowledge_capture_source:
    "Capture exact bounded submitted source bytes as attributable evidence, without asserting independent corroboration, historical observation time or factual confirmation. Reuse the same idempotencyKey for the same delivery. Company ownership requires no project.",
};

export const KNOWLEDGE_TOOL_SPECS = Object.fromEntries(
  Object.entries(schemas).map(([name, inputSchema]) => [
    name,
    {
      description: descriptions[name as KnowledgeToolName],
      inputSchema: inputSchema as Tool["inputSchema"],
    },
  ]),
);
const validators: Readonly<Record<string, z.ZodType>> = Object.fromEntries(
  Object.entries(schemas).map(([name, schema]) => [
    name,
    z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]),
  ]),
);

export function isKnowledgeTool(name: string): name is KnowledgeToolName {
  return Object.hasOwn(schemas, name);
}

export function parseKnowledgeToolArguments(
  name: KnowledgeToolName,
  input: Record<string, unknown>,
): Record<string, unknown> | null {
  const parsed = validators[name].safeParse(input);

  return parsed.success ? (parsed.data as Record<string, unknown>) : null;
}

export function knowledgeToolRouting(
  name: KnowledgeToolName,
  args: Record<string, unknown>,
): { method: "GET" | "POST"; path: string; body?: unknown } {
  if (name === "knowledge_capture_source")
    return {
      method: "POST",
      path: "/api/v1/ext/knowledge/sources",
      body: args,
    };
  const query = new URLSearchParams();
  const { recordId, owner, ...parameters } = args;

  if (owner !== undefined) {
    const selected = owner as
      | { kind: "company"; companyId: string }
      | { kind: "project"; projectId: string };

    query.set("ownerKind", selected.kind);
    query.set(
      "ownerId",
      selected.kind === "company" ? selected.companyId : selected.projectId,
    );
  }
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.size === 0 ? "" : `?${query.toString()}`;
  const resource =
    name === "knowledge_search"
      ? ""
      : `/${encodeURIComponent(String(recordId))}`;
  const detail =
    name === "knowledge_evidence"
      ? "/evidence"
      : name === "knowledge_conflicts"
        ? "/conflicts"
        : "";

  return {
    method: "GET",
    path: `/api/v1/ext/knowledge${resource}${detail}${suffix}`,
  };
}
