import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import schemas from "../../runtime/knowledge-tool-input.schema.json";
import { NATIVE_KNOWLEDGE_TOOL_EFFECTS } from "../../runtime/knowledge-tool-effects";

export type KnowledgeToolName = keyof typeof schemas;
const descriptions: Readonly<Record<KnowledgeToolName, string>> = {
  assignment_question_ask:
    "Request human clarification for your current appointed assignment using exact business/input revisions from assignment_get, a version-one MAIster FormSchema and a stable idempotencyKey. The server retains your actual Run/node and checkpoints its current prompt before Inbox activation. Never supply actor, owner, grants or source proof. Human answers become attributed input; they do not accept work or confer action authority.",
  assignment_question_respond:
    "Answer an exact native assignment question as the currently authorized human personal-token owner. Preserve exact business/input revisions and the stable answer key. Agents and project tokens cannot answer human work. Accepted answers queue the same Run; this is not evidence of delivery, verification, work acceptance or Brain confirmation.",
  assignment_get:
    "Inspect your appointed assignment, its business/input/context revisions, responsibility and expected result under current source access. These revisions are distinct; preserve the exact business/input values for clarification CAS. Inspection does not accept work or confirm Brain facts.",
  assignment_context_update:
    "Append bounded working context under exact context/input revisions and a stable idempotencyKey. Server records your current Run/node authorship and inherited sources. Use explicit supersession; conflicts require inspection and deliberate rebase. This cannot accept child work or confirm a Brain fact. Never supply actor, grants or ownership epochs.",
  assignment_context_get:
    "Read the exact authorized working context of your appointed assignment. Preserve its revision, input witness, original authors, evidence and unresolved questions. Context is working material; notes and child completion do not confirm Brain facts or accept the overall assignment.",
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
  proposal_reviews_list: "List authorized pending decisions or retained decisions by scope. Requires a global personal token and the appropriate content scopes.",
  proposal_review_get: "Inspect an exact authorized human review and its observed version, evidence or diff, and available decision outcome. This works independently of the current list page.",
  proposal_review_decide: "Settle one inspected Brain or vault proposal with the exact version and a stable request key. Rejection needs a reason. Use knowledge_decide for structured knowledge.",
  personal_vault_list: "Page project and installation memory locations available to this human. Requires explicit agent_memory:read.",
  personal_vault_view: "Read the indicated vault location by directory or note path, or by stable note ID. Follow the authorized continuation for remaining content.",
  personal_vault_revisions: "Page retained revisions for one exact note in an authorized vault.",
  personal_vault_revision_get: "Read an exact authorized retained revision. A removed or concealed payload is unavailable.",
  knowledge_revisions_list: "Page exact retained record revisions visible under current owner and source policies.",
};

export const KNOWLEDGE_TOOL_SPECS = Object.fromEntries(
  Object.entries(schemas).map(([name, inputSchema]) => [
    name,
    {
      description: descriptions[name as KnowledgeToolName],
      inputSchema: inputSchema as Tool["inputSchema"],
      annotations: {
        readOnlyHint:
          NATIVE_KNOWLEDGE_TOOL_EFFECTS[name as KnowledgeToolName] === "read",
      },
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
): { method: "GET" | "POST" | "PATCH"; path: string; body?: unknown } {
  const reviewRoot = "/api/v1/ext/inbox/reviews";
  const vaultRoot = "/api/v1/ext/knowledge/vaults";
  const encode = (value: unknown) => encodeURIComponent(String(value));
  const get = (path: string, filters: Record<string, unknown>) => {
    const query = new URLSearchParams();

    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) query.set(key, String(value));
    }

    return { method: "GET" as const, path: query.size ? `${path}?${query}` : path };
  };

  if (name === "proposal_reviews_list") return get(reviewRoot, args);
  if (name === "proposal_review_get" || name === "proposal_review_decide") {
    const { kind, proposalId, ...input } = args;
    const path = `${reviewRoot}/${encode(kind)}/${encode(proposalId)}`;

    return name === "proposal_review_decide" ? { method: "POST", path: `${path}/decision`, body: input } : get(path, input);
  }
  if (name === "personal_vault_list") return get(vaultRoot, args);
  if (name === "personal_vault_view" || name === "personal_vault_revisions" || name === "personal_vault_revision_get") {
    const { locationId, noteId, revisionId, ...filters } = args;
    const path = `${vaultRoot}/${encode(locationId)}`;

    if (name === "personal_vault_view") return get(noteId ? `${path}/notes/${encode(noteId)}` : `${path}/view`, filters);
    const note = `${path}/notes/${encode(noteId)}/revisions`;

    return get(name === "personal_vault_revision_get" ? `${note}/${encode(revisionId)}` : note, filters);
  }
  if (name === "knowledge_revisions_list") {
    const { recordId, ...filters } = args;

    return get(`/api/v1/ext/knowledge/${encode(recordId)}/revisions`, filters);
  }
  if (name === "assignment_question_ask") {
    const { assignmentId, ...body } = args;

    return {
      method: "POST",
      path: `/api/v1/ext/specialist-assignments/${encodeURIComponent(String(assignmentId))}/questions`,
      body,
    };
  }
  if (name === "assignment_question_respond") {
    const { assignmentId, questionId, ...body } = args;

    return {
      method: "POST",
      path: `/api/v1/ext/specialist-assignments/${encodeURIComponent(String(assignmentId))}/questions/${encodeURIComponent(String(questionId))}/respond`,
      body,
    };
  }
  if (name === "assignment_get")
    return {
      method: "GET",
      path: `/api/v1/ext/specialist-assignments/${encodeURIComponent(String(args.assignmentId))}`,
    };
  if (name === "assignment_context_update") {
    const { assignmentId, ...body } = args;

    return {
      method: "PATCH",
      path: `/api/v1/ext/specialist-assignments/${encodeURIComponent(String(assignmentId))}/context`,
      body,
    };
  }
  if (name === "assignment_context_get") {
    const query =
      args.revision === undefined ? "" : `?revision=${String(args.revision)}`;

    return {
      method: "GET",
      path: `/api/v1/ext/specialist-assignments/${encodeURIComponent(String(args.assignmentId))}/context${query}`,
    };
  }
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
