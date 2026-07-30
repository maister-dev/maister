import "server-only";

import pino from "pino";

import { DEFAULT_ALLOW_PATTERNS } from "./context";

const log = pino({
  name: "flow-child-env",
  level: process.env.LOG_LEVEL ?? "info",
});

// Child-only plumbing beyond the template allow-list. Both are host paths, not
// secret values: TMPDIR keeps macOS children under /var/folders instead of the
// /tmp symlink; SSH_AUTH_SOCK lets git-over-SSH in a flow command authenticate
// through the agent socket without ever seeing key material.
const CHILD_ONLY_ALLOW_PATTERNS: RegExp[] = [/^TMPDIR$/, /^SSH_AUTH_SOCK$/];

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
