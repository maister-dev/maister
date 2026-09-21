import type * as acp from "@agentclientprotocol/sdk";

// ADR-179: the execution host is the ONLY place an `env:NAME` reference becomes
// a value. A value is whole-value — `literal | env:NAME` — with no
// interpolation, so a literal containing `${X}` reaches the MCP server
// unchanged. Nothing here logs: a resolved value must not reach a log line, an
// event, or a response.
//
// Pure at import (no module-scope work) so a partially mocked consumer cannot
// fail a whole test file at collection time.

const ENV_REF_PREFIX = "env:";

export type McpValueMap = Readonly<Record<string, string>>;

export function resolveMcpValue(value: string): string {
  if (!value.startsWith(ENV_REF_PREFIX)) return value;

  return process.env[value.slice(ENV_REF_PREFIX.length)] ?? "";
}

export function resolveMcpMap(
  map: McpValueMap | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [name, value] of Object.entries(map ?? {})) {
    out[name] = resolveMcpValue(value);
  }

  return out;
}

// stdio: the ACP `EnvVariable[]` shape, in map order.
export function resolveMcpEnvVariables(
  map: McpValueMap | undefined,
): acp.EnvVariable[] {
  return Object.entries(map ?? {}).map(([name, value]) => ({
    name,
    value: resolveMcpValue(value),
  }));
}

function composedAuthorization(bearerTokenEnv: string): string {
  return `Bearer ${resolveMcpValue(bearerTokenEnv)}`;
}

// The MCP authorization spec fixes the header name and the scheme, so
// `bearerTokenEnv` is composed here rather than typed by an operator. It is
// appended LAST; the schema already refuses it beside a declared
// `Authorization` row, and dropping any such row here is defence in depth
// against emitting two conflicting values.
function withoutAuthorization(
  map: McpValueMap | undefined,
): [string, string][] {
  return Object.entries(map ?? {}).filter(
    ([name]) => name.toLowerCase() !== "authorization",
  );
}

// sse/http over ACP: `HttpHeader[]`.
export function resolveMcpHeaders(
  headers: McpValueMap | undefined,
  bearerTokenEnv: string | undefined,
): acp.HttpHeader[] {
  const declared = bearerTokenEnv
    ? withoutAuthorization(headers)
    : Object.entries(headers ?? {});
  const out: acp.HttpHeader[] = declared.map(([name, value]) => ({
    name,
    value: resolveMcpValue(value),
  }));

  if (bearerTokenEnv) {
    out.push({
      name: "Authorization",
      value: composedAuthorization(bearerTokenEnv),
    });
  }

  return out;
}

// sse/http over the MCP SDK probe transports: a plain `Record`.
export function resolveMcpHeaderRecord(
  headers: McpValueMap | undefined,
  bearerTokenEnv: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [name, value] of bearerTokenEnv
    ? withoutAuthorization(headers)
    : Object.entries(headers ?? {})) {
    out[name] = resolveMcpValue(value);
  }

  if (bearerTokenEnv) {
    out.Authorization = composedAuthorization(bearerTokenEnv);
  }

  return out;
}
