import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// T7 (ADR-093): the Add-project form gains an optional "Project name" field that
// prefills from the Git URL (and seeds the task-key preview). The *dynamic*
// prefill (onChange-driven) is covered by the project-onboarding e2e, since
// renderToStaticMarkup renders only the initial state and cannot drive onChange.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { NewProjectForm } from "@/components/projects/new-project-form";

describe("NewProjectForm project-name field", () => {
  it("renders the optional project-name input with its label", () => {
    const html = renderToStaticMarkup(createElement(NewProjectForm));

    expect(html).toContain('id="np-name"');
    expect(html).toContain('name="name"');
    expect(html).toContain("nameLabel");
    expect(html).toContain("namePlaceholder");
  });

  it("still renders the URL and task-key fields (regression)", () => {
    const html = renderToStaticMarkup(createElement(NewProjectForm));

    expect(html).toContain('id="np-url"');
    expect(html).toContain('id="np-task-key"');
  });
});
