import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

// =============================================================================
// M18 Phase 3 — RED until `web/lib/runs/pr-adapter.ts` lands.
//
// This is a UNIT test. The PROVIDER BOUNDARY is mocked, never invoked for real:
//   * `gh` / `glab` are shelled via `promisify(execFile)` from
//     `node:child_process` — mocked here so no real CLI is spawned.
//   * the Gitea-compatible REST API is reached via global `fetch` — stubbed
//     here so no network call is made.
//
// Live `gh`/`glab` push+PR and a live Gitea/GitVerse PR are exercised ONLY in
// manual verification (plan T3.5, "no silent caps") — never in CI.
//
// ---- PINNED CONTRACT the Implementor builds EXACTLY (web/lib/runs/pr-adapter.ts):
//
//   export interface PrAdapter {
//     preflight(): Promise<void>; // throws MaisterError("PRECONDITION") on
//                                 // CLI-missing / token-unset / remote-unset
//     createOrUpdatePr(args: {
//       repoPath: string; remote: string;
//       sourceBranch: string; targetBranch: string;
//       title: string; body: string;
//     }): Promise<{ url: string; number: number }>;
//   }
//
//   export function selectPrAdapter(
//     provider: Provider,
//     ctx: { remoteUrl?: string | null },
//   ): PrAdapter;
//     // github   -> GhCliAdapter
//     // gitlab   -> GlabCliAdapter
//     // gitea    -> GiteaApiAdapter (GITEA_TOKEN)
//     // gitverse -> GiteaApiAdapter (GITVERSE_TOKEN)
//     // generic  -> throw PRECONDITION "PR mode unsupported for provider"
//
// ---- exec mock shape (the Implementor's adapters MUST match):
//   The adapter does `const execFileAsync = promisify(execFile)` and calls
//   `execFileAsync("gh"|"glab", [...arrayArgs], opts)`. We mock
//   `node:child_process`'s `execFile` carrying a `util.promisify.custom` impl,
//   so `promisify(execFile)` resolves to our async fn. Each invocation records
//   `{ file, args, opts }` so we assert: (1) the binary, (2) an ARGS ARRAY (no
//   shell string), (3) token redaction in thrown messages.
//
// ---- fetch mock shape (Gitea):
//   `fetch(url, init)` where `init.method` is "GET" (detect) or "POST" (create),
//   `init.headers.Authorization` is `Bearer <token>`, and the JSON body for POST
//   carries `{ head, base, title, body }`. The detect GET hits
//   `{apiBase}/api/v1/repos/{owner}/{repo}/pulls?...`; the create POST the same
//   collection. A matching open PR JSON is `{ html_url, number }`.
// =============================================================================

// ---- node:child_process mock (gh / glab boundary) -------------------------

type ExecCall = { file: string; args: unknown; opts: unknown };

const execCalls: ExecCall[] = [];

// The behavior the mocked `execFileAsync(file, args, opts)` performs, keyed by
// binary. Tests reassign entries in beforeEach / per-case.
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

  // Carry the promisify.custom symbol so `promisify(execFile)` returns `impl`.
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

let fetchHandler: FetchHandler = () => ({ status: 200, json: [] });

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
  fetchHandler = () => ({ status: 200, json: [] });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);

      fetchCalls.push({ url, init });
      const { status, json } = fetchHandler(url, init);

      return jsonResponse(status, json);
    }),
  );

  // Provider tokens default unset; individual cases set them.
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

const PR_ARGS = {
  repoPath: "/repos/demo",
  remote: "origin",
  sourceBranch: "maister/feature",
  targetBranch: "main",
  title: "M18 feature",
  body: "promotes maister/feature into main",
} as const;

// =============================================================================
// dispatch
// =============================================================================

describe("selectPrAdapter — provider dispatch", () => {
  it("returns the gh CLI adapter for github", async () => {
    const { selectPrAdapter } = await loadAdapter();
    const adapter = selectPrAdapter("github", {
      remoteUrl: "https://github.com/org/repo.git",
    });

    expect(adapter.constructor.name).toBe("GhCliAdapter");
  });

  it("returns the glab CLI adapter for gitlab", async () => {
    const { selectPrAdapter } = await loadAdapter();
    const adapter = selectPrAdapter("gitlab", {
      remoteUrl: "https://gitlab.com/org/repo.git",
    });

    expect(adapter.constructor.name).toBe("GlabCliAdapter");
  });

  it("returns the shared Gitea REST adapter for gitea", async () => {
    const { selectPrAdapter } = await loadAdapter();
    const adapter = selectPrAdapter("gitea", {
      remoteUrl: "https://gitea.example.com/org/repo.git",
    });

    expect(adapter.constructor.name).toBe("GiteaApiAdapter");
  });

  it("returns the shared Gitea REST adapter for gitverse", async () => {
    const { selectPrAdapter } = await loadAdapter();
    const adapter = selectPrAdapter("gitverse", {
      remoteUrl: "https://gitverse.ru/org/repo.git",
    });

    expect(adapter.constructor.name).toBe("GiteaApiAdapter");
  });

  it("throws PRECONDITION (unsupported) for a generic provider", async () => {
    const { selectPrAdapter } = await loadAdapter();

    expect(() => selectPrAdapter("generic", { remoteUrl: null })).toThrow(
      MaisterError,
    );
    try {
      selectPrAdapter("generic", { remoteUrl: null });
    } catch (err) {
      expect(err).toMatchObject({ code: "PRECONDITION" });
      expect((err as Error).message).toMatch(/unsupported/i);
    }
  });
});

// =============================================================================
// branch-name hygiene — unsafe refs are rejected at the PR boundary, before any
// gh/glab argv or Gitea REST call, on all three adapters (one shared rule).
// =============================================================================

describe("createOrUpdatePr — branch-name validation", () => {
  const REMOTE = {
    github: "https://github.com/org/repo.git",
    gitlab: "https://gitlab.com/org/repo.git",
    gitea: "https://gitea.example.com/org/repo.git",
  } as const;

  for (const provider of ["github", "gitlab", "gitea"] as const) {
    it(`${provider}: rejects an unsafe targetBranch with PRECONDITION and never calls the provider`, async () => {
      const { selectPrAdapter } = await loadAdapter();
      const adapter = selectPrAdapter(provider, {
        remoteUrl: REMOTE[provider],
      });

      await expect(
        adapter.createOrUpdatePr({ ...PR_ARGS, targetBranch: "main\n--evil" }),
      ).rejects.toMatchObject({ code: "PRECONDITION" });

      expect(execCalls).toHaveLength(0);
      expect(fetchCalls).toHaveLength(0);
    });
  }

  it("rejects an unsafe sourceBranch (leading dash) before any provider call", async () => {
    const { selectPrAdapter } = await loadAdapter();
    const adapter = selectPrAdapter("github", { remoteUrl: REMOTE.github });

    await expect(
      adapter.createOrUpdatePr({ ...PR_ARGS, sourceBranch: "-x" }),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    expect(execCalls).toHaveLength(0);
  });
});

// =============================================================================
// preflight failures → PRECONDITION
// =============================================================================

describe("GhCliAdapter — preflight", () => {
  it("throws PRECONDITION when `gh` is missing on PATH (exec ENOENT)", async () => {
    const { selectPrAdapter } = await loadAdapter();
    // No execImpls["gh"] registered → the mock throws ENOENT.
    const adapter = selectPrAdapter("github", {
      remoteUrl: "https://github.com/org/repo.git",
    });

    await expect(adapter.preflight()).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });

  it("passes preflight when `gh --version` succeeds", async () => {
    const { selectPrAdapter } = await loadAdapter();

    execImpls["gh"] = async () => ({
      stdout: "gh version 2.62.0",
      stderr: "",
    });
    const adapter = selectPrAdapter("github", {
      remoteUrl: "https://github.com/org/repo.git",
    });

    await expect(adapter.preflight()).resolves.toBeUndefined();
    // Preflight shells gh with an ARGS ARRAY (execFile-style), never a shell string.
    const call = execCalls.find((c) => c.file === "gh");

    expect(call).toBeDefined();
    expect(Array.isArray(call?.args)).toBe(true);
  });

  it("throws PRECONDITION when the remote is not configured", async () => {
    const { selectPrAdapter } = await loadAdapter();

    execImpls["gh"] = async () => ({ stdout: "gh version", stderr: "" });
    const adapter = selectPrAdapter("github", { remoteUrl: null });

    await expect(adapter.preflight()).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });
});

describe("GlabCliAdapter — preflight", () => {
  it("throws PRECONDITION when `glab` is missing on PATH (exec ENOENT)", async () => {
    const { selectPrAdapter } = await loadAdapter();
    const adapter = selectPrAdapter("gitlab", {
      remoteUrl: "https://gitlab.com/org/repo.git",
    });

    await expect(adapter.preflight()).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });

  it("passes preflight when `glab --version` succeeds and a remote is set", async () => {
    const { selectPrAdapter } = await loadAdapter();

    execImpls["glab"] = async () => ({ stdout: "glab 1.50.0", stderr: "" });
    const adapter = selectPrAdapter("gitlab", {
      remoteUrl: "https://gitlab.com/org/repo.git",
    });

    await expect(adapter.preflight()).resolves.toBeUndefined();
    expect(execCalls.find((c) => c.file === "glab")).toBeDefined();
  });
});

describe("GiteaApiAdapter — preflight", () => {
  it("throws PRECONDITION when GITEA_TOKEN is unset (gitea)", async () => {
    const { selectPrAdapter } = await loadAdapter();
    const adapter = selectPrAdapter("gitea", {
      remoteUrl: "https://gitea.example.com/org/repo.git",
    });

    await expect(adapter.preflight()).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });

  it("throws PRECONDITION when GITVERSE_TOKEN is unset (gitverse)", async () => {
    const { selectPrAdapter } = await loadAdapter();
    const adapter = selectPrAdapter("gitverse", {
      remoteUrl: "https://gitverse.ru/org/repo.git",
    });

    await expect(adapter.preflight()).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });

  it("throws PRECONDITION when the remote is not configured (gitea)", async () => {
    process.env.GITEA_TOKEN = "tkn-gitea";
    const { selectPrAdapter } = await loadAdapter();
    const adapter = selectPrAdapter("gitea", { remoteUrl: null });

    await expect(adapter.preflight()).rejects.toMatchObject({
      code: "PRECONDITION",
    });
  });

  it("passes preflight with GITEA_TOKEN set and a remote present", async () => {
    process.env.GITEA_TOKEN = "tkn-gitea";
    const { selectPrAdapter } = await loadAdapter();
    const adapter = selectPrAdapter("gitea", {
      remoteUrl: "https://gitea.example.com/org/repo.git",
    });

    await expect(adapter.preflight()).resolves.toBeUndefined();
  });
});

// =============================================================================
// happy path — createOrUpdatePr returns { url, number }
// =============================================================================

describe("GhCliAdapter — createOrUpdatePr happy path (no existing PR)", () => {
  it("detects no existing PR via `gh pr list --head`, then `gh pr create`, parsing the PR url/number", async () => {
    const { selectPrAdapter } = await loadAdapter();

    execImpls["gh"] = async (args) => {
      const argv = args as readonly string[];

      // `gh pr list --head <branch>` → empty (no existing PR).
      if (argv.includes("list")) return { stdout: "[]", stderr: "" };
      // `gh pr create ...` → prints the created PR URL.
      if (argv.includes("create")) {
        return {
          stdout: "https://github.com/org/repo/pull/42\n",
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    };

    const adapter = selectPrAdapter("github", {
      remoteUrl: "https://github.com/org/repo.git",
    });
    const result = await adapter.createOrUpdatePr({ ...PR_ARGS });

    expect(result).toEqual({
      url: "https://github.com/org/repo/pull/42",
      number: 42,
    });

    // A `gh pr list` (detect) preceded `gh pr create` (no blind create).
    const list = execCalls.find(
      (c) => c.file === "gh" && (c.args as string[]).includes("list"),
    );
    const create = execCalls.find(
      (c) => c.file === "gh" && (c.args as string[]).includes("create"),
    );

    expect(list).toBeDefined();
    expect(create).toBeDefined();
  });
});

describe("GlabCliAdapter — createOrUpdatePr happy path (no existing MR)", () => {
  it("detects no existing MR via `glab mr list --source-branch`, then `glab mr create`", async () => {
    const { selectPrAdapter } = await loadAdapter();

    execImpls["glab"] = async (args) => {
      const argv = args as readonly string[];

      if (argv.includes("list")) return { stdout: "[]", stderr: "" };
      if (argv.includes("create")) {
        return {
          stdout: "https://gitlab.com/org/repo/-/merge_requests/7\n",
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    };

    const adapter = selectPrAdapter("gitlab", {
      remoteUrl: "https://gitlab.com/org/repo.git",
    });
    const result = await adapter.createOrUpdatePr({ ...PR_ARGS });

    expect(result).toEqual({
      url: "https://gitlab.com/org/repo/-/merge_requests/7",
      number: 7,
    });
  });
});

describe("GiteaApiAdapter — createOrUpdatePr happy path (no existing PR)", () => {
  it("GET pulls returns empty, POST pulls creates and returns { html_url, number }", async () => {
    process.env.GITEA_TOKEN = "tkn-gitea";
    const { selectPrAdapter } = await loadAdapter();

    fetchHandler = (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();

      // The API base + owner/repo are derived from the remote URL.
      expect(url).toContain("/api/v1/repos/org/repo/pulls");
      if (method === "GET") return { status: 200, json: [] };
      if (method === "POST") {
        return {
          status: 201,
          json: {
            html_url: "https://gitea.example.com/org/repo/pulls/13",
            number: 13,
          },
        };
      }

      return { status: 200, json: [] };
    };

    const adapter = selectPrAdapter("gitea", {
      remoteUrl: "https://gitea.example.com/org/repo.git",
    });
    const result = await adapter.createOrUpdatePr({ ...PR_ARGS });

    expect(result).toEqual({
      url: "https://gitea.example.com/org/repo/pulls/13",
      number: 13,
    });

    // Bearer token carried on the request; the body has head/base.
    const post = fetchCalls.find(
      (c) => (c.init?.method ?? "GET").toUpperCase() === "POST",
    );

    expect(post).toBeDefined();
    const headers = post?.init?.headers as Record<string, string> | undefined;
    const authValue = headers?.Authorization ?? headers?.authorization ?? "";

    expect(authValue).toContain("tkn-gitea");
  });

  it("gitverse routes through GiteaApiAdapter with GITVERSE_TOKEN and the gitverse apiBase", async () => {
    process.env.GITVERSE_TOKEN = "tkn-gitverse";
    const { selectPrAdapter } = await loadAdapter();

    fetchHandler = (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();

      // apiBase derived from the gitverse remote host.
      expect(url).toContain("gitverse.ru");
      expect(url).toContain("/api/v1/repos/org/repo/pulls");
      if (method === "GET") return { status: 200, json: [] };

      return {
        status: 201,
        json: {
          html_url: "https://gitverse.ru/org/repo/pulls/3",
          number: 3,
        },
      };
    };

    const adapter = selectPrAdapter("gitverse", {
      remoteUrl: "https://gitverse.ru/org/repo.git",
    });
    const result = await adapter.createOrUpdatePr({ ...PR_ARGS });

    expect(result).toEqual({
      url: "https://gitverse.ru/org/repo/pulls/3",
      number: 3,
    });

    const post = fetchCalls.find(
      (c) => (c.init?.method ?? "GET").toUpperCase() === "POST",
    );
    const headers = post?.init?.headers as Record<string, string> | undefined;
    const authValue = headers?.Authorization ?? headers?.authorization ?? "";

    expect(authValue).toContain("tkn-gitverse");
  });
});

// =============================================================================
// idempotency — an existing PR for the head branch is UPDATED, not duplicated
// =============================================================================

describe("GhCliAdapter — idempotent (existing PR for the head branch)", () => {
  it("when `gh pr list --head` returns a PR, does NOT create a duplicate — returns the existing url/number", async () => {
    const { selectPrAdapter } = await loadAdapter();

    execImpls["gh"] = async (args) => {
      const argv = args as readonly string[];

      if (argv.includes("list")) {
        return {
          stdout: JSON.stringify([
            { number: 9, url: "https://github.com/org/repo/pull/9" },
          ]),
          stderr: "",
        };
      }
      if (argv.includes("create")) {
        throw new Error("gh pr create MUST NOT be called when a PR exists");
      }

      return { stdout: "", stderr: "" };
    };

    const adapter = selectPrAdapter("github", {
      remoteUrl: "https://github.com/org/repo.git",
    });
    const result = await adapter.createOrUpdatePr({ ...PR_ARGS });

    expect(result).toEqual({
      url: "https://github.com/org/repo/pull/9",
      number: 9,
    });

    // No `gh pr create` was issued (update path).
    const created = execCalls.some(
      (c) => c.file === "gh" && (c.args as string[]).includes("create"),
    );

    expect(created).toBe(false);
  });
});

describe("GiteaApiAdapter — idempotent (existing open PR for the head branch)", () => {
  it("when GET pulls returns a matching open PR, does NOT POST a create — returns the existing PR", async () => {
    process.env.GITEA_TOKEN = "tkn-gitea";
    const { selectPrAdapter } = await loadAdapter();

    fetchHandler = (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET") {
        return {
          status: 200,
          json: [
            {
              html_url: "https://gitea.example.com/org/repo/pulls/5",
              number: 5,
              state: "open",
              head: { ref: "maister/feature" },
              base: { ref: "main" },
            },
          ],
        };
      }

      // A POST here would be a duplicate-create bug.
      return { status: 500, json: { message: "POST must not happen" } };
    };

    const adapter = selectPrAdapter("gitea", {
      remoteUrl: "https://gitea.example.com/org/repo.git",
    });
    const result = await adapter.createOrUpdatePr({ ...PR_ARGS });

    expect(result).toEqual({
      url: "https://gitea.example.com/org/repo/pulls/5",
      number: 5,
    });

    const created = fetchCalls.some(
      (c) => (c.init?.method ?? "GET").toUpperCase() === "POST",
    );

    expect(created).toBe(false);
  });
});

// =============================================================================
// wrong-target idempotency — an existing PR for the SAME head but a DIFFERENT
// base MUST NOT be treated as the match: `gh pr list --head` / `glab mr list
// --source-branch` return PRs for the head regardless of base, so a `feature→
// release` PR must not satisfy a `feature→main` promote. The adapter scopes by
// base (--base / --target-branch) AND post-filters on the reported base ref, so
// it proceeds to CREATE the `feature→main` PR instead of returning the wrong one.
// =============================================================================

describe("GhCliAdapter — does NOT match an existing PR for a different base", () => {
  it("an open `head→release` PR is ignored for a `head→main` promote — `gh pr create` is issued", async () => {
    const { selectPrAdapter } = await loadAdapter();

    execImpls["gh"] = async (args) => {
      const argv = args as readonly string[];

      // The CLI (mock) ignores --base and returns the head's PR regardless: it
      // reports baseRefName="release", which the adapter must reject for a
      // targetBranch="main" promote.
      if (argv.includes("list")) {
        return {
          stdout: JSON.stringify([
            {
              number: 11,
              url: "https://github.com/org/repo/pull/11",
              baseRefName: "release",
            },
          ]),
          stderr: "",
        };
      }
      if (argv.includes("create")) {
        return {
          stdout: "https://github.com/org/repo/pull/12\n",
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    };

    const adapter = selectPrAdapter("github", {
      remoteUrl: "https://github.com/org/repo.git",
    });
    // PR_ARGS.targetBranch === "main"; the existing PR targets "release".
    const result = await adapter.createOrUpdatePr({ ...PR_ARGS });

    // The CREATE path was taken — the wrong-base PR (11) was NOT returned.
    expect(result).toEqual({
      url: "https://github.com/org/repo/pull/12",
      number: 12,
    });

    const created = execCalls.some(
      (c) => c.file === "gh" && (c.args as string[]).includes("create"),
    );

    expect(created).toBe(true);

    // The list query is scoped by base (defense-in-depth alongside the filter).
    const list = execCalls.find(
      (c) => c.file === "gh" && (c.args as string[]).includes("list"),
    );
    const listArgs = list?.args as string[];

    expect(listArgs).toContain("--base");
    expect(listArgs[listArgs.indexOf("--base") + 1]).toBe("main");
  });
});

describe("GlabCliAdapter — does NOT match an existing MR for a different base", () => {
  it("an open `head→release` MR is ignored for a `head→main` promote — `glab mr create` is issued", async () => {
    const { selectPrAdapter } = await loadAdapter();

    execImpls["glab"] = async (args) => {
      const argv = args as readonly string[];

      if (argv.includes("list")) {
        return {
          stdout: JSON.stringify([
            {
              iid: 4,
              web_url: "https://gitlab.com/org/repo/-/merge_requests/4",
              target_branch: "release",
            },
          ]),
          stderr: "",
        };
      }
      if (argv.includes("create")) {
        return {
          stdout: "https://gitlab.com/org/repo/-/merge_requests/5\n",
          stderr: "",
        };
      }

      return { stdout: "", stderr: "" };
    };

    const adapter = selectPrAdapter("gitlab", {
      remoteUrl: "https://gitlab.com/org/repo.git",
    });
    const result = await adapter.createOrUpdatePr({ ...PR_ARGS });

    expect(result).toEqual({
      url: "https://gitlab.com/org/repo/-/merge_requests/5",
      number: 5,
    });

    const created = execCalls.some(
      (c) => c.file === "glab" && (c.args as string[]).includes("create"),
    );

    expect(created).toBe(true);

    const list = execCalls.find(
      (c) => c.file === "glab" && (c.args as string[]).includes("list"),
    );
    const listArgs = list?.args as string[];

    expect(listArgs).toContain("--target-branch");
    expect(listArgs[listArgs.indexOf("--target-branch") + 1]).toBe("main");
  });
});

// =============================================================================
// token redaction — the token never leaks into a thrown error message
// =============================================================================

describe("token redaction (NEVER log/leak the token)", () => {
  it("GiteaApiAdapter — a PR-API failure error message does NOT contain the bearer token", async () => {
    process.env.GITEA_TOKEN = "SUPER-SECRET-TOKEN-abc123";
    const { selectPrAdapter } = await loadAdapter();

    // Drive a failure: the create POST returns a 500.
    fetchHandler = (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET") return { status: 200, json: [] };

      return { status: 500, json: { message: "internal error" } };
    };

    const adapter = selectPrAdapter("gitea", {
      remoteUrl: "https://gitea.example.com/org/repo.git",
    });

    let thrown: unknown;

    try {
      await adapter.createOrUpdatePr({ ...PR_ARGS });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MaisterError);
    expect((thrown as Error).message).not.toContain(
      "SUPER-SECRET-TOKEN-abc123",
    );
  });

  it("GhCliAdapter — a CLI failure error message does NOT contain GH_TOKEN", async () => {
    process.env.GH_TOKEN = "GH-SECRET-zzz999";
    const { selectPrAdapter } = await loadAdapter();

    execImpls["gh"] = async (args) => {
      const argv = args as readonly string[];

      if (argv.includes("list")) return { stdout: "[]", stderr: "" };
      // create fails at runtime.
      throw Object.assign(new Error("gh: pr create failed"), {
        stderr: "authentication failed",
        code: 1,
      });
    };

    const adapter = selectPrAdapter("github", {
      remoteUrl: "https://github.com/org/repo.git",
    });

    let thrown: unknown;

    try {
      await adapter.createOrUpdatePr({ ...PR_ARGS });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MaisterError);
    expect((thrown as Error).message).not.toContain("GH-SECRET-zzz999");
  });
});

// =============================================================================
// no shell — exec is invoked with an ARGS ARRAY (execFile-style), never a
// single shell string
// =============================================================================

// =============================================================================
// repo context — gh/glab MUST run against the TARGET project repo (args.repoPath
// as cwd), never the MAIster server's own working directory. Otherwise the CLI
// infers the wrong repository from the process CWD and can list/create PRs
// against the wrong repo.
// =============================================================================

describe("CLI adapters — every invocation runs in the target repo cwd", () => {
  it("gh: every pr list/create exec uses args.repoPath as cwd", async () => {
    const { selectPrAdapter } = await loadAdapter();

    execImpls["gh"] = async (args) => {
      const argv = args as readonly string[];

      if (argv.includes("list")) return { stdout: "[]", stderr: "" };

      return { stdout: "https://github.com/org/repo/pull/1\n", stderr: "" };
    };

    const adapter = selectPrAdapter("github", {
      remoteUrl: "https://github.com/org/repo.git",
    });

    await adapter.createOrUpdatePr({ ...PR_ARGS });

    expect(execCalls.length).toBeGreaterThan(0);
    for (const call of execCalls) {
      expect((call.opts as { cwd?: string }).cwd).toBe(PR_ARGS.repoPath);
    }
  });

  it("glab: every mr list/create exec uses args.repoPath as cwd", async () => {
    const { selectPrAdapter } = await loadAdapter();

    execImpls["glab"] = async (args) => {
      const argv = args as readonly string[];

      if (argv.includes("list")) return { stdout: "[]", stderr: "" };

      return {
        stdout: "https://gitlab.com/org/repo/-/merge_requests/1\n",
        stderr: "",
      };
    };

    const adapter = selectPrAdapter("gitlab", {
      remoteUrl: "https://gitlab.com/org/repo.git",
    });

    await adapter.createOrUpdatePr({ ...PR_ARGS });

    expect(execCalls.length).toBeGreaterThan(0);
    for (const call of execCalls) {
      expect((call.opts as { cwd?: string }).cwd).toBe(PR_ARGS.repoPath);
    }
  });
});

// =============================================================================
// Gitea pagination — the (head,base) match may live beyond the first page on a
// busy repo. findOpenPr MUST page until it finds the match (or exhausts the open
// PRs) rather than POST a duplicate when a full first page omits the match.
// =============================================================================

describe("GiteaApiAdapter — paginates the open-PR lookup", () => {
  it("finds a matching PR on page 2 and does NOT create a duplicate", async () => {
    process.env.GITEA_TOKEN = "tkn-gitea";
    const { selectPrAdapter } = await loadAdapter();

    // A full first page (50 non-matching open PRs) forces a second page fetch.
    const fullPage = Array.from({ length: 50 }, (_unused, i) => ({
      html_url: `https://gitea.example.com/org/repo/pulls/${i + 100}`,
      number: i + 100,
      head: { ref: "someone/other" },
      base: { ref: "main" },
    }));
    const matchPage = [
      {
        html_url: "https://gitea.example.com/org/repo/pulls/200",
        number: 200,
        head: { ref: "maister/feature" },
        base: { ref: "main" },
      },
    ];

    fetchHandler = (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET") {
        return {
          status: 200,
          json: url.includes("page=1") ? fullPage : matchPage,
        };
      }

      // A POST here would be the duplicate-create bug.
      return { status: 500, json: { message: "POST must not happen" } };
    };

    const adapter = selectPrAdapter("gitea", {
      remoteUrl: "https://gitea.example.com/org/repo.git",
    });
    const result = await adapter.createOrUpdatePr({ ...PR_ARGS });

    expect(result).toEqual({
      url: "https://gitea.example.com/org/repo/pulls/200",
      number: 200,
    });

    const gets = fetchCalls.filter(
      (c) => (c.init?.method ?? "GET").toUpperCase() === "GET",
    );
    const posts = fetchCalls.filter(
      (c) => (c.init?.method ?? "GET").toUpperCase() === "POST",
    );

    expect(gets.length).toBe(2);
    expect(posts.length).toBe(0);
  });

  it("refuses (no duplicate POST) when the open-PR list never pages out", async () => {
    process.env.GITEA_TOKEN = "tkn-gitea";
    const { selectPrAdapter } = await loadAdapter();

    // A server that ALWAYS returns a full, non-matching page never signals a
    // last page. The sweep must terminate at the page cap and REFUSE rather
    // than POST a blind (possibly duplicate) create.
    const fullPage = Array.from({ length: 50 }, (_unused, i) => ({
      html_url: `https://gitea.example.com/org/repo/pulls/${i + 1}`,
      number: i + 1,
      head: { ref: "someone/other" },
      base: { ref: "main" },
    }));

    fetchHandler = (_url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();

      if (method === "GET") return { status: 200, json: fullPage };

      // A POST here would be the duplicate-create bug the cap must prevent.
      return { status: 500, json: { message: "POST must not happen" } };
    };

    const adapter = selectPrAdapter("gitea", {
      remoteUrl: "https://gitea.example.com/org/repo.git",
    });

    await expect(
      adapter.createOrUpdatePr({ ...PR_ARGS }),
    ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });

    const gets = fetchCalls.filter(
      (c) => (c.init?.method ?? "GET").toUpperCase() === "GET",
    );
    const posts = fetchCalls.filter(
      (c) => (c.init?.method ?? "GET").toUpperCase() === "POST",
    );

    // Bounded sweep (the 200-page cap), then a refusal — never an infinite loop
    // and never a blind create.
    expect(gets.length).toBe(200);
    expect(posts.length).toBe(0);
  });
});

describe("no shell — execFile-style array args (no shell interpolation)", () => {
  it("every gh invocation passes an args ARRAY, never a single shell command string", async () => {
    const { selectPrAdapter } = await loadAdapter();

    execImpls["gh"] = async (args) => {
      const argv = args as readonly string[];

      if (argv.includes("list")) return { stdout: "[]", stderr: "" };

      return {
        stdout: "https://github.com/org/repo/pull/1\n",
        stderr: "",
      };
    };

    const adapter = selectPrAdapter("github", {
      remoteUrl: "https://github.com/org/repo.git",
    });

    await adapter.createOrUpdatePr({ ...PR_ARGS });

    expect(execCalls.length).toBeGreaterThan(0);
    for (const call of execCalls) {
      expect(call.file).toBe("gh");
      // Args is an array of discrete tokens — NOT one shell string.
      expect(Array.isArray(call.args)).toBe(true);
      // Each element is its own argv token; the branch/title arrive as separate
      // tokens, never concatenated with shell metacharacters.
      expect((call.args as unknown[]).every((a) => typeof a === "string")).toBe(
        true,
      );
    }
  });
});
