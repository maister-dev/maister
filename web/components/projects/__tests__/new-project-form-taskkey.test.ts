import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// ADR-078 T5.5 — the registration form exposes the optional task key with an
// uppercase format hint; CONFLICT/CONFIG map through the existing ERROR_KEY.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { NewProjectForm } from "@/components/projects/new-project-form";

describe("NewProjectForm task key field", () => {
  it("renders the optional taskKey input with its label", () => {
    const html = renderToStaticMarkup(createElement(NewProjectForm));

    expect(html).toContain('id="np-task-key"');
    expect(html).toContain('name="taskKey"');
    expect(html).toContain("taskKeyLabel");
    expect(html).toContain("taskKeyPlaceholder");
  });
});
