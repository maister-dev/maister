import "server-only";

import pino from "pino";

import { DEFAULT_ALLOW_PATTERNS } from "./context";

const log = pino({
  name: "flow-child-env",
  level: process.env.LOG_LEVEL ?? "info",
});

/**
 * ADR-153. Env for bash children spawned by the flow engine — cli/check node
 * commands, command_check gates (both via runCliStep), and requirement probes.
 * The web process env carries secrets (DB_URL, provider keys, auth secrets)
 * that a flow package's shell command must never see, so the child gets only
 * the SAME allow-list the {{ env.* }} template namespace exposes, plus
 * TMPDIR and the caller's per-step vars (MAISTER_OUTPUT_FILE).
 */
export function childProcessEnv(
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  // NODE_ENV is required by Next's ProcessEnv augmentation and is non-secret
  // runtime-mode config a child may branch on — seed it explicitly.
  const out: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };

  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "TMPDIR" || DEFAULT_ALLOW_PATTERNS.some((p) => p.test(k))) {
      out[k] = v;
    }
  }

  const environment = { ...out, ...extra };

  log.debug(
    { variableCount: Object.keys(environment).length },
    "constructed flow child environment from allow-listed variables",
  );

  return environment;
}
