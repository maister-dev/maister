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

import {
  CloneErrorBlock,
  NewProjectForm,
} from "@/components/projects/new-project-form";

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

    // Default mode is "clone" → the URL field is shown.
    expect(html).toContain('id="np-url"');
    expect(html).toContain('id="np-task-key"');
  });

  it("renders the onboarding mode selector (clone/existing/new)", () => {
    const html = renderToStaticMarkup(createElement(NewProjectForm));

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("modeClone");
    expect(html).toContain("modeExisting");
    expect(html).toContain("modeNew");
  });
});

// ADR-093: reason-aware clone-failure remediation. The mocked next-intl returns
// the key verbatim, so we assert the remediation/help keys + the raw detail.
describe("CloneErrorBlock", () => {
  it("renders the reason-specific remediation + collapsible git output", () => {
    const html = renderToStaticMarkup(
      createElement(CloneErrorBlock, {
        errorCode: "PRECONDITION",
        cloneReason: "SSH_AUTH",
        cloneDetail: "Permission denied (publickey).",
        repoUrl: "git@gitverse.ru:kaa/x.git",
      }),
    );

    expect(html).toContain("errorSshAuth");
    expect(html).toContain("errorCloneDetail");
    expect(html).toContain("Permission denied (publickey).");
  });

  it("shows the gh hint only for a github.com HTTPS_AUTH failure", () => {
    const gh = renderToStaticMarkup(
      createElement(CloneErrorBlock, {
        errorCode: "PRECONDITION",
        cloneReason: "HTTPS_AUTH",
        cloneDetail: undefined,
        repoUrl: "https://github.com/org/x.git",
      }),
    );

    expect(gh).toContain("ghLoginHint");

    const nongh = renderToStaticMarkup(
      createElement(CloneErrorBlock, {
        errorCode: "PRECONDITION",
        cloneReason: "HTTPS_AUTH",
        cloneDetail: undefined,
        repoUrl: "https://gitverse.ru/org/x.git",
      }),
    );

    expect(nongh).not.toContain("ghLoginHint");
  });

  it("falls back to the generic code message for non-clone errors", () => {
    const html = renderToStaticMarkup(
      createElement(CloneErrorBlock, {
        errorCode: "CONFLICT",
        cloneReason: undefined,
        cloneDetail: undefined,
        repoUrl: "",
      }),
    );

    expect(html).toContain("errorConflict");
  });

  it("renders nothing when there is no error", () => {
    const html = renderToStaticMarkup(
      createElement(CloneErrorBlock, {
        errorCode: undefined,
        cloneReason: undefined,
        cloneDetail: undefined,
        repoUrl: "",
      }),
    );

    expect(html).toBe("");
  });
});
