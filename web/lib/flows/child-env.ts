import "server-only";

import pino from "pino";

import { DEFAULT_ALLOW_PATTERNS } from "./context";

const log = pino({
  name: "flow-child-env",
  level: process.env.LOG_LEVEL ?? "info",
});

// Host plumbing available to command processes, outside the template namespace.
const CHILD_ONLY_ALLOW_PATTERNS: RegExp[] = [
  /^TMPDIR$/,
  /^SSH_AUTH_SOCK$/,
  /^MAISTER_MAX_CONCURRENT_HEAVY_CHECKS$/,
  /^MAISTER_HEAVY_CHECK_DIR$/,
  /^MAISTER_BUILD_PROFILE$/,
  /^MAISTER_BUILD_MAX_WORKERS$/,
  /^MAISTER_TEST_MAX_WORKERS$/,
];

let warnedInherit = false;

function inheritEnvEnabled(): boolean {
  const raw = (process.env.MAISTER_CLI_INHERIT_ENV ?? "").trim().toLowerCase();

  return ["1", "true", "on", "yes"].includes(raw);
}

/**
 * ADR-153. Env for bash children spawned by the flow engine — cli/check node
 * commands, command_check gates (both via runCliStep), and requirement probes.
 * The web process env carries secrets (DB_URL, provider keys, auth secrets)
 * that a flow package's shell command must never see, so the child gets only
 * the SAME allow-list the {{ env.* }} template namespace exposes, plus
 * child-only plumbing vars and the caller's per-step vars (MAISTER_OUTPUT_FILE).
 *
 * MAISTER_CLI_INHERIT_ENV=1 (also true/on/yes) restores pre-ADR-153 full
 * inheritance as a compatibility escape hatch for not-yet-migrated packages.
 */
export function childProcessEnv(
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  if (inheritEnvEnabled()) {
    if (!warnedInherit) {
      warnedInherit = true;
      log.warn(
        "MAISTER_CLI_INHERIT_ENV is on — flow cli/check/probe children inherit the FULL web-tier env, including secrets (compat mode, ADR-153)",
      );
    }

    return { ...process.env, ...extra };
  }

  // NODE_ENV is required by Next's ProcessEnv augmentation and is non-secret
  // runtime-mode config a child may branch on — seed it explicitly.
  const out: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };

  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (
      DEFAULT_ALLOW_PATTERNS.some((p) => p.test(k)) ||
      CHILD_ONLY_ALLOW_PATTERNS.some((p) => p.test(k))
    ) {
      out[k] = v;
    }
  }

  return { ...out, ...extra };
}
