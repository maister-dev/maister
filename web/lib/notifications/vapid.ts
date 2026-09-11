/**
 * VAPID configuration for web push (ADR-172 D11, `NTF-10`).
 *
 * NOT `server-only`: nothing here is a secret by itself, and the opt-in UI needs
 * the PUBLIC key to call `pushManager.subscribe`. The private key is read only
 * by `resolveVapidConfig`, which the sender calls server-side.
 *
 * Resolution is a FUNCTION returning a discriminated result, never a
 * module-scope throw and never a top-level `setVapidDetails`. Web push is an
 * optional capability of a self-hosted deployment: with the variables unset the
 * app must boot, report "push unavailable", and keep every other surface
 * working. An import-time throw is exactly how that promise gets broken.
 */

export const VAPID_ENV_VARS = [
  "MAISTER_VAPID_PUBLIC_KEY",
  "MAISTER_VAPID_PRIVATE_KEY",
  "MAISTER_VAPID_SUBJECT",
] as const;

export type VapidEnvVar = (typeof VAPID_ENV_VARS)[number];

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** A `mailto:` or `https:` contact the push service can reach. */
  subject: string;
}

export type VapidResolution =
  | { ok: true; config: VapidConfig }
  /** Every missing variable, not just the first — an operator fixes them once. */
  | { ok: false; missing: VapidEnvVar[] };

function present(name: VapidEnvVar): string | null {
  const raw = process.env[name];
  const trimmed = raw?.trim();

  // A blank value is unset, not configuration: an empty `environment:` entry or
  // a `VAR=` line in an env file is the commonest way this goes half-done.
  return trimmed ? trimmed : null;
}

export function resolveVapidConfig(): VapidResolution {
  const values = VAPID_ENV_VARS.map(present);
  const missing = VAPID_ENV_VARS.filter((_, i) => values[i] === null);

  if (missing.length > 0) return { ok: false, missing: [...missing] };

  const [publicKey, privateKey, subject] = values as [string, string, string];

  return { ok: true, config: { publicKey, privateKey, subject } };
}

export function isPushConfigured(): boolean {
  return resolveVapidConfig().ok;
}

/**
 * The only VAPID material that may cross to a browser. The private key is never
 * returned from this module by any other export.
 */
export function publicVapidKey(): string | null {
  const resolved = resolveVapidConfig();

  return resolved.ok ? resolved.config.publicKey : null;
}

/** The single log line `NTF-10` asks for, so "push unavailable" is diagnosable. */
export function pushUnavailableReason(): string | null {
  const resolved = resolveVapidConfig();

  return resolved.ok
    ? null
    : `push unavailable — unset: ${resolved.missing.join(", ")}`;
}
