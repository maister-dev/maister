import type { SchedulerJobRow } from "@/components/admin/scheduler-jobs-table";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import {
  buildUpdateSchedulerJobMutationBody,
  SchedulerJobEditModal,
} from "@/components/admin/scheduler-job-edit-modal";

function job(over: Partial<SchedulerJobRow> = {}): SchedulerJobRow {
  return {
    id: "system_sweep.default",
    projectId: null,
    jobKind: "system_sweep",
    target: {},
    cadenceIntervalSeconds: 60,
    nextRunAt: "2026-06-05T10:00:00.000Z",
    lastFiredAt: null,
    disabledAt: null,
    consecutiveFailures: 0,
    maxFailures: 3,
    lastStatus: null,
    lastFinishedAt: null,
    lastErrorCode: null,
    ...over,
  };
}

describe("SchedulerJobEditModal", () => {
  it("offers only admin-creatable job kinds in the create kind select", () => {
    const markup = renderToStaticMarkup(
      createElement(SchedulerJobEditModal, {
        job: null,
        onClose: () => {},
        onSaved: () => {},
      }),
    );

    expect(markup).toContain("kind.system_sweep");
    expect(markup).toContain("kind.command");
    expect(markup).toContain("kind.flow_run");
    expect(markup).toContain("kind.webhook_delivery");
    expect(markup).not.toContain("kind.agent_tick");
    expect(markup).not.toContain("kind.run_schedule");
    expect(markup).not.toContain("kind.domain_event_dispatch");
  });

  it("does not render a raw target JSON textarea", () => {
    const markup = renderToStaticMarkup(
      createElement(SchedulerJobEditModal, {
        job: null,
        onClose: () => {},
        onSaved: () => {},
      }),
    );

    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("targetHint.system_sweep");
  });

  it("renders typed command target fields", () => {
    const markup = renderToStaticMarkup(
      createElement(SchedulerJobEditModal, {
        job: job({
          id: "ping-1",
          jobKind: "command",
          target: {
            commandKind: "http_ping",
            timeoutMs: 5000,
            url: "https://example.com/healthz",
          },
        }),
        onClose: () => {},
        onSaved: () => {},
      }),
    );

    expect(markup).toContain("target.commandKindLabel");
    expect(markup).toContain("target.urlLabel");
    expect(markup).toContain("target.timeoutMsLabel");
    expect(markup).not.toContain("<textarea");
  });

  it("renders typed flow-run target fields", () => {
    const markup = renderToStaticMarkup(
      createElement(SchedulerJobEditModal, {
        job: job({
          id: "flow-run-1",
          jobKind: "flow_run",
          target: {
            baseBranch: "main",
            runnerId: "codex-default",
            targetBranch: "feature/scheduler",
            taskId: "task-1",
          },
        }),
        onClose: () => {},
        onSaved: () => {},
      }),
    );

    expect(markup).toContain("target.taskIdLabel");
    expect(markup).toContain("target.runnerIdLabel");
    expect(markup).toContain("target.baseBranchLabel");
    expect(markup).toContain("target.targetBranchLabel");
    expect(markup).not.toContain("<textarea");
  });

  it("omits target from no-target job updates", () => {
    expect(
      buildUpdateSchedulerJobMutationBody({
        cadenceIntervalSeconds: 60,
        enabled: true,
        maxFailures: 3,
      }),
    ).toEqual({
      cadenceIntervalSeconds: 60,
      enabled: true,
      maxFailures: 3,
    });
  });
});
