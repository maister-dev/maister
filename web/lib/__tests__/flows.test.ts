import { describe, expect, it } from "vitest";

import { installFlowPlugin } from "@/lib/flows";
import { isMaisterError } from "@/lib/errors";

const baseArgs = {
  source: "github.com/org/repo",
  version: "v1.0.0",
  projectId: "11111111-1111-1111-1111-111111111111",
  projectSlug: "demo-app",
  flowId: "bugfix",
  workspaceRoot: "/tmp/maister-flows-test-workspace",
};

async function expectFlowInstallError(
  args: Parameters<typeof installFlowPlugin>[0],
  match: RegExp,
): Promise<void> {
  try {
    await installFlowPlugin(args);
    throw new Error("expected installFlowPlugin to throw, but it resolved");
  } catch (err) {
    if (!isMaisterError(err)) throw err;
    expect(err.code).toBe("FLOW_INSTALL");
    expect(err.message).toMatch(match);
  }
}

describe("installFlowPlugin — boundary validation", () => {
  it("rejects path-traversal flowId before any I/O", async () => {
    await expectFlowInstallError(
      { ...baseArgs, flowId: "../escape" },
      /Invalid flowId/,
    );
  });

  it("rejects flowId equal to '..'", async () => {
    await expectFlowInstallError(
      { ...baseArgs, flowId: ".." },
      /Invalid flowId/,
    );
  });

  it("rejects empty flowId", async () => {
    await expectFlowInstallError({ ...baseArgs, flowId: "" }, /Invalid flowId/);
  });

  it("rejects path-traversal version", async () => {
    await expectFlowInstallError(
      { ...baseArgs, version: "../v" },
      /Invalid version/,
    );
  });

  it("rejects projectSlug that is not kebab-case", async () => {
    await expectFlowInstallError(
      { ...baseArgs, projectSlug: "PascalCase" },
      /Invalid projectSlug/,
    );
  });

  it("rejects source URL with shell metacharacters", async () => {
    await expectFlowInstallError(
      { ...baseArgs, source: "github.com;rm -rf /" },
      /Invalid source/,
    );
  });

  it("rejects source URL with whitespace", async () => {
    await expectFlowInstallError(
      { ...baseArgs, source: "github.com /org/repo" },
      /Invalid source/,
    );
  });

  it("rejects flowId longer than 64 chars", async () => {
    await expectFlowInstallError(
      { ...baseArgs, flowId: "a".repeat(65) },
      /Invalid flowId/,
    );
  });
});
