import { beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock: keep the real schemas (remoteNameSchema) but stub the git-
// executing ops so the orchestrator can be unit-tested without a real repo.
vi.mock("@/lib/worktree", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/worktree")>();

  return {
    ...actual,
    remoteAdd: vi.fn(async () => undefined),
    remoteSetUrl: vi.fn(async () => undefined),
    remoteRemove: vi.fn(async () => undefined),
    listRemoteUrls: vi.fn(async () => []),
    getRemoteUrl: vi.fn(async () => null),
    fetchRemote: vi.fn(async () => undefined),
    pushBranch: vi.fn(async () => undefined),
  };
});

import * as worktree from "@/lib/worktree";
import { GitPushRejectedError, remoteNameSchema } from "@/lib/worktree";
import { MaisterError } from "@/lib/errors";
import {
  addProjectRemote,
  fetchProjectRemote,
  listProjectRemotes,
  pushProjectRemote,
  reconcileOriginRepoUrl,
  removeProjectRemote,
} from "@/lib/git-remotes";

type FakeDb = {
  calls: Array<Record<string, unknown>>;
  update: () => {
    set: (v: Record<string, unknown>) => { where: () => Promise<void> };
  };
};

function fakeDb(): FakeDb {
  const calls: Array<Record<string, unknown>> = [];

  return {
    calls,
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          calls.push(vals);
        },
      }),
    }),
  };
}

const project = { id: "p1", repoPath: "/repo" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("remoteNameSchema (shared, decision 4)", () => {
  it("accepts dotted and slashed names, rejects a leading dash and empty", () => {
    expect(remoteNameSchema.safeParse("origin").success).toBe(true);
    expect(remoteNameSchema.safeParse("up.stream").success).toBe(true);
    expect(remoteNameSchema.safeParse("team/fork").success).toBe(true);
    expect(remoteNameSchema.safeParse("-bad").success).toBe(false);
    expect(remoteNameSchema.safeParse("").success).toBe(false);
  });
});

describe("git-remotes orchestrator", () => {
  it("redacts credentials when listing", async () => {
    vi.mocked(worktree.listRemoteUrls).mockResolvedValueOnce([
      { name: "origin", url: "https://user:secret@github.com/o/r.git" },
      { name: "fork", url: "git@github.com:me/r.git" },
    ]);

    const remotes = await listProjectRemotes("/repo");

    expect(remotes).toEqual([
      { name: "origin", url: "https://user:***@github.com/o/r.git" },
      { name: "fork", url: "git@github.com:me/r.git" },
    ]);
  });

  it("rejects a disallowed url scheme before touching git", async () => {
    const db = fakeDb();

    await expect(
      addProjectRemote({ db, project, name: "origin", url: "ftp://x/y" }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(worktree.remoteAdd).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  it("syncs origin to projects.repo_url/provider (redacted + detected)", async () => {
    const db = fakeDb();

    await addProjectRemote({
      db,
      project,
      name: "origin",
      url: "https://u:p@github.com/o/r.git",
    });

    expect(worktree.remoteAdd).toHaveBeenCalledWith({
      projectRepoPath: "/repo",
      name: "origin",
      url: "https://u:p@github.com/o/r.git",
    });
    expect(db.calls).toEqual([
      { repoUrl: "https://u:***@github.com/o/r.git", provider: "github" },
    ]);
  });

  it("does NOT sync the DB for a non-origin remote", async () => {
    const db = fakeDb();

    await addProjectRemote({
      db,
      project,
      name: "upstream",
      url: "https://gitlab.com/o/r.git",
    });

    expect(worktree.remoteAdd).toHaveBeenCalledOnce();
    expect(db.calls).toEqual([]);
  });

  it("nulls the origin cache when origin is removed", async () => {
    const db = fakeDb();

    await removeProjectRemote({ db, project, name: "origin" });

    expect(db.calls).toEqual([{ repoUrl: null, provider: null }]);
  });

  it("reconciles a null cache from git's live origin (self-heal)", async () => {
    vi.mocked(worktree.getRemoteUrl).mockResolvedValueOnce(
      "https://github.com/o/r.git",
    );
    const db = fakeDb();

    const url = await reconcileOriginRepoUrl({
      db,
      project: { ...project, repoUrl: null },
    });

    expect(url).toBe("https://github.com/o/r.git");
    expect(db.calls).toEqual([
      { repoUrl: "https://github.com/o/r.git", provider: "github" },
    ]);
  });

  it("reconcile is a no-op when the cache already matches git", async () => {
    vi.mocked(worktree.getRemoteUrl).mockResolvedValueOnce(
      "https://github.com/o/r.git",
    );
    const db = fakeDb();

    await reconcileOriginRepoUrl({
      db,
      project: { ...project, repoUrl: "https://github.com/o/r.git" },
    });

    expect(db.calls).toEqual([]);
  });
});

// [FIX] Codex F2: push/fetch classify failures — only a genuine push/fetch
// failure on an EXISTING remote (non-fast-forward / EXECUTOR_UNAVAILABLE) is an
// advisory; an unknown remote and any validation PRECONDITION must surface, not
// be swallowed as "success with warning".
describe("git-remotes push/fetch failure classification", () => {
  it("push to an unknown remote → PRECONDITION (never touches pushBranch)", async () => {
    vi.mocked(worktree.getRemoteUrl).mockResolvedValueOnce(null);

    await expect(
      pushProjectRemote({ project, name: "origin", branch: "main" }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(worktree.pushBranch).not.toHaveBeenCalled();
  });

  it("non-fast-forward push on a known remote → advisory { ok, warning }", async () => {
    vi.mocked(worktree.getRemoteUrl).mockResolvedValueOnce("https://h/r.git");
    vi.mocked(worktree.pushBranch).mockRejectedValueOnce(
      new GitPushRejectedError("push rejected (non-fast-forward)"),
    );

    const res = await pushProjectRemote({
      project,
      name: "origin",
      branch: "main",
    });

    expect(res.ok).toBe(true);
    expect(res.warning).toContain("non-fast-forward");
  });

  it("network EXECUTOR_UNAVAILABLE push → advisory", async () => {
    vi.mocked(worktree.getRemoteUrl).mockResolvedValueOnce("https://h/r.git");
    vi.mocked(worktree.pushBranch).mockRejectedValueOnce(
      new MaisterError("EXECUTOR_UNAVAILABLE", "network down"),
    );

    const res = await pushProjectRemote({
      project,
      name: "origin",
      branch: "main",
    });

    expect(res).toEqual({ ok: true, warning: "network down" });
  });

  it("a validation PRECONDITION from pushBranch (e.g. bad branch) is rethrown, not advisory", async () => {
    vi.mocked(worktree.getRemoteUrl).mockResolvedValueOnce("https://h/r.git");
    vi.mocked(worktree.pushBranch).mockRejectedValueOnce(
      new MaisterError("PRECONDITION", "Invalid branch"),
    );

    await expect(
      pushProjectRemote({ project, name: "origin", branch: "main" }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
  });

  it("fetch on an unknown remote → PRECONDITION", async () => {
    vi.mocked(worktree.getRemoteUrl).mockResolvedValueOnce(null);

    await expect(
      fetchProjectRemote({ project, name: "missing" }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });
    expect(worktree.fetchRemote).not.toHaveBeenCalled();
  });
});
