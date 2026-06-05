import type { getTranslations } from "next-intl/server";

import type { ObservatoryLabels } from "@/components/observatory/types";

export function labelsFromTranslations(
  t: Awaited<ReturnType<typeof getTranslations>>,
): ObservatoryLabels {
  return {
    title: t("title"),
    subtitle: t("subtitle"),
    projectTitle: t("projectTitle"),
    correctionRate: t("correctionRate"),
    correctionFormula: t("correctionFormula"),
    rework: t("rework"),
    retries: t("retries"),
    runs: t("runs"),
    autonomyScore: t("autonomyScore"),
    waitTime: t("waitTime"),
    openWaits: t("openWaits"),
    volatile: t("volatile"),
    reviewDwellExcluded: t("reviewDwellExcluded"),
    nodes: t("nodes"),
    noNodes: t("noNodes"),
    artifacts: t("artifacts"),
    noArtifacts: t("noArtifacts"),
    signals: t("signals"),
    noSignals: t("noSignals"),
    observationsOnly: t("observationsOnly"),
    filters: t("filters"),
    flow: t("flow"),
    node: t("node"),
    lookback: t("lookback"),
    apply: t("apply"),
    all: t("all"),
    days: t("days"),
    drillDown: t("drillDown"),
    latestAttempt: t("latestAttempt"),
    historicalAttempts: t("historicalAttempts"),
    gates: t("gates"),
    hitlWaits: t("hitlWaits"),
    kind: {
      gate: t("kind.gate"),
      retry: t("kind.retry"),
      rework: t("kind.rework"),
    },
  };
}
