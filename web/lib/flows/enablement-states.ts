/**
 * The explicit allow-list of project-flow enablement states that may launch a
 * run (ADR-021).
 *
 * `Installed` is deliberately NOT launchable: a package installed from an
 * untrusted source stays `Installed` after `/trust` and must be explicitly
 * `/enable`d, so trust alone can never collapse the trust+enable lifecycle into
 * one launchable step. `Disabled` / `Failed` / `Deprecated` are likewise out.
 *
 * Declared once because every launch-gating site imports it — the shared
 * launchability gate (canonical launcher, board projection, delegation trust
 * resolver), the triage verdict, the task launch config, the launch-options
 * route, and the evaluation preflight. Private copies are how gates drift.
 */
export const LAUNCHABLE_FLOW_ENABLEMENT_STATES: ReadonlySet<string> =
  new Set<string>(["Enabled", "UpdateAvailable"]);
