import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import schemas from "../../runtime/knowledge-tool-input.schema.json";

export type KnowledgeToolName = keyof typeof schemas;
const descriptions: Readonly<Record<KnowledgeToolName, string>> = {
  knowledge_witness_get:
    "Inspect an accessible original evidence witness, including its exact source version, availability and limitations. Missing evidence must remain explicit.",
  knowledge_propose:
    "Submit an attributable knowledge addition or revision-bound correction for review. Acceptance and factual confirmation are separate actions. Reuse the same idempotencyKey for the same delivery.",
  knowledge_proposal_get:
    "Inspect an accessible proposal, its evidence, review state and accepted publication. A proposal is not a confirmed fact.",
  knowledge_proposals_list:
    "List proposals the current principal may review, with bounded summaries and authorization-scoped continuation. Follow nextCursor to continue.",
  knowledge_decide:
    "Accept or reject an exact proposal revision only under explicit current review authority. Acceptance does not confirm the published assertion. Ordinary specialist tokens cannot review.",
  knowledge_confirm:
    "Confirm or revoke confirmation of an exact record revision under explicit current confirmation authority. Confirmation requires available versioned evidence; agent completion does not confer this authority.",
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
  if (name === "knowledge_propose")
    return {
      method: "POST",
      path: "/api/v1/ext/knowledge/proposals",
      body: args,
    };
  if (name === "knowledge_decide") {
    const { proposalId, ...body } = args;

    return {
      method: "POST",
      path: `/api/v1/ext/knowledge/proposals/${encodeURIComponent(String(proposalId))}/decision`,
      body,
    };
  }
  if (name === "knowledge_confirm") {
    const { recordId, ...body } = args;

    return {
      method: "POST",
      path: `/api/v1/ext/knowledge/${encodeURIComponent(String(recordId))}/confirmations`,
      body,
    };
  }
  const query = new URLSearchParams();
  const { recordId, proposalId, witnessId, owner, ...parameters } = args;

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
  let resource: string;

  switch (name) {
    case "knowledge_search":
      resource = "";
      break;
    case "knowledge_proposals_list":
      resource = "/proposals";
      break;
    case "knowledge_proposal_get":
      resource = `/proposals/${encodeURIComponent(String(proposalId))}`;
      break;
    case "knowledge_witness_get":
      resource = `/witnesses/${encodeURIComponent(String(witnessId))}`;
      break;
    default:
      resource = `/${encodeURIComponent(String(recordId))}`;
  }
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
