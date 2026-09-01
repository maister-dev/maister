/**
 * The explicit allow-list of project-flow enablement states that may launch a
 * run (ADR-021).
 *
 * `Installed` is deliberately NOT launchable: a package installed from an
 * untrusted source stays `Installed` after `/trust` and must be explicitly
 * `/enable`d, so trust alone can never collapse the trust+enable lifecycle into
 * one launchable step. `Disabled` / `Failed` / `Deprecated` are likewise out.
 *
 * Declared once here because three call sites gate on it — the canonical flow
 * launcher, the project-flow launchability projection, and the delegation trust
 * resolver (ADR-163). Three private copies is how those gates drift apart.
 */
export const LAUNCHABLE_FLOW_ENABLEMENT_STATES: ReadonlySet<string> =
  new Set<string>(["Enabled", "UpdateAvailable"]);
