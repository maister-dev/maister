// M27/T-C2: pure form logic for the platform MCP-server admin CRUD (mirrors
// lib/acp-runners/runner-form.ts). NOT server-only — shared by the client admin
// modal AND the server route handlers. No I/O — validation + body builders only.
//
// ADR-177: env/header entries are `Record<name, value>` maps keyed by the name
// the SERVER reads, and each value is whole-value `literal | env:NAME` under
// the ONE grammar in `value-grammar.ts`. A literal is accepted — it is the
// operator's declaration that the value is not a secret, and the form warns
// inline under a secret-shaped key rather than refusing (D9).

import { z } from "zod";

import { ADAPTER_IDS, type AdapterId } from "@/lib/acp-runners/adapter-support";
import {
  classifyMcpValue,
  ENV_NAME_RE,
  envRefSchema,
  HEADER_NAME_RE,
  HEADER_VALUE_RE,
  hasAuthorizationHeader,
  isEnvRef,
  MCP_MAP_MAX_ENTRIES,
  mcpEnvMapSchema,
  mcpHeaderMapSchema,
} from "@/lib/mcp/value-grammar";

export const MCP_TRANSPORTS = ["stdio", "sse", "http"] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export const MCP_AGENTS = ADAPTER_IDS;
export type McpAgent = AdapterId;

export type McpValueMap = Record<string, string>;

export type McpServerDraft = {
  id: string;
  description?: string | null;
  transport: McpTransport;
  command?: string | null;
  args?: string[];
  env?: McpValueMap;
  url?: string | null;
  headers?: McpValueMap;
  bearerTokenEnv?: string | null;
  supportedAgents?: McpAgent[];
  enabled?: boolean;
};

export type McpFormError = { field: string; message: string };
export type McpFormResult =
  | { ok: true }
  | { ok: false; errors: McpFormError[] };

const ID_RE = /^[A-Za-z0-9._-]+$/;

function validateMap(
  kind: "env" | "headers",
  map: McpValueMap | undefined,
  errors: McpFormError[],
): void {
  const entries = Object.entries(map ?? {});
  const nameRe = kind === "env" ? ENV_NAME_RE : HEADER_NAME_RE;

  if (entries.length > MCP_MAP_MAX_ENTRIES) {
    errors.push({
      field: kind,
      message: `at most ${MCP_MAP_MAX_ENTRIES} entries`,
    });
  }

  for (const [key, value] of entries) {
    // A row with a value but no key is the component's blank-row state reaching
    // validation; name the row rather than silently dropping the value.
    if (key.trim() === "") {
      errors.push({ field: `${kind}.`, message: "key required" });
      continue;
    }
    if (!nameRe.test(key)) {
      errors.push({
        field: `${kind}.${key}`,
        message:
          kind === "env"
            ? "key must be an environment variable name"
            : "key must be an RFC 7230 header token",
      });
      continue;
    }
    if (classifyMcpValue(value) === "malformed-env-ref") {
      errors.push({
        field: `${kind}.${key}`,
        message: "an env reference must be env:NAME",
      });
      continue;
    }
    if (
      kind === "headers" &&
      !isEnvRef(value) &&
      !HEADER_VALUE_RE.test(value)
    ) {
      errors.push({
        field: `${kind}.${key}`,
        message:
          "header value must not contain CR, LF, or another control character",
      });
    }
  }
}

export function validateMcpServerDraft(draft: McpServerDraft): McpFormResult {
  const errors: McpFormError[] = [];

  if (!draft.id || !ID_RE.test(draft.id)) {
    errors.push({ field: "id", message: "id must match [A-Za-z0-9._-]" });
  }
  if (!MCP_TRANSPORTS.includes(draft.transport)) {
    errors.push({ field: "transport", message: "unknown transport" });
  }

  const isStdio = draft.transport === "stdio";

  if (isStdio) {
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

  // Only the transport's own map is validated: the other is normalized away by
  // `buildMcpServerFields`, so complaining about it would block a submit the
  // build step already fixes.
  if (isStdio) {
    validateMap("env", draft.env, errors);
  } else {
    validateMap("headers", draft.headers, errors);

    // A bearer token on stdio is normalized away rather than refused (the
    // supervisor refuses it — belt and braces, D23).
    if (draft.bearerTokenEnv) {
      if (!isEnvRef(draft.bearerTokenEnv)) {
        errors.push({
          field: "bearerTokenEnv",
          message: "must be an env:NAME reference",
        });
      } else if (hasAuthorizationHeader(draft.headers)) {
        // The MCP authorization spec fixes this header's name and scheme, so
        // there is exactly one source of truth for it.
        errors.push({
          field: "bearerTokenEnv",
          message:
            "bearerTokenEnv and an Authorization header row must not both be set",
        });
      }
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

// Persist-shape for a create/update. `command`/`args`/`env` are only meaningful
// for stdio; `url`/`headers`/`bearerTokenEnv` only for sse/http — the
// off-transport fields are normalized away so a transport switch never leaves
// stale config behind.
export function buildMcpServerFields(draft: McpServerDraft) {
  const isStdio = draft.transport === "stdio";
  const description = draft.description?.trim();

  return {
    description: description ? description : null,
    transport: draft.transport,
    command: isStdio ? (draft.command ?? null) : null,
    args: isStdio ? (draft.args ?? []) : [],
    env: isStdio ? (draft.env ?? {}) : {},
    url: isStdio ? null : (draft.url ?? null),
    headers: isStdio ? {} : (draft.headers ?? {}),
    bearerTokenEnv: isStdio ? null : draft.bearerTokenEnv || null,
    supportedAgents: draft.supportedAgents ?? [...MCP_AGENTS],
    enabled: draft.enabled ?? true,
  };
}

export function buildCreateBody(draft: McpServerDraft) {
  return { id: draft.id, ...buildMcpServerFields(draft) };
}

// ── Wire body schemas ────────────────────────────────────────────────────────
// ONE definition per surface, built from the grammar module. These replaced the
// four verbatim copies of the pre-ADR-177 key regex that lived in the route
// files. Transport-specific requirements stay with `validateMcpServerDraft`;
// the schemas own shape + grammar.

const mcpServerBodyFields = {
  description: z.string().max(512).nullable().optional(),
  transport: z.enum(MCP_TRANSPORTS),
  // Nullable because the client sends the NORMALIZED body (off-transport
  // fields as null).
  command: z.string().min(1).nullable().optional(),
  args: z.array(z.string()).optional(),
  env: mcpEnvMapSchema.optional(),
  url: z.string().url().nullable().optional(),
  headers: mcpHeaderMapSchema.optional(),
  bearerTokenEnv: envRefSchema.nullable().optional(),
  supportedAgents: z.array(z.enum(ADAPTER_IDS)).min(1).optional(),
} as const;

export const platformMcpBodySchema = z
  .object({
    id: z.string().min(1).regex(ID_RE),
    ...mcpServerBodyFields,
    enabled: z.boolean().optional(),
  })
  .strict();

export const platformMcpPatchSchema = z
  .object({
    ...mcpServerBodyFields,
    transport: z.enum(MCP_TRANSPORTS).optional(),
    enabled: z.boolean().optional(),
    trustStatus: z
      .enum(["untrusted", "trusted", "trusted_by_policy"])
      .optional(),
  })
  .strict();

// The live project route takes `id` (what `buildCreateBody` emits), not
// `refId` — the OpenAPI said `refId` and was drift older than ADR-177.
export const projectMcpBodySchema = z
  .object({
    id: z.string().min(1).regex(ID_RE),
    ...mcpServerBodyFields,
  })
  .strict();

export const projectMcpPatchSchema = z
  .object({
    ...mcpServerBodyFields,
    transport: z.enum(MCP_TRANSPORTS).optional(),
  })
  .strict();
