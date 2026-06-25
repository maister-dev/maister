// ADR-111: resolve the effective agent config — a 2-level merge of the
// declared defaults under the per-project instance values. Client-import-safe
// (no fs, no node:*, no DB): the caller passes the already-loaded declaration
// (from the .md / `agents.config_schema`) and the instance map (from
// `agent_project_links.config`). The result is snapshotted onto
// `runs.agent_config` at launch and never re-resolved (launch-time-snapshot).

import type { AgentConfigParam } from "@/lib/agents/definition";

export function resolveAgentConfig(
  declared: AgentConfigParam[] | null,
  instance: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!declared || declared.length === 0) return {};

  const resolved: Record<string, unknown> = {};

  for (const param of declared) {
    // Instance value wins when the key is BOTH declared and present in the
    // instance map; otherwise fall back to the declared default. A declared
    // param with neither an instance value nor a default is simply absent.
    if (instance && Object.prototype.hasOwnProperty.call(instance, param.key)) {
      resolved[param.key] = instance[param.key];
    } else if (param.default !== undefined) {
      resolved[param.key] = param.default;
    }
  }

  return resolved;
}

// ADR-111: validate a per-instance config map against the declared schema.
// Pure + client-import-safe (no MaisterError, which is server-only): returns an
// error message string, or null when valid. The server caller (the aggregating
// PATCH via `updateAgentLink`) throws `MaisterError("CONFIG")` on a non-null
// result. Without this the instance map is `z.record(z.unknown())` at the wire
// and would land verbatim in the immutable `runs.agent_config` snapshot + the
// agent prompt — an out-of-range enum, a wrong-typed scalar, or an unknown key.
export function validateInstanceConfig(
  declared: AgentConfigParam[] | null,
  instance: Record<string, unknown>,
): string | null {
  const byKey = new Map((declared ?? []).map((p) => [p.key, p]));

  for (const [key, value] of Object.entries(instance)) {
    const param = byKey.get(key);

    if (!param) return `unknown config key: ${key}`;

    const ok =
      param.type === "boolean"
        ? typeof value === "boolean"
        : param.type === "number"
          ? typeof value === "number"
          : param.type === "string"
            ? typeof value === "string"
            : typeof value === "string" && (param.values ?? []).includes(value);

    if (!ok) {
      return param.type === "enum"
        ? `config value for "${key}" must be one of: ${(param.values ?? []).join(", ")}`
        : `config value for "${key}" must be a ${param.type}`;
    }
  }

  return null;
}
