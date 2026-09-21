import { z } from "zod";

// ADR-177: THE grammar for every MCP configuration value — the platform row,
// the project row, the package manifest, the binding overlay, and the Studio
// template editor. Before this module there were three `env:` grammars and four
// verbatim copies of the MCP one, which is the defect shape this replaces.
//
// Isomorphic and pure at import: client components consume it, so no
// `server-only` import, and no module-scope work (a module-scope call into a
// partially mocked module fails whole test files as skips).
//
// A value is WHOLE-VALUE. There is no interpolation: a literal containing
// `${X}` reaches the server unchanged, because a provisioner substituting
// inside literals would corrupt values meant for the server.

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const ENV_REF_RE = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

// RFC 7230 token. A header name that is not a token cannot go on the wire.
export const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// RFC 7230 field-value alphabet (HTAB, VCHAR, obs-text). Applied only to a
// LITERAL header value, so a CR/LF injection is refused at write instead of
// surfacing as a runtime `fetch` TypeError. A reference is exempt: its value is
// known only after host resolution, which no write-time check can predict.
export const HEADER_VALUE_RE = /^[\t\x20-\x7e\x80-\xff]*$/;

const ENV_REF_PREFIX = "env:";

export type McpValueClass = "literal" | "env-ref" | "malformed-env-ref";

export function classifyMcpValue(value: string): McpValueClass {
  if (!value.startsWith(ENV_REF_PREFIX)) return "literal";

  return ENV_REF_RE.test(value) ? "env-ref" : "malformed-env-ref";
}

export function isEnvRef(value: string): boolean {
  return classifyMcpValue(value) === "env-ref";
}

// The host variable a value references, or null for a literal. Readiness
// collects names with this: a literal references nothing and therefore never
// produces a readiness reason.
export function envRefName(value: string): string | null {
  return isEnvRef(value) ? value.slice(ENV_REF_PREFIX.length) : null;
}

export function hasAuthorizationHeader(
  headers: Readonly<Record<string, string>> | undefined,
): boolean {
  return Object.keys(headers ?? {}).some(
    (name) => name.toLowerCase() === "authorization",
  );
}

// The MCP authorization spec fixes this header's name and scheme, so a bearer
// token is its own field rather than a row an operator retypes.
export const AUTHORIZATION_HEADER = "Authorization";

const SECRET_ENV_SEGMENTS = new Set([
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "APIKEY",
  "KEY",
]);

const SECRET_ENV_PAIRS = new Set(["API_KEY", "PRIVATE_KEY", "ACCESS_KEY"]);

const SECRET_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-auth-token",
]);

// D9: the secret guard is a UI WARNING, never a refusal — routes accept the
// value. Anchored on `_`-delimited segments so `MY_TOKEN_2` warns while
// `TOKENIZER_MODE` does not; a heuristic that cries wolf trains operators to
// ignore it. Bare `KEY` is deliberately NOT a positive on its own — only the
// two-segment forms below are — so `SSH_KEY_COMMENT` does not warn.
export function secretShapedKey(kind: "env" | "header", key: string): boolean {
  if (kind === "header") return SECRET_HEADER_NAMES.has(key.toLowerCase());

  const segments = key.toUpperCase().split("_");

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];

    if (segment !== "KEY" && SECRET_ENV_SEGMENTS.has(segment)) return true;
    if (i === 0) continue;
    if (SECRET_ENV_PAIRS.has(`${segments[i - 1]}_${segment}`)) return true;
  }

  return false;
}

export const mcpValueSchema = z
  .string()
  .max(4096)
  .refine((v) => !v.includes("\0"), "value must not contain a null byte")
  .refine(
    (v) => classifyMcpValue(v) !== "malformed-env-ref",
    "an env reference must be env:NAME",
  );

// A value that must be a reference, never a literal (`bearerTokenEnv`).
export const envRefSchema = z
  .string()
  .regex(ENV_REF_RE, "must be an env:NAME reference");

const headerValueSchema = mcpValueSchema.refine(
  (v) => isEnvRef(v) || HEADER_VALUE_RE.test(v),
  "header value must not contain CR, LF, or another control character",
);

export const MCP_MAP_MAX_ENTRIES = 64;

const boundedEntries = <T extends z.ZodTypeAny>(schema: T) =>
  schema.refine(
    (m) => Object.keys(m as object).length <= MCP_MAP_MAX_ENTRIES,
    `at most ${MCP_MAP_MAX_ENTRIES} entries`,
  );

export const mcpEnvMapSchema = boundedEntries(
  z.record(
    z.string().regex(ENV_NAME_RE, "must be an environment variable name"),
    mcpValueSchema,
  ),
);

export const mcpHeaderMapSchema = boundedEntries(
  z.record(
    z.string().regex(HEADER_NAME_RE, "must be an RFC 7230 header token"),
    headerValueSchema,
  ),
);

export type McpValueMap = z.infer<typeof mcpEnvMapSchema>;

// Every host variable an MCP row references, deduped in declaration order.
// Readiness asks the execution host about exactly these.
export function referencedEnvNames(source: {
  env?: Readonly<Record<string, string>> | null;
  headers?: Readonly<Record<string, string>> | null;
  bearerTokenEnv?: string | null;
}): string[] {
  const names = new Set<string>();

  for (const value of [
    ...Object.values(source.env ?? {}),
    ...Object.values(source.headers ?? {}),
    ...(source.bearerTokenEnv ? [source.bearerTokenEnv] : []),
  ]) {
    const name = envRefName(value);

    if (name) names.add(name);
  }

  return [...names];
}
