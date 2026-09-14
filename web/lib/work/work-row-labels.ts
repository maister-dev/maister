/**
 * The work-row label set, built once for both surfaces that render work rows:
 * `/work` and the Desk (ADR-172 D1).
 *
 * Pure — it takes already-resolved translator functions rather than reaching for
 * `getTranslations` itself, so it is callable from a server component without
 * becoming `server-only` and testable without a request context.
 */

import type { WorkRowsLabels } from "@/components/work/work-rows-table";

type Translate = (key: string) => string;

export function buildWorkRowsLabels(
  t: Translate,
  tStage: Translate,
): WorkRowsLabels {
  return {
    columns: {
      key: t("columns.key"),
      title: t("columns.title"),
      project: t("columns.project"),
      stage: t("columns.stage"),
      run: t("columns.run"),
      readiness: t("columns.readiness"),
      waitingOn: t("columns.waitingOn"),
      blockers: t("columns.blockers"),
      tokens: t("columns.tokens"),
      lastActivity: t("columns.lastActivity"),
      nextAction: t("columns.nextAction"),
    },
    group: {
      none: t("group.none"),
      project: t("group.project"),
      stage: t("group.stage"),
      mine: t("group.mine"),
      mineHeading: t("group.mineHeading"),
      othersHeading: t("group.othersHeading"),
    },
    waitingOn: {
      you: t("waitingOn.you"),
      anyone: t("waitingOn.anyone"),
      since: t("waitingOn.since"),
    },
    readiness: {
      ready: t("readiness.ready"),
      blocked: t("readiness.blocked"),
      stale: t("readiness.stale"),
      failed: t("readiness.failed"),
      waiting: t("readiness.waiting"),
      overridden: t("readiness.overridden"),
    },
    nextAction: {
      triage: t("nextAction.triage"),
      release: t("nextAction.release"),
      launch: t("nextAction.launch"),
      respond: t("nextAction.respond"),
      review: t("nextAction.review"),
      recover: t("nextAction.recover"),
      watch: t("nextAction.watch"),
      none: t("nextAction.none"),
    },
    stage: {
      Triage: tStage("Triage"),
      Held: tStage("Held"),
      Ready: tStage("Ready"),
      Queued: tStage("Queued"),
      Executing: tStage("Executing"),
      WaitingOnHuman: tStage("WaitingOnHuman"),
      Review: tStage("Review"),
      Crashed: tStage("Crashed"),
      Promoted: tStage("Promoted"),
      Abandoned: tStage("Abandoned"),
      blocked: tStage("blocked"),
      promotedResult: tStage("promotedResult"),
    },
    openTask: t("openTask"),
    openRun: t("openRun"),
  };
}
