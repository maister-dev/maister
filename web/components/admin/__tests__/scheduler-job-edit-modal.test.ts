import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { SchedulerJobEditModal } from "@/components/admin/scheduler-job-edit-modal";

describe("SchedulerJobEditModal", () => {
  it("does not offer run_schedule in the create kind select", () => {
    const markup = renderToStaticMarkup(
      createElement(SchedulerJobEditModal, {
        job: null,
        onClose: () => {},
        onSaved: () => {},
      }),
    );

    expect(markup).toContain("kind.system_sweep");
    expect(markup).toContain("kind.command");
    expect(markup).toContain("kind.agent_tick");
    expect(markup).toContain("kind.flow_run");
    expect(markup).not.toContain("kind.run_schedule");
  });
});
