import { describe, expect, it } from "vitest";

import { MaisterError } from "@/lib/errors-core";
import { classifyGitError } from "@/lib/repo-source";

// ADR-093: clone-failure classification. The reason is advisory context on the
// unchanged PRECONDITION code; the UI maps it to a specific remediation.
describe("classifyGitError", () => {
  const cases: Array<[string, string]> = [
    [
      "SSH_AUTH",
      "git@gitverse.ru: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    ],
    ["SSH_HOSTKEY", "Host key verification failed."],
    [
      "SSH_HOSTKEY",
      "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@",
    ],
    [
      "HTTPS_AUTH",
      "fatal: Authentication failed for 'https://github.com/org/repo.git/'",
    ],
    [
      "HTTPS_AUTH",
      "fatal: unable to access 'https://github.com/org/repo.git/': The requested URL returned error: 403",
    ],
    [
      "NOT_FOUND",
      // not-found over SSH carries BOTH "repository not found" and "could not
      // read from remote repository" — NOT_FOUND must win over SSH_AUTH.
      "ERROR: Repository not found.\nfatal: Could not read from remote repository.",
    ],
    [
      "NOT_FOUND",
      "remote: Repository not found.\nfatal: repository 'https://github.com/org/gone.git/' not found",
    ],
    [
      "NETWORK",
      "fatal: unable to access 'https://github.com/org/repo.git/': Could not resolve host: github.com",
    ],
    ["NETWORK", "ssh: connect to host gitverse.ru port 22: Connection timed out"],
    ["UNKNOWN", "fatal: something entirely unexpected happened"],
  ];

  for (const [reason, stderr] of cases) {
    it(`classifies ${reason}`, () => {
      expect(classifyGitError(stderr)).toBe(reason);
    });
  }
});

describe("MaisterError details", () => {
  it("carries additive structured details", () => {
    const err = new MaisterError("PRECONDITION", "git clone failed", {
      details: { reason: "SSH_AUTH", detail: "Permission denied" },
    });

    expect(err.code).toBe("PRECONDITION");
    expect(err.details).toEqual({
      reason: "SSH_AUTH",
      detail: "Permission denied",
    });
  });

  it("leaves details undefined and preserves cause when not supplied", () => {
    const cause = new Error("boom");
    const err = new MaisterError("CONFIG", "x", { cause });

    expect(err.details).toBeUndefined();
    expect(err.cause).toBe(cause);
  });
});
