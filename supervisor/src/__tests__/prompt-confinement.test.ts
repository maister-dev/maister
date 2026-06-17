import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { contentBlockUriViolation } from "../prompt-confinement";

const roots = {
  worktreePath: "/srv/worktrees/proj/run-1",
  repoPath: "/srv/repos/proj",
  runDir: "/srv/.maister/proj/runs/run-1",
};

const fileLink = (absPath: string) => ({
  type: "resource_link",
  uri: pathToFileURL(absPath).href,
  name: path.basename(absPath),
});

describe("contentBlockUriViolation (supervisor URI confinement)", () => {
  it("allows a resource_link inside the worktree", () => {
    expect(
      contentBlockUriViolation(
        [{ type: "text", text: "see" }, fileLink("/srv/worktrees/proj/run-1/src/a.ts")],
        roots,
      ),
    ).toBeNull();
  });

  it("allows an uploaded file under the run dir", () => {
    expect(
      contentBlockUriViolation(
        [fileLink("/srv/.maister/proj/runs/run-1/uploads/launch/x.png")],
        roots,
      ),
    ).toBeNull();
  });

  it("allows a repo-absolute file_path reference", () => {
    expect(
      contentBlockUriViolation([fileLink("/srv/repos/proj/README.md")], roots),
    ).toBeNull();
  });

  it("rejects a file:// path outside the sandbox (e.g. /etc/passwd)", () => {
    expect(
      contentBlockUriViolation([fileLink("/etc/passwd")], roots),
    ).toMatch(/escapes the run sandbox/);
  });

  it("rejects a `..` traversal that escapes the worktree", () => {
    expect(
      contentBlockUriViolation(
        [{ type: "resource_link", uri: "file:///srv/worktrees/proj/run-1/../../../etc/shadow", name: "x" }],
        roots,
      ),
    ).toMatch(/escapes the run sandbox/);
  });

  it("rejects a remote-scheme resource_link (exfiltration vector)", () => {
    expect(
      contentBlockUriViolation(
        [{ type: "resource_link", uri: "http://evil.example/leak", name: "x" }],
        roots,
      ),
    ).toMatch(/must be a file: URI/);
  });

  it("does NOT widen the allow-set when repoPath is absent", () => {
    const noRepo = { worktreePath: roots.worktreePath, runDir: roots.runDir };

    expect(
      contentBlockUriViolation([fileLink("/srv/repos/proj/README.md")], noRepo),
    ).toMatch(/escapes the run sandbox/);
  });

  it("leaves a `resource` block with an inline (non-file) uri alone", () => {
    expect(
      contentBlockUriViolation(
        [{ type: "resource", resource: { uri: "urn:note:1", text: "inline" } }],
        roots,
      ),
    ).toBeNull();
  });

  it("confines a `resource` block that DOES carry a file: uri", () => {
    expect(
      contentBlockUriViolation(
        [{ type: "resource", resource: { uri: "file:///etc/passwd" } }],
        roots,
      ),
    ).toMatch(/escapes the run sandbox/);
  });

  it("is a no-op for a plain string prompt (no content blocks)", () => {
    expect(contentBlockUriViolation(undefined, roots)).toBeNull();
    expect(contentBlockUriViolation([{ type: "text", text: "hi" }], roots)).toBeNull();
  });
});
