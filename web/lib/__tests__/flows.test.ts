import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installFlowPlugin, isLocalDirectorySource } from "@/lib/flows";
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

describe("isLocalDirectorySource", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "isLocalDir-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("returns local for absolute path containing flow.yaml", async () => {
    const dir = join(workDir, "plugin");

    await mkdir(dir);
    await writeFile(
      join(dir, "flow.yaml"),
      "schemaVersion: 1\nname: x\nsteps: []\n",
    );

    const result = await isLocalDirectorySource(dir);

    expect(result).toEqual({ kind: "local", absPath: dir });
  });

  it("returns local for file:// URL containing flow.yaml", async () => {
    const dir = join(workDir, "plugin2");

    await mkdir(dir);
    await writeFile(
      join(dir, "flow.yaml"),
      "schemaVersion: 1\nname: x\nsteps: []\n",
    );

    const url = pathToFileURL(dir).href;
    const result = await isLocalDirectorySource(url);

    expect(result.kind).toBe("local");
    if (result.kind === "local") {
      expect(result.absPath).toBe(dir);
    }
  });

  it("returns git for https://github.com source", async () => {
    expect(await isLocalDirectorySource("https://github.com/org/repo")).toEqual(
      { kind: "git" },
    );
  });

  it("returns git for relative paths (shorthand rejected)", async () => {
    expect(await isLocalDirectorySource("./relative")).toEqual({ kind: "git" });
  });

  it("returns git for absolute path without flow.yaml", async () => {
    const dir = join(workDir, "noflow");

    await mkdir(dir);
    expect(await isLocalDirectorySource(dir)).toEqual({ kind: "git" });
  });
});
