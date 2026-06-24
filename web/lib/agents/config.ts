// ADR-110: resolve the effective agent config — a 2-level merge of the
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
