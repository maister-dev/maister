import type { ObservatoryPortfolio } from "@/lib/queries/observatory";
import type {
  CorrectionMetric,
  GateFiringStat,
  ObservatoryHarness,
} from "@/lib/queries/observatory-core";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { labelsForTest } from "./labels.fixture";

import ru from "@/messages/ru.json";
import { AutonomyScoreCard } from "@/components/observatory/autonomy-score-card";
import { ControlEffectivenessCard } from "@/components/observatory/control-effectiveness-card";
import { CorrectionHeatmap } from "@/components/observatory/correction-heatmap";
import { CoverageMapCard } from "@/components/observatory/coverage-map-card";
import { NodeDrilldownTable } from "@/components/observatory/node-drilldown-table";
import { ObservatoryFilters } from "@/components/observatory/observatory-filters";
import { ObservatorySummary } from "@/components/observatory/observatory-summary";
import { SensorFiringCard } from "@/components/observatory/sensor-firing-card";
import { SignalClusterList } from "@/components/observatory/signal-cluster-list";

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
        flowId: "flow",
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
    harness: {
      firing: { groups: [], byKind: [] },
      neverFired: [],
      effectiveness: { gates: [], capabilities: [] },
      coverage: [],
    },
  };
}

function firingGroup(over: Partial<GateFiringStat> = {}): GateFiringStat {
  return {
    projectId: "project-1",
    flowId: "flow-1",
    flowRefId: "aif",
    nodeId: "checks",
    gateId: "unit",
    kind: "command_check",
    mode: "blocking",
    executions: 4,
    passed: 3,
    failed: 1,
    stale: 0,
    skipped: 0,
    overridden: 0,
    failRate: 0.25,
    ...over,
  };
}

function correction(over: Partial<CorrectionMetric> = {}): CorrectionMetric {
  return {
    runCount: 4,
    reworkCount: 2,
    retryCount: 3,
    correctionRate: 1.25,
    displayKind: "pressure-ratio",
    volatile: false,
    runIds: ["run-1", "run-2", "run-3", "run-4"],
    ...over,
  };
}

function harness(): ObservatoryHarness {
  return {
    firing: {
      groups: [
        firingGroup(),
        firingGroup({
          gateId: "lint",
          executions: 10,
          passed: 10,
          failed: 0,
          failRate: 0,
        }),
        firingGroup({
          gateId: "smoke",
          nodeId: "deploy",
          executions: 2,
          passed: 2,
          failed: 0,
          failRate: 0,
        }),
      ],
      byKind: [
        {
          kind: "command_check",
          executions: 16,
          passed: 15,
          failed: 1,
          stale: 0,
          skipped: 0,
          overridden: 0,
          failRate: 1 / 16,
        },
      ],
    },
    neverFired: [
      {
        flowId: "flow-1",
        flowRefId: "aif",
        nodeId: "checks",
        gateId: "lint",
        kind: "command_check",
        executions: 10,
      },
    ],
    effectiveness: {
      gates: [
        {
          flowId: "flow-1",
          flowRefId: "aif",
          nodeId: "checks",
          gateId: "unit",
          kind: "command_check",
          failedAttempts: 3,
          failedFollowedByRework: 3,
          passedAttempts: 4,
          passedFollowedByRework: 2,
          reworkRateAfterFail: 1,
          reworkRateAfterPass: 0.5,
          lift: 2,
        },
        {
          flowId: "flow-1",
          flowRefId: "aif",
          nodeId: "deploy",
          gateId: "smoke",
          kind: "external_check",
          failedAttempts: 1,
          failedFollowedByRework: 1,
          passedAttempts: 2,
          passedFollowedByRework: 0,
          reworkRateAfterFail: 1,
          reworkRateAfterPass: 0,
          lift: null,
        },
      ],
      capabilities: [
        {
          refId: "strict-rule",
          capabilityKind: "rule",
          withCapability: correction(),
          withoutCapability: correction({
            runCount: 2,
            reworkCount: 0,
            retryCount: 0,
            correctionRate: 0,
            runIds: ["run-5", "run-6"],
          }),
        },
      ],
    },
    coverage: [
      {
        flowId: "flow-1",
        flowRefId: "aif",
        revisionCount: 2,
        nodes: [
          {
            nodeId: "checks",
            gateCount: 2,
            blockingGateCount: 2,
            advisoryGateCount: 0,
            guideCount: 0,
            guidesWithoutSensors: false,
            executions: 14,
          },
          {
            nodeId: "implement",
            gateCount: 0,
            blockingGateCount: 0,
            advisoryGateCount: 0,
            guideCount: 2,
            guidesWithoutSensors: true,
            executions: 0,
          },
        ],
      },
    ],
  };
}

describe("Observatory harness cards", () => {
  it("renders firing stats with denominators, honest-N dashes, and node links", () => {
    const data = harness();
    const html = renderToStaticMarkup(
      createElement(SensorFiringCard, {
        firing: data.firing,
        labels,
        neverFired: data.neverFired,
        projectSlug: "alpha",
      }),
    );

    expect(html).toContain("Sensor firing");
    expect(html).toContain("lint");
    expect(html).toContain("25% (n=4)");
    expect(html).toContain("0% (n=10)");
    // executions below MIN_GROUP_EXECUTIONS render an em-dash, never 0%
    expect(html).toContain("— (n=2)");
    expect(html).toContain("never fired");
    expect(html).toContain(
      "/projects/alpha/observatory?flowId=flow-1&amp;nodeId=checks",
    );
    expect(html).toContain("command_check");
  });

  it("hides the never-fired badge when no gate is flagged", () => {
    const data = harness();
    const html = renderToStaticMarkup(
      createElement(SensorFiringCard, {
        firing: data.firing,
        labels,
        neverFired: [],
      }),
    );

    expect(html).not.toContain("never fired");
  });

  it("renders the firing empty state", () => {
    const html = renderToStaticMarkup(
      createElement(SensorFiringCard, {
        firing: { groups: [], byKind: [] },
        labels,
        neverFired: [],
      }),
    );

    expect(html).toContain("No gate executions in this window.");
  });

  it("renders control effectiveness with lift and honest-N dashes", () => {
    const data = harness();
    const html = renderToStaticMarkup(
      createElement(ControlEffectivenessCard, {
        effectiveness: data.effectiveness,
        labels,
      }),
    );

    expect(html).toContain("Control effectiveness");
    expect(html).toContain("100% (n=3)");
    expect(html).toContain("50% (n=4)");
    expect(html).toContain("2.00×");
    // smoke gate has n=1 failed / n=2 passed -> dashes, no lift
    expect(html).toContain("— (n=1)");
    expect(html).toContain("— (n=2)");
    expect(html).toContain("strict-rule");
    expect(html).toContain("1.25 (n=4)");
  });

  it("renders coverage map with mode counts and the guides-without-sensors flag", () => {
    const data = harness();
    const html = renderToStaticMarkup(
      createElement(CoverageMapCard, { coverage: data.coverage, labels }),
    );

    expect(html).toContain("Coverage map");
    expect(html).toContain("aif");
    expect(html).toContain("implement");
    expect(html).toContain("guides without sensors");
  });

  it("resolves RU labels for the harness cards", () => {
    const ruLabels = labelsForTest(ru.observatory as Record<string, unknown>);
    const data = harness();
    const html = renderToStaticMarkup(
      createElement(SensorFiringCard, {
        firing: data.firing,
        labels: ruLabels,
        neverFired: data.neverFired,
      }),
    );

    expect(html).toContain("Срабатывание сенсоров");
    expect(html).toContain("не срабатывал");
  });
});

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

    expect(html).toContain("No node attempts in this window.");
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
    expect(html).toContain('name="artifactKind"');
    expect(html).toContain('name="artifactDefId"');
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

    expect(html).toContain(
      "/projects/alpha/observatory?flowId=flow&amp;nodeId=checks",
    );
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
          signals: portfolio().topSignals,
        },
      }),
    );

    expect(html).toContain("/runs/run-1");
    expect(html).toContain("#1 · Failed");
    expect(html).toContain("access_token=[redacted] failed");
  });
});
