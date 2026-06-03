import { describe, expect, it, vi } from "vitest";

import { MaisterError } from "@/lib/errors";

// =============================================================================
// M18 Phase 3 — security regression: a `pushBranch` failure must NOT leak a
// credential-bearing remote URL.
//
// `validateUrl` accepts `https://user:token@host/…` remotes, so git's
// `fatal: unable to access 'https://user:ghp_xxx@host/…'` stderr can carry a
// secret. `pushBranch` is the only new network git path; every sibling
// git-stderr path (cloneRepo, readRemoteOrigin) already runs redactUrl, and
// `pushBranch` was the lone omission. The thrown MaisterError.message is
// returned to the client + logged by the promote route, so it must be scrubbed.
//
// The git binary's OWN redaction of this message is version/build dependent, so
// this is a UNIT test: `promisify(execFile)` is mocked to reject with a stderr
// carrying a cred-bearing URL, proving our redactUrl wrapping — not git's — is
// what removes the secret.
// =============================================================================

const SECRET = "ghp_SUPERSECRETtoken9999";
const CRED_URL = `https://maister:${SECRET}@git.example.com/org/repo.git`;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");

  const impl = async (_file: string, _args: readonly string[]) => {
    // Mimic a failed `git push` whose stderr embeds the resolved cred-bearing
    // remote URL (the real leak surface).
    throw Object.assign(
      new Error(`Command failed: git push origin maister/feature`),
      {
        stderr: `fatal: unable to access '${CRED_URL}/': Could not resolve host\n`,
        code: 128,
      },
    );
  };

  const execFileMock = Object.assign(
    function execFile() {
      throw new Error("execFile callback form is not used by the helper");
    },
    { [promisify.custom]: impl },
  );

  return { ...actual, execFile: execFileMock };
});

async function loadWorktree() {
  return import("@/lib/worktree");
}

describe("pushBranch — credential redaction on failure", () => {
  it("throws EXECUTOR_UNAVAILABLE whose message scrubs the cred-bearing URL", async () => {
    const { pushBranch } = await loadWorktree();

    let thrown: unknown;

    try {
      await pushBranch({
        projectRepoPath: "/repos/demo",
        remote: "origin",
        branch: "maister/feature",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MaisterError);
    expect((thrown as MaisterError).code).toBe("EXECUTOR_UNAVAILABLE");
    // The assertion that FAILS without redactUrl(stderrText): the secret token
    // (the URL password) must be absent from the surfaced message.
    expect((thrown as Error).message).not.toContain(SECRET);
    // redactUrl replaces the password with *** while keeping the host actionable.
    expect((thrown as Error).message).toContain("***");
    expect((thrown as Error).message).toContain("git.example.com");
  });
});
