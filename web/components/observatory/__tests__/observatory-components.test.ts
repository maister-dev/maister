import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AutonomyScoreCard } from "@/components/observatory/autonomy-score-card";
import { CorrectionHeatmap } from "@/components/observatory/correction-heatmap";
import { NodeDrilldownTable } from "@/components/observatory/node-drilldown-table";
import { ObservatoryFilters } from "@/components/observatory/observatory-filters";
import {
  labelsForTest,
  ObservatorySummary,
} from "@/components/observatory/observatory-summary";
import { SignalClusterList } from "@/components/observatory/signal-cluster-list";
import type { ObservatoryPortfolio } from "@/lib/queries/observatory";

const labels = labelsForTest();

function portfolio(): ObservatoryPortfolio {
  return {
    totals: {
      correction: {
        runCount: 2,
        reworkCount: 1,
        retryCount: 2,
        correctionRate: 1.5,
        displayKind: "pressure-ratio",
        volatile: false,
        runIds: ["run-1", "run-2"],
      },
      autonomy: {
        totalSeconds: 7200,
        waitSeconds: 1800,
        openWaitCount: 1,
        autonomyScore: 0.75,
        volatile: true,
        reviewDwellExcluded: true,
        runIds: ["run-1", "run-2"],
      },
    },
    projects: [],
    flows: [],
    nodes: [
      {
        nodeId: "checks",
        nodeType: "check",
        runCount: 2,
        reworkCount: 0,
        retryCount: 2,
        correctionRate: 1,
      },
    ],
    artifacts: [
      {
        artifactKey: "kind:log",
        artifactDefId: null,
        kind: "log",
        artifactCount: 2,
        runCount: 2,
      },
    ],
    topSignals: [
      {
        kind: "gate",
        key: "gate:flow:checks:unit:failed",
        title: "Repeated unit gate failed",
        scope: {
          projectIds: ["project-1"],
          flowIds: ["flow"],
          nodeIds: ["checks"],
        },
        occurrenceCount: 2,
        affectedRunCount: 2,
        affectedProjectCount: 1,
        priorityScore: 123,
        examples: ["access_token=[redacted] failed"],
        drillDown: { flowId: "flow", nodeId: "checks" },
        criticality: null,
        humanConfidence: null,
      },
    ],
  };
}

describe("Observatory components", () => {
  it("renders summary tiles, heatmap, signals, and artifacts", () => {
    const html = renderToStaticMarkup(
      createElement(ObservatorySummary, {
        data: portfolio(),
        labels,
        projectSlug: "alpha",
      }),
    );

    expect(html).toContain("Correction rate");
    expect(html).toContain("1.50");
    expect(html).toContain("checks");
    expect(html).toContain("Repeated unit gate failed");
    expect(html).toContain("kind:log");
  });

  it("renders autonomy volatile band", () => {
    const html = renderToStaticMarkup(
      createElement(AutonomyScoreCard, {
        autonomy: portfolio().totals.autonomy,
        labels,
      }),
    );

    expect(html).toContain("75%");
    expect(html).toContain("live");
    expect(html).toContain("open waits");
  });

  it("renders heatmap empty state without layout-only text overflow", () => {
    const html = renderToStaticMarkup(
      createElement(CorrectionHeatmap, {
        labels,
        nodes: [],
      }),
    );

    expect(html).toContain("No node attempts yet.");
  });

  it("renders filter controls as GET inputs", () => {
    const html = renderToStaticMarkup(
      createElement(ObservatoryFilters, {
        current: { flowId: "aif", nodeId: "checks", windowDays: 14 },
        labels,
      }),
    );

    expect(html).toContain('method="get"');
    expect(html).toContain('name="flowId"');
    expect(html).toContain('value="14"');
  });

  it("renders signal drill-down links for project scope", () => {
    const html = renderToStaticMarkup(
      createElement(SignalClusterList, {
        labels,
        projectSlug: "alpha",
        signals: portfolio().topSignals,
      }),
    );

    expect(html).toContain("/projects/alpha/observatory?nodeId=checks");
    expect(html).toContain("access_token=[redacted] failed");
  });

  it("renders node detail with run links", () => {
    const html = renderToStaticMarkup(
      createElement(NodeDrilldownTable, {
        labels,
        detail: {
          projectId: "project-1",
          nodeId: "checks",
          correction: portfolio().totals.correction,
          autonomy: portfolio().totals.autonomy,
          runs: [
            {
              runId: "run-1",
              flowId: "flow",
              startedAt: new Date("2026-06-05T10:00:00.000Z"),
              endedAt: null,
              volatile: true,
            },
          ],
          attempts: [
            {
              id: "attempt-1",
              runId: "run-1",
              attempt: 1,
              status: "Failed",
              errorCode: "TEST_FAIL",
              exitCode: 1,
            },
          ],
          gates: [
            {
              id: "gate-1",
              runId: "run-1",
              gateId: "unit",
              kind: "command_check",
              status: "failed",
            },
          ],
          hitlWaits: [],
          artifacts: [],
        },
      }),
    );

    expect(html).toContain("/runs/run-1");
    expect(html).toContain("#1 · Failed");
  });
});
