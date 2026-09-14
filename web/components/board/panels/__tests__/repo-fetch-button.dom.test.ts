// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RepoFetchButton } from "@/components/board/panels/repo-fetch-button";
import { RepoFilesPanel } from "@/components/board/panels/repo-files-panel";
import en from "@/messages/en.json";

const { refresh, success, error, localBranchHead } = vi.hoisted(() => ({
  refresh: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  localBranchHead: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => "/projects/course",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/authz", () => ({ requireProjectAction: vi.fn() }));
vi.mock("@/lib/worktree", () => ({ localBranchHead }));
vi.mock("@/components/feedback/feedback-provider", () => ({
  useFeedback: () => ({ success, error }),
}));
vi.mock("next-intl", () => ({
  useTranslations:
    (namespace: string) => (key: string, values?: Record<string, string>) => {
      const catalog: Record<string, string> =
        namespace === "workbench.files" ? en.workbench.files : en.apiErrors;
      const message = catalog[key];

      if (!message) throw new Error(`missing translation: ${namespace}.${key}`);

      return message.replace("{branch}", values?.branch ?? "");
    },
}));

let root: Root;
let container: HTMLDivElement;
const copy = en.workbench.files;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      createElement(RepoFetchButton, {
        slug: "course",
        branch: "main",
        label: copy.fetchOrigin,
        pendingLabel: copy.fetching,
        failedLabel: copy.fetchFailed,
      }),
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function click(): Promise<void> {
  const button = container.querySelector("button");

  if (!button) throw new Error("pull button missing");
  await act(async () => button.click());
}

describe("repository update feedback", () => {
  it("reloads the file tree when a refresh moves the same branch to a new commit", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      Response.json({
        entries: [
          {
            name: url.includes("ref=aaaa") ? "old.md" : "new.md",
            type: "file",
          },
        ],
      }),
    );

    vi.stubGlobal("fetch", fetchMock);
    const renderPanel = async (revision: string): Promise<void> => {
      localBranchHead.mockResolvedValue(revision);
      const panel = await RepoFilesPanel({
        slug: "course",
        projectId: "project-1",
        repoPath: "/repos/course",
        mainBranch: "main",
        currentRef: "main",
        branches: [],
        file: null,
        canFetch: false,
        canReadRepoFiles: true,
        labels: copy,
      });

      await act(async () => root.render(panel));
    };

    await renderPanel("a".repeat(40));
    expect(container.textContent).toContain("old.md");
    await renderPanel("b".repeat(40));
    expect(container.textContent).toContain("new.md");
    expect(container.textContent).not.toContain("old.md");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("pulls the selected branch and refreshes only after confirmed success", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));

    vi.stubGlobal("fetch", fetchMock);
    await click();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/course/remotes",
      expect.objectContaining({
        body: JSON.stringify({ op: "pull", name: "origin", branch: "main" }),
      }),
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(success).toHaveBeenCalledWith(
      expect.objectContaining({ message: copy.pullComplete }),
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    [409, { code: "CONFLICT" }, copy.pullConflict],
    [
      409,
      { code: "PRECONDITION", details: { reason: "dirty_worktree" } },
      copy.pullDirty,
    ],
    [
      409,
      { code: "PRECONDITION", details: { reason: "branch_mismatch" } },
      copy.pullBranchMismatch.replace("{branch}", "main"),
    ],
    [503, { code: "EXECUTOR_UNAVAILABLE" }, copy.pullUnavailable],
    [403, { code: "UNAUTHORIZED" }, en.apiErrors.UNAUTHORIZED],
  ])("shows a localized error for HTTP %i", async (status, body, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { ...body, message: "raw server diagnostic" },
          { status },
        ),
      ),
    );
    await click();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      message,
    );
    expect(container.textContent).not.toContain("raw server diagnostic");
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message }));
    expect(success).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows transport failure and allows retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    await click();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      copy.fetchFailed,
    );
    expect(container.querySelector("button")?.disabled).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([null, { ok: true, warning: "fetch failed" }])(
    "rejects an invalid success body: %j",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body)),
      );
      await click();

      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        copy.fetchFailed,
      );
      expect(success).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    },
  );
});
