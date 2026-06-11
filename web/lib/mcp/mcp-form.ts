// M27/T-C2: pure form logic for the platform MCP-server admin CRUD (mirrors
// lib/acp-runners/runner-form.ts). NOT server-only — shared by the client admin
// modal AND the server route handlers. No I/O — validation + body builders only.
// Secrets are NEVER values: env/header entries are `env:NAME` references (or
// bare NAMES) resolved supervisor-side.

import { ADAPTER_IDS, type AdapterId } from "@/lib/acp-runners/adapter-support";

export const MCP_TRANSPORTS = ["stdio", "sse", "http"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_AGENTS = ADAPTER_IDS;
export type McpAgent = AdapterId;

export type McpServerDraft = {
  id: string;
  transport: McpTransport;
  command?: string | null;
  args?: string[];
  envKeys?: string[];
  url?: string | null;
  headerKeys?: string[];
  supportedAgents?: McpAgent[];
  enabled?: boolean;
};

export type McpFormError = { field: string; message: string };
export type McpFormResult =
  | { ok: true }
  | { ok: false; errors: McpFormError[] };

const ID_RE = /^[A-Za-z0-9._-]+$/;
// Secret key references: an `env:NAME` ref or a bare env NAME (resolved
// supervisor-side from process.env). Plaintext values are never accepted.
const ENV_KEY_RE = /^(env:)?[A-Za-z_][A-Za-z0-9_]*$/;

export function validateMcpServerDraft(draft: McpServerDraft): McpFormResult {
  const errors: McpFormError[] = [];

  if (!draft.id || !ID_RE.test(draft.id)) {
    errors.push({ field: "id", message: "id must match [A-Za-z0-9._-]" });
  }
  if (!MCP_TRANSPORTS.includes(draft.transport)) {
    errors.push({ field: "transport", message: "unknown transport" });
  }

  if (draft.transport === "stdio") {
    if (!draft.command || draft.command.trim() === "") {
      errors.push({
        field: "command",
        message: "stdio transport requires a command",
      });
    }
  } else if (draft.transport === "sse" || draft.transport === "http") {
    if (!draft.url || draft.url.trim() === "") {
      errors.push({
        field: "url",
        message: `${draft.transport} transport requires a url`,
      });
    } else {
      try {
        new URL(draft.url);
      } catch {
        errors.push({
          field: "url",
          message: "url must be a valid absolute URL",
        });
      }
    }
  }

  for (const key of draft.envKeys ?? []) {
    if (!ENV_KEY_RE.test(key)) {
      errors.push({
        field: "envKeys",
        message: `invalid env key reference "${key}" (use env:NAME)`,
      });
    }
  }
  for (const key of draft.headerKeys ?? []) {
    if (!ENV_KEY_RE.test(key)) {
      errors.push({
        field: "headerKeys",
        message: `invalid header key reference "${key}" (use env:NAME)`,
      });
    }
  }

  const agents = draft.supportedAgents ?? MCP_AGENTS;

  if (agents.length === 0) {
    errors.push({
      field: "supportedAgents",
      message: "at least one supported agent is required",
    });
  }
  for (const agent of agents) {
    if (!MCP_AGENTS.includes(agent)) {
      errors.push({
        field: "supportedAgents",
        message: `unknown agent "${agent}"`,
      });
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// Persist-shape for a create/update. `command`/`args`/`envKeys` are only
// meaningful for stdio; `url`/`headerKeys` only for sse/http — the off-transport
// fields are normalized away so a transport switch never leaves stale config.
export function buildMcpServerFields(draft: McpServerDraft) {
  const isStdio = draft.transport === "stdio";

  return {
    transport: draft.transport,
    command: isStdio ? (draft.command ?? null) : null,
    args: isStdio ? (draft.args ?? []) : [],
    envKeys: isStdio ? (draft.envKeys ?? []) : [],
    url: isStdio ? null : (draft.url ?? null),
    headerKeys: isStdio ? [] : (draft.headerKeys ?? []),
    supportedAgents: draft.supportedAgents ?? [...MCP_AGENTS],
    enabled: draft.enabled ?? true,
  };
}

export function buildCreateBody(draft: McpServerDraft) {
  return { id: draft.id, ...buildMcpServerFields(draft) };
}
