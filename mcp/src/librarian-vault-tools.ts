import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import agentMemorySchema from "../../runtime/agent-memory.schema.json";

const vaultId = { type: "string", minLength: 1, maxLength: 192 } as const;
const path = {
  type: "string",
  minLength: 1,
  maxLength: 512,
  pattern: "^/memories(?:/[^/]+)*$",
} as const;
const paging = {
  cursor: { type: "string", minLength: 1, maxLength: 2048 },
  limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
} as const;

const requestKey = {
  type: "string",
  minLength: 8,
  maxLength: 128,
  pattern: "^[A-Za-z0-9_.:-]{8,128}$",
};
const ifHash = { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" };
const browserEdits = [
  {
    type: "object",
    additionalProperties: false,
    required: ["command", "ifGeneration", "heads", "requestKey"],
    properties: {
      command: { type: "string", enum: ["clear"] },
      requestKey,
      ifGeneration: { type: "string", pattern: "^(0|[1-9][0-9]{0,18})$" },
      heads: {
        type: "array",
        maxItems: 1024,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "ifRevisionId", "ifHash"],
          properties: {
            path,
            ifRevisionId: vaultId,
            ifHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
          },
        },
      },
    },
  },
  {
    type: "object",
    additionalProperties: false,
    required: [
      "command",
      "noteId",
      "revisionId",
      "ifRevisionId",
      "ifHash",
      "requestKey",
    ],
    properties: {
      command: { type: "string", enum: ["revert"] },
      noteId: vaultId,
      revisionId: vaultId,
      ifRevisionId: vaultId,
      ifHash,
      requestKey,
    },
  },
];

export const librarianVaultToolSpecs = {
  agent_vault_list: spec(
    "List agent vaults the librarian's owner can currently access.",
    { ...paging },
    [],
  ),
  agent_vault_view: spec(
    "View a directory or paged note in an explicitly selected vault.",
    { vaultId, path, ...paging },
    ["vaultId", "path"],
  ),
  agent_vault_search: spec(
    "Search the visible notes of a selected vault.",
    {
      vaultId,
      q: { type: "string", minLength: 1, maxLength: 2000 },
      tag: { type: "string", minLength: 1, maxLength: 128 },
      mode: { type: "string", enum: ["lexical", "vector"], default: "lexical" },
      ...paging,
    },
    ["vaultId"],
  ),
  agent_vault_backlinks: spec(
    "List incoming links to a visible note.",
    { vaultId, path, ...paging },
    ["vaultId", "path"],
  ),
  agent_vault_tags: spec(
    "List tags from visible notes in the selected vault.",
    { vaultId, ...paging },
    ["vaultId"],
  ),
  agent_vault_propose_edit: spec(
    "Ask the owner to confirm an exact vault edit. Returns a pending confirmation card.",
    {
      vaultId,
      command: {
        oneOf: [
          ...agentMemorySchema.oneOf.filter(
            (entry) => !entry.properties.command.enum.includes("view"),
          ),
          ...browserEdits,
        ],
      },
      operationKey: { type: "string", minLength: 1, maxLength: 128 },
    },
    ["vaultId", "command", "operationKey"],
  ),
};

function spec(
  description: string,
  properties: NonNullable<Tool["inputSchema"]["properties"]>,
  required: string[],
) {
  return {
    description,
    inputSchema: {
      type: "object" as const,
      additionalProperties: false,
      properties,
      required,
    },
  };
}

export function librarianVaultRoute(
  name: string,
  args: Record<string, unknown>,
) {
  const { vaultId: id, ...rest } = args;
  const target =
    name === "agent_vault_list"
      ? "/api/v1/ext/librarian/vaults"
      : `/api/v1/ext/librarian/vaults/${encodeURIComponent(String(id))}/${name.slice("agent_vault_".length)}`;
  const selection = new URLSearchParams();

  for (const [key, value] of Object.entries(rest))
    if (value !== undefined) selection.set(key, String(value));

  return { method: "GET" as const, path: `${target}?${selection.toString()}` };
}
