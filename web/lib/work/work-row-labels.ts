/**
 * The work-row label set, built once for both surfaces that render work rows:
 * `/work` and the Desk (ADR-172 D1).
 *
 * Pure — it takes already-resolved translator functions rather than reaching for
 * `getTranslations` itself, so it is callable from a server component without
 * becoming `server-only` and testable without a request context.
 */

import type { WorkRowsLabels } from "@/components/work/work-rows-table";
import type { WorkStageLabels } from "@/components/work/work-stage-chip";

type Translate = (key: string) => string;

/**
 * The whole `workStage` namespace, in one place.
 *
 * Four surfaces render a `WorkStageChip` and every one of them used to build
 * this map by hand, so ADR-174's five refinement keys were a compile error at
 * all four at once. That is the type doing its job — and the reason to build the
 * map once: the NEXT stage vocabulary change should be one line, not four.
 */
export function buildWorkStageLabels(tStage: Translate): WorkStageLabels {
  return {
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
    // ADR-174 `REQ-D8`: the refinement the removed run-status column carried.
    runNeedsInput: tStage("runNeedsInput"),
    runNeedsInputIdle: tStage("runNeedsInputIdle"),
    runHumanWorking: tStage("runHumanWorking"),
    runRunning: tStage("runRunning"),
    runWaitingOnChildren: tStage("runWaitingOnChildren"),
  };
}

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
    stage: buildWorkStageLabels(tStage),
    openTask: t("openTask"),
    openRun: t("openRun"),
  };
}
