import type { FlowYamlV1 } from "@/lib/config.schema";

import { FINDINGS_CONTRACT } from "@/lib/run-results/findings-contract";

/**
 * The explicit allow-list of project-flow enablement states that may launch a
 * run (ADR-021).
 *
 * `Installed` is deliberately NOT launchable. Native evidence workflows stay
 * `Installed` after install or trust and need an explicit enable action. Legacy
 * package auto-enable behavior remains at its existing lifecycle boundary.
 * `Disabled` / `Failed` / `Deprecated` are likewise out.
 *
 * Declared once because every launch-gating site imports it — the shared
 * launchability gate (canonical launcher, board projection, delegation trust
 * resolver), the triage verdict, the task launch config, the launch-options
 * route, and the evaluation preflight. Private copies are how gates drift.
 */
export const LAUNCHABLE_FLOW_ENABLEMENT_STATES: ReadonlySet<string> =
  new Set<string>(["Enabled", "UpdateAvailable"]);
/** Native source-bearing workflows require a separate explicit enable action. */
export function requiresExplicitNativeFindingsEnablement(
  manifest: Pick<FlowYamlV1, "result">,
): boolean {
  return manifest.result?.export?.native_contract === FINDINGS_CONTRACT;
}
