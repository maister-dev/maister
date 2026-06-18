// T4.5 / ADR-066 T1.6: render tests for the RepoFilesPanel server-side gate +
// the `?file=` blob pane. Uses renderToStaticMarkup (no jsdom).
//
// RepoFilesPanel is now an ASYNC Server Component (it does the gated blob read
// for the project repo `?file=` pane, mirroring the run-detail workbench): it
// awaits requireProjectAction(projectId,"readRepoFiles") BEFORE readBlob, and
// validates the path with repoRelPathSchema BEFORE readBlob. We render it as
// `renderToStaticMarkup(await RepoFilesPanel(props))` and mock the authz / git
// boundary. The mounted `FileTree` is a "use client" container whose lazy fetch
// lives in an effect — effects DO NOT run under renderToStaticMarkup, so only
// its root mount markup (data-testid="file-tree") appears.
//
// Contract:
//   canReadRepoFiles === false -> data-testid="repo-files-forbidden" (early,
//                                 BEFORE any auth/read) + NO data-testid="file-tree".
//   canReadRepoFiles === true, file === null
//                              -> <FileTree> mount (data-testid="file-tree") +
//                                 the no-selection prompt pane
//                                 (data-testid="file-select-prompt").
//   canReadRepoFiles === true, file = "<bad>"
//                              -> the not-found pane (data-testid="file-not-found");
//                                 readBlob is NOT reached.

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RepoFilesPanel } from "@/components/board/panels/repo-files-panel";
import { requireProjectAction } from "@/lib/authz";
import { readBlob } from "@/lib/worktree";

const labels = {
  forbidden: "You do not have access to repository files",
  title: "Repo files",
  empty: "No files",
  selectPrompt: "Select a file to view it",
  branchLabel: "Branch",
  tooLarge: "File is too large to display",
  binary: "Binary file — not shown",
  notFound: "File not found",
  loadError: "Could not load file",
  treeLabel: "Repository file tree",
};

// FileTree ("use client") reads next/navigation router hooks at render; under
// renderToStaticMarkup there is no mounted app router, so stub the three hooks.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/projects/acme",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/authz", () => ({
  requireProjectAction: vi.fn(async () => ({ role: "member" })),
}));

// Keep the REAL repoRelPathSchema (so a `../` path is rejected BEFORE readBlob);
// stub only the git blob reader.
vi.mock("@/lib/worktree", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/worktree")>("@/lib/worktree");

  return {
    repoRelPathSchema: actual.repoRelPathSchema,
    readBlob: vi.fn(),
  };
});

vi.mock("@/lib/instance-config", () => ({
  workbenchMaxFileBytes: vi.fn(() => 524288),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireProjectAction).mockResolvedValue({
    role: "member",
  } as unknown as Awaited<ReturnType<typeof requireProjectAction>>);
});

async function render(args: {
  canReadRepoFiles: boolean;
  file: string | null;
  currentRef?: string;
}): Promise<string> {
  const el = await RepoFilesPanel({
    slug: "acme",
    projectId: "project-1",
    repoPath: "/repos/acme",
    mainBranch: "main",
    currentRef: args.currentRef ?? "main",
    branches: ["main"],
    file: args.file,
    canReadRepoFiles: args.canReadRepoFiles,
    labels,
  });

  return renderToStaticMarkup(el);
}

describe("RepoFilesPanel — viewer gate (canReadRepoFiles=false)", () => {
  it("renders the forbidden marker and no file-tree, BEFORE any auth/read", async () => {
    const html = await render({ canReadRepoFiles: false, file: null });

    expect(html).toContain('data-testid="repo-files-forbidden"');
    expect(html).toContain(labels.forbidden);
    expect(html).not.toContain('data-testid="file-tree"');
    expect(requireProjectAction).not.toHaveBeenCalled();
    expect(readBlob).not.toHaveBeenCalled();
  });
});

describe("RepoFilesPanel — member access (canReadRepoFiles=true)", () => {
  it("mounts the file-tree and gates with (projectId,'readRepoFiles')", async () => {
    const html = await render({ canReadRepoFiles: true, file: null });

    expect(html).toContain('data-testid="file-tree"');
    expect(html).not.toContain('data-testid="repo-files-forbidden"');
    expect(requireProjectAction).toHaveBeenCalledWith(
      "project-1",
      "readRepoFiles",
    );
  });

  it("renders the no-selection prompt pane when ?file= is absent (no readBlob)", async () => {
    const html = await render({ canReadRepoFiles: true, file: null });

    expect(html).toContain('data-testid="file-select-prompt"');
    expect(html).toContain(labels.selectPrompt);
    expect(readBlob).not.toHaveBeenCalled();
  });

  it("renders the not-found pane for a traversal path BEFORE readBlob", async () => {
    const html = await render({ canReadRepoFiles: true, file: "../etc" });

    expect(html).toContain('data-testid="file-not-found"');
    expect(html).not.toContain(labels.forbidden);
    expect(readBlob).not.toHaveBeenCalled();
  });

  it("renders the highlighted code-view for a valid tracked file", async () => {
    vi.mocked(readBlob).mockResolvedValue({
      kind: "text",
      content: "export const x = 1;\n",
    });

    const html = await render({ canReadRepoFiles: true, file: "src/x.ts" });

    expect(html).toContain('data-testid="code-view"');
    expect(readBlob).toHaveBeenCalledWith({
      repo: "/repos/acme",
      ref: "main",
      path: "src/x.ts",
      maxBytes: 524288,
    });
  });

  it("reads the blob at the selected branch ref (currentRef)", async () => {
    vi.mocked(readBlob).mockResolvedValue({
      kind: "text",
      content: "x\n",
    });

    await render({
      canReadRepoFiles: true,
      file: "src/x.ts",
      currentRef: "feature-x",
    });

    expect(readBlob).toHaveBeenCalledWith({
      repo: "/repos/acme",
      ref: "feature-x",
      path: "src/x.ts",
      maxBytes: 524288,
    });
  });
});
