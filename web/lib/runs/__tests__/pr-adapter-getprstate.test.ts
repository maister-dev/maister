import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// ADR-139 (PR lifecycle tracking) Task 5 — provider PR-state reads.
//
// This is a UNIT test. The PROVIDER BOUNDARY is mocked, never invoked for real:
//   * `gh` / `glab` are shelled via `promisify(execFile)` from
//     `node:child_process` — mocked here so no real CLI is spawned.
//   * the Gitea/GitVerse REST API is reached via global `fetch` — stubbed here
//     so no network call is made.
//
// Contract under test (web/lib/runs/pr-adapter.ts):
//
//   export type PrStateReadResult =
//     | { kind: "state"; state: "open" | "merged" | "closed";
//         mergedAt: string | null; mergeCommitSha: string | null;
//         hasConflicts: boolean | null }
//     | { kind: "skip"; transient: boolean; reason: string }
//     | { kind: "unsupported" };
//
//   export async function getPrState(args: {
//     provider: Provider; remoteUrl: string; prNumber: number;
//   }): Promise<PrStateReadResult>;
//
// getPrState NEVER throws — every failure path returns a typed `skip`
// (transient=true retryable, transient=false deterministic terminal) and
// `generic` returns `unsupported` (mirrors selectPrAdapter's unsupported path).
// =============================================================================

// ---- node:child_process mock (gh / glab boundary) -------------------------

type ExecCall = { file: string; args: unknown; opts: unknown };

const execCalls: ExecCall[] = [];

type ExecImpl = (
  args: readonly string[],
  opts: unknown,
) => Promise<{ stdout: string; stderr: string }>;

const execImpls: Record<string, ExecImpl> = {};

function enoent(file: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${file} ENOENT`), {
    code: "ENOENT",
    errno: -2,
    syscall: `spawn ${file}`,
    path: file,
  });
}

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");

  const impl = async (file: string, args: readonly string[], opts: unknown) => {
    execCalls.push({ file, args, opts });
    const handler = execImpls[file];

    if (!handler) throw enoent(file);

    return handler(args, opts);
  };

  const execFileMock = Object.assign(
    function execFile() {
      throw new Error("execFile callback form is not used by the adapter");
    },
    { [promisify.custom]: impl },
  );

  return { ...actual, execFile: execFileMock };
});

// ---- global fetch mock (Gitea REST boundary) ------------------------------

type FetchCall = { url: string; init: RequestInit | undefined };

const fetchCalls: FetchCall[] = [];

type FetchHandler = (
  url: string,
  init: RequestInit | undefined,
) => { status: number; json: unknown };

let fetchHandler: FetchHandler = () => ({ status: 200, json: {} });

function jsonResponse(status: number, json: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as unknown as Response;
}

beforeEach(() => {
  execCalls.length = 0;
  fetchCalls.length = 0;
  for (const k of Object.keys(execImpls)) delete execImpls[k];
  fetchHandler = () => ({ status: 200, json: {} });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);

      fetchCalls.push({ url, init });
      const { status, json } = fetchHandler(url, init);

      return jsonResponse(status, json);
    }),
  );

  delete process.env.GH_TOKEN;
  delete process.env.GITLAB_TOKEN;
  delete process.env.GITEA_TOKEN;
  delete process.env.GITVERSE_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function loadAdapter() {
  return import("../pr-adapter");
}

const GH_REMOTE = "https://github.com/org/repo.git";
const GL_REMOTE = "https://gitlab.com/org/repo.git";
const GITEA_REMOTE = "https://gitea.example.com/org/repo.git";
const GITVERSE_REMOTE = "https://gitverse.ru/org/repo.git";

// =============================================================================
// github — gh pr view --json state,mergedAt,mergeCommit,mergeable,mergeStateStatus
// =============================================================================

describe("getPrState — github (gh CLI)", () => {
  it("open PR with unknown mergeability → state open, hasConflicts null", async () => {
    execImpls["gh"] = async () => ({
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeCommit: null,
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNKNOWN",
      }),
      stderr: "",
    });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "github",
      remoteUrl: GH_REMOTE,
      prNumber: 7,
    });

    expect(res).toEqual({
      kind: "state",
      state: "open",
      mergedAt: null,
      mergeCommitSha: null,
      hasConflicts: null,
    });
  });

  it("merged PR → state merged with mergeCommitSha + mergedAt", async () => {
    execImpls["gh"] = async () => ({
      stdout: JSON.stringify({
        state: "MERGED",
        mergedAt: "2026-07-14T10:00:00Z",
        mergeCommit: { oid: "abc123def456" },
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      }),
      stderr: "",
    });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "github",
      remoteUrl: GH_REMOTE,
      prNumber: 42,
    });

    expect(res).toEqual({
      kind: "state",
      state: "merged",
      mergedAt: "2026-07-14T10:00:00Z",
      mergeCommitSha: "abc123def456",
      hasConflicts: false,
    });
  });

  it("closed (unmerged) PR → state closed", async () => {
    execImpls["gh"] = async () => ({
      stdout: JSON.stringify({
        state: "CLOSED",
        mergedAt: null,
        mergeCommit: null,
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNKNOWN",
      }),
      stderr: "",
    });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "github",
      remoteUrl: GH_REMOTE,
      prNumber: 8,
    });

    expect(res).toEqual({
      kind: "state",
      state: "closed",
      mergedAt: null,
      mergeCommitSha: null,
      hasConflicts: null,
    });
  });

  it("conflicting PR (mergeable CONFLICTING / status DIRTY) → hasConflicts true", async () => {
    execImpls["gh"] = async () => ({
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeCommit: null,
        mergeable: "CONFLICTING",
        mergeStateStatus: "DIRTY",
      }),
      stderr: "",
    });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "github",
      remoteUrl: GH_REMOTE,
      prNumber: 9,
    });

    expect(res).toEqual({
      kind: "state",
      state: "open",
      mergedAt: null,
      mergeCommitSha: null,
      hasConflicts: true,
    });
  });

  it("targets --repo owner/repo + pr number; token rides child env only, never argv", async () => {
    process.env.GH_TOKEN = "gh-secret-token";
    execImpls["gh"] = async () => ({
      stdout: JSON.stringify({
        state: "OPEN",
        mergedAt: null,
        mergeCommit: null,
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNKNOWN",
      }),
      stderr: "",
    });

    const { getPrState } = await loadAdapter();

    await getPrState({ provider: "github", remoteUrl: GH_REMOTE, prNumber: 7 });

    const call = execCalls.find((c) => c.file === "gh");

    expect(call).toBeDefined();
    const argv = call?.args as string[];

    expect(argv).toContain("--repo");
    expect(argv[argv.indexOf("--repo") + 1]).toBe("org/repo");
    expect(argv).toContain("7");
    expect(argv.join(" ")).not.toContain("gh-secret-token");
    // The field list IS the contract with gh: every one of these is read off the
    // payload, and `mergeStateStatus === "DIRTY"` is half of conflict detection
    // (`githubConflicts`). Asserting only `--repo`/`7` meant dropping a field
    // silently disabled PR-conflict detection with every test still green.
    expect(argv).toContain("--json");
    expect(argv[argv.indexOf("--json") + 1]).toBe(
      "state,mergedAt,mergeCommit,mergeable,mergeStateStatus",
    );

    const env = (call?.opts as { env?: Record<string, string> }).env;

    expect(env?.GH_TOKEN).toBe("gh-secret-token");
  });

  it("malformed stdout → transient skip", async () => {
    execImpls["gh"] = async () => ({ stdout: "not-json{{{", stderr: "" });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "github",
      remoteUrl: GH_REMOTE,
      prNumber: 7,
    });

    expect(res).toMatchObject({ kind: "skip", transient: true });
  });

  it("missing gh CLI (ENOENT) → transient skip", async () => {
    // No execImpls["gh"] registered → the mock throws ENOENT.
    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "github",
      remoteUrl: GH_REMOTE,
      prNumber: 7,
    });

    expect(res).toMatchObject({ kind: "skip", transient: true });
  });

  it("PR not found (gh could-not-resolve) → terminal skip (transient:false)", async () => {
    execImpls["gh"] = async () => {
      throw Object.assign(new Error("gh exited 1"), {
        stderr:
          "GraphQL: Could not resolve to a PullRequest with the number of 999.",
        code: 1,
      });
    };

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "github",
      remoteUrl: GH_REMOTE,
      prNumber: 999,
    });

    expect(res).toMatchObject({ kind: "skip", transient: false });
  });

  it("unparseable remote URL → terminal skip (transient:false)", async () => {
    execImpls["gh"] = async () => ({ stdout: "{}", stderr: "" });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "github",
      remoteUrl: "not-a-url",
      prNumber: 7,
    });

    expect(res).toMatchObject({ kind: "skip", transient: false });
    // A bad remote is caught before any CLI is spawned.
    expect(execCalls).toHaveLength(0);
  });
});

// =============================================================================
// gitlab — glab mr view <n> -F json
// =============================================================================

describe("getPrState — gitlab (glab CLI)", () => {
  it("opened MR (has_conflicts false) → state open, hasConflicts false", async () => {
    execImpls["glab"] = async () => ({
      stdout: JSON.stringify({
        state: "opened",
        merged_at: null,
        merge_commit_sha: null,
        has_conflicts: false,
      }),
      stderr: "",
    });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitlab",
      remoteUrl: GL_REMOTE,
      prNumber: 3,
    });

    expect(res).toEqual({
      kind: "state",
      state: "open",
      mergedAt: null,
      mergeCommitSha: null,
      hasConflicts: false,
    });
  });

  it("merged MR → state merged with mergeCommitSha + mergedAt", async () => {
    execImpls["glab"] = async () => ({
      stdout: JSON.stringify({
        state: "merged",
        merged_at: "2026-07-14T09:00:00Z",
        merge_commit_sha: "cafebabe00",
        has_conflicts: false,
      }),
      stderr: "",
    });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitlab",
      remoteUrl: GL_REMOTE,
      prNumber: 4,
    });

    expect(res).toEqual({
      kind: "state",
      state: "merged",
      mergedAt: "2026-07-14T09:00:00Z",
      mergeCommitSha: "cafebabe00",
      hasConflicts: false,
    });
  });

  it("closed MR → state closed, hasConflicts null when no conflict fields", async () => {
    execImpls["glab"] = async () => ({
      stdout: JSON.stringify({
        state: "closed",
        merged_at: null,
        merge_commit_sha: null,
      }),
      stderr: "",
    });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitlab",
      remoteUrl: GL_REMOTE,
      prNumber: 5,
    });

    expect(res).toEqual({
      kind: "state",
      state: "closed",
      mergedAt: null,
      mergeCommitSha: null,
      hasConflicts: null,
    });
  });

  it("conflicting MR (detailed_merge_status conflict) → hasConflicts true", async () => {
    execImpls["glab"] = async () => ({
      stdout: JSON.stringify({
        state: "opened",
        merged_at: null,
        merge_commit_sha: null,
        detailed_merge_status: "conflict",
      }),
      stderr: "",
    });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitlab",
      remoteUrl: GL_REMOTE,
      prNumber: 6,
    });

    expect(res).toEqual({
      kind: "state",
      state: "open",
      mergedAt: null,
      mergeCommitSha: null,
      hasConflicts: true,
    });
  });

  it("glab invoked with an args array + pr number; token rides child env only", async () => {
    process.env.GITLAB_TOKEN = "gl-secret-token";
    execImpls["glab"] = async () => ({
      stdout: JSON.stringify({
        state: "opened",
        merged_at: null,
        merge_commit_sha: null,
        has_conflicts: false,
      }),
      stderr: "",
    });

    const { getPrState } = await loadAdapter();

    await getPrState({ provider: "gitlab", remoteUrl: GL_REMOTE, prNumber: 3 });

    const call = execCalls.find((c) => c.file === "glab");

    expect(call).toBeDefined();
    const argv = call?.args as string[];

    // `Array.isArray(argv)` + "contains the number I passed in" asserted nothing
    // about the command. Pin the whole argv: `-R` with the FULL host URL is what
    // carries a self-hosted host that a bare owner/repo would lose, and `-F json`
    // is what makes the payload parseable at all.
    expect(argv).toEqual([
      "mr",
      "view",
      "3",
      "-R",
      "https://gitlab.com/org/repo",
      "-F",
      "json",
    ]);
    expect(argv.join(" ")).not.toContain("gl-secret-token");

    const env = (call?.opts as { env?: Record<string, string> }).env;

    expect(env?.GITLAB_TOKEN).toBe("gl-secret-token");
  });

  it("malformed stdout → transient skip", async () => {
    execImpls["glab"] = async () => ({ stdout: "nope", stderr: "" });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitlab",
      remoteUrl: GL_REMOTE,
      prNumber: 3,
    });

    expect(res).toMatchObject({ kind: "skip", transient: true });
  });

  it("missing glab CLI (ENOENT) → transient skip", async () => {
    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitlab",
      remoteUrl: GL_REMOTE,
      prNumber: 3,
    });

    expect(res).toMatchObject({ kind: "skip", transient: true });
  });

  it("MR not found (glab 404) → terminal skip (transient:false)", async () => {
    execImpls["glab"] = async () => {
      throw Object.assign(new Error("glab exited 1"), {
        stderr: "404 Not Found",
        code: 1,
      });
    };

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitlab",
      remoteUrl: GL_REMOTE,
      prNumber: 404,
    });

    expect(res).toMatchObject({ kind: "skip", transient: false });
  });
});

// =============================================================================
// gitea / gitverse — REST GET /api/v1/repos/{owner}/{repo}/pulls/{n}
// =============================================================================

describe("getPrState — gitea / gitverse (REST)", () => {
  it("open PR (mergeable true) → state open, hasConflicts false; token in header not URL", async () => {
    process.env.GITEA_TOKEN = "tkn-gitea";
    fetchHandler = (url) => {
      expect(url).toContain("/api/v1/repos/org/repo/pulls/5");

      return {
        status: 200,
        json: {
          state: "open",
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
          mergeable: true,
        },
      };
    };

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitea",
      remoteUrl: GITEA_REMOTE,
      prNumber: 5,
    });

    expect(res).toEqual({
      kind: "state",
      state: "open",
      mergedAt: null,
      mergeCommitSha: null,
      hasConflicts: false,
    });

    const get = fetchCalls[0];
    const headers = get.init?.headers as Record<string, string> | undefined;
    const authValue = headers?.Authorization ?? headers?.authorization ?? "";

    expect(authValue).toContain("tkn-gitea");
    // The token NEVER rides the URL query/path.
    expect(get.url).not.toContain("tkn-gitea");
  });

  it("merged PR (merged flag wins over closed state) → state merged with mergeCommitSha", async () => {
    process.env.GITEA_TOKEN = "tkn-gitea";
    fetchHandler = () => ({
      status: 200,
      json: {
        state: "closed",
        merged: true,
        merged_at: "2026-07-14T08:00:00Z",
        merge_commit_sha: "feed1234ab",
      },
    });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitea",
      remoteUrl: GITEA_REMOTE,
      prNumber: 6,
    });

    expect(res).toEqual({
      kind: "state",
      state: "merged",
      mergedAt: "2026-07-14T08:00:00Z",
      mergeCommitSha: "feed1234ab",
      hasConflicts: null,
    });
  });

  it("closed (unmerged) PR → state closed", async () => {
    process.env.GITEA_TOKEN = "tkn-gitea";
    fetchHandler = () => ({
      status: 200,
      json: {
        state: "closed",
        merged: false,
        merged_at: null,
        merge_commit_sha: null,
      },
    });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitea",
      remoteUrl: GITEA_REMOTE,
      prNumber: 7,
    });

    expect(res).toEqual({
      kind: "state",
      state: "closed",
      mergedAt: null,
      mergeCommitSha: null,
      hasConflicts: null,
    });
  });

  it("conflicting PR (mergeable false) → hasConflicts true", async () => {
    process.env.GITEA_TOKEN = "tkn-gitea";
    fetchHandler = () => ({
      status: 200,
      json: {
        state: "open",
        merged: false,
        mergeable: false,
      },
    });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitea",
      remoteUrl: GITEA_REMOTE,
      prNumber: 8,
    });

    expect(res).toEqual({
      kind: "state",
      state: "open",
      mergedAt: null,
      mergeCommitSha: null,
      hasConflicts: true,
    });
  });

  it("malformed payload (no state / merged) → transient skip", async () => {
    process.env.GITEA_TOKEN = "tkn-gitea";
    fetchHandler = () => ({ status: 200, json: { foo: "bar" } });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitea",
      remoteUrl: GITEA_REMOTE,
      prNumber: 9,
    });

    expect(res).toMatchObject({ kind: "skip", transient: true });
  });

  it("missing GITEA_TOKEN → transient skip, no fetch", async () => {
    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitea",
      remoteUrl: GITEA_REMOTE,
      prNumber: 5,
    });

    expect(res).toMatchObject({ kind: "skip", transient: true });
    expect(fetchCalls).toHaveLength(0);
  });

  it("HTTP 404 → terminal skip (transient:false)", async () => {
    process.env.GITEA_TOKEN = "tkn-gitea";
    fetchHandler = () => ({ status: 404, json: { message: "Not Found" } });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitea",
      remoteUrl: GITEA_REMOTE,
      prNumber: 404,
    });

    expect(res).toMatchObject({ kind: "skip", transient: false });
  });

  it("HTTP 500 → transient skip", async () => {
    process.env.GITEA_TOKEN = "tkn-gitea";
    fetchHandler = () => ({ status: 500, json: { message: "boom" } });

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitea",
      remoteUrl: GITEA_REMOTE,
      prNumber: 5,
    });

    expect(res).toMatchObject({ kind: "skip", transient: true });
  });

  it("gitverse routes through GITVERSE_TOKEN + gitverse apiBase", async () => {
    process.env.GITVERSE_TOKEN = "tkn-gitverse";
    fetchHandler = (url) => {
      expect(url).toContain("gitverse.ru");
      expect(url).toContain("/api/v1/repos/org/repo/pulls/9");

      return {
        status: 200,
        json: { state: "open", merged: false, mergeable: true },
      };
    };

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "gitverse",
      remoteUrl: GITVERSE_REMOTE,
      prNumber: 9,
    });

    expect(res).toMatchObject({ kind: "state", state: "open" });

    const get = fetchCalls[0];
    const headers = get.init?.headers as Record<string, string> | undefined;
    const authValue = headers?.Authorization ?? headers?.authorization ?? "";

    expect(authValue).toContain("tkn-gitverse");
  });
});

// =============================================================================
// generic — unsupported (never throws; mirrors selectPrAdapter's unsupported path)
// =============================================================================

describe("getPrState — generic provider", () => {
  it("returns { kind: 'unsupported' } without spawning a CLI or fetch", async () => {
    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "generic",
      remoteUrl: "",
      prNumber: 1,
    });

    expect(res).toEqual({ kind: "unsupported" });
    expect(execCalls).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });
});

// =============================================================================
// secrets never leak into a skip reason
// =============================================================================

describe("getPrState — secret hygiene", () => {
  it("a gh failure reason redacts the token and credential URLs", async () => {
    process.env.GH_TOKEN = "GH-SECRET-zzz999";
    execImpls["gh"] = async () => {
      throw Object.assign(new Error("boom"), {
        stderr:
          "authentication failed for token GH-SECRET-zzz999 at https://user:pw@github.com/org/repo",
        code: 1,
      });
    };

    const { getPrState } = await loadAdapter();
    const res = await getPrState({
      provider: "github",
      remoteUrl: GH_REMOTE,
      prNumber: 7,
    });

    expect(res.kind).toBe("skip");
    const reason = (res as { reason: string }).reason;

    expect(reason).not.toContain("GH-SECRET-zzz999");
    expect(reason).not.toContain("user:pw@");
  });
});
