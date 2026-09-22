import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors";
import {
  DEFAULT_PUBLIC_BRANCH_TEMPLATE,
  attemptFromBranch,
  renderPublicBranchName,
  slugifyTitle,
  transliterate,
  validatePublicBranchTemplate,
} from "@/lib/workbench-git/public-branch-name";

// ADR-181 D4 — the public name a run branch is published under. The internal
// branch stays the identity; only the remote-side name is rendered here.

const RUN_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function refusal(fn: () => unknown): MaisterError {
  try {
    fn();
  } catch (err) {
    if (err instanceof MaisterError) return err;
    throw err;
  }
  throw new Error("expected a MaisterError");
}

describe("transliterate", () => {
  it("maps the fixed Cyrillic table, both cases, and drops other non-ASCII", () => {
    expect(transliterate("щука ёж Щит Ёлка")).toBe("shchuka yozh Shchit Yolka");
    expect(transliterate("хлеб цирк чай шум")).toBe("khleb tsirk chay shum");
    expect(transliterate("юла яма объём быль")).toBe("yula yama obyom byl");
    expect(transliterate("Жук ЭХО йод")).toBe("Zhuk EKhO yod");
    expect(transliterate("café naïve ✓ 日本")).toBe("caf nave  ");
  });
});

describe("slugifyTitle", () => {
  it("lower-cases, collapses non [a-z0-9] runs to '-', trims", () => {
    expect(slugifyTitle("Fix  the Login — redirect!")).toBe(
      "fix-the-login-redirect",
    );
    expect(slugifyTitle("Починить вход (SSO)")).toBe("pochinit-vkhod-sso");
  });

  it("caps at 40 characters and never ends on a separator", () => {
    const slug = slugifyTitle(
      "an extremely long task title that keeps going past the forty character cap",
    );

    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toBe("an-extremely-long-task-title-that-keeps");
    expect(slug.endsWith("-")).toBe(false);
  });

  it("is empty when nothing survives", () => {
    expect(slugifyTitle("✓✓✓ 日本")).toBe("");
    expect(slugifyTitle(null)).toBe("");
  });
});

describe("attemptFromBranch", () => {
  it("reads a flow branch's attempt-N suffix and defaults to 1", () => {
    expect(attemptFromBranch("maister/task-3f2a/attempt-3")).toBe(3);
    expect(attemptFromBranch("maister/agent-abc-1a2b3c4d")).toBe(1);
    expect(attemptFromBranch("maister/scratch-1a2b3c4d")).toBe(1);
  });
});

describe("renderPublicBranchName", () => {
  it("renders the default template from the task key and the slugged title", () => {
    expect(DEFAULT_PUBLIC_BRANCH_TEMPLATE).toBe("feature/{task_key}-{slug}");
    expect(
      renderPublicBranchName(DEFAULT_PUBLIC_BRANCH_TEMPLATE, {
        taskKey: "ABC-12",
        title: "Fix login redirect",
        attempt: 2,
        runId: RUN_ID,
      }),
    ).toBe("feature/ABC-12-fix-login-redirect");
  });

  it("falls back to run-<8hex> for a task-less run", () => {
    expect(
      renderPublicBranchName(DEFAULT_PUBLIC_BRANCH_TEMPLATE, {
        taskKey: null,
        title: null,
        attempt: 1,
        runId: RUN_ID,
      }),
    ).toBe("feature/run-7c9e6679");
  });

  it("collapses the separator an empty slug leaves behind, on either side", () => {
    const vars = { taskKey: "ABC-12", title: "✓", attempt: 1, runId: RUN_ID };

    expect(renderPublicBranchName("feature/{task_key}-{slug}", vars)).toBe(
      "feature/ABC-12",
    );
    expect(renderPublicBranchName("feature/{slug}-{task_key}", vars)).toBe(
      "feature/ABC-12",
    );
    expect(renderPublicBranchName("{slug}/{task_key}", vars)).toBe("ABC-12");
  });

  it("renders {attempt}", () => {
    expect(
      renderPublicBranchName("fix/{task_key}-a{attempt}", {
        taskKey: "ABC-12",
        title: "x",
        attempt: 3,
        runId: RUN_ID,
      }),
    ).toBe("fix/ABC-12-a3");
  });

  it("refuses a render that is not a valid branch name with CONFIG", () => {
    const err = refusal(() =>
      renderPublicBranchName("{slug}", {
        taskKey: "ABC-12",
        title: "✓",
        attempt: 1,
        runId: RUN_ID,
      }),
    );

    expect(err.code).toBe("CONFIG");
    expect(err.details?.reason).toBe("public_branch_template_invalid");
  });
});

describe("validatePublicBranchTemplate", () => {
  it.each(["feature/{task_key}-{slug}", "{task_key}", "wip/{slug}-{attempt}"])(
    "accepts %s",
    (template) => {
      expect(() => validatePublicBranchTemplate(template)).not.toThrow();
    },
  );

  it.each([
    ["no placeholder", "feature/static"],
    ["an unknown placeholder", "feature/{task}-{slug}"],
    ["an unclosed brace", "feature/{task_key"],
    ["a leading dash", "-{task_key}"],
    ["a dot-dot", "a..b/{task_key}"],
    ["a trailing slash", "{task_key}/"],
    ["an empty template", ""],
  ])("refuses %s with CONFIG public_branch_template_invalid", (_label, t) => {
    const err = refusal(() => validatePublicBranchTemplate(t));

    expect(err.code).toBe("CONFIG");
    expect(err.details?.reason).toBe("public_branch_template_invalid");
  });
});
