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

describe("installFlowPlugin — resolvedRevisionOverride boundary (ADR-087)", () => {
  it.each([
    ["non-hex", "zzz"],
    ["unknown sentinel", "unknown"],
  ])("rejects %s override with FLOW_INSTALL before any I/O", async (_l, override) => {
    await expectFlowInstallError(
      { ...baseArgs, resolvedRevisionOverride: override },
      /Invalid resolvedRevisionOverride/,
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

describe("installFlowPlugin — project role validation", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "flow-install-role-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("rejects a package that references a role outside the project registry", async () => {
    const pluginDir = join(workDir, "plugin");

    await mkdir(pluginDir);
    await writeFile(
      join(pluginDir, "flow.yaml"),
      `
schemaVersion: 1
name: Role guarded flow
compat:
  engine_min: "1.1.0"
nodes:
  - id: review
    type: human
    finish:
      human:
        role: reviewer
        decisions: [approve]
    transitions:
      approve: done
`,
      "utf8",
    );

    try {
      await installFlowPlugin({
        ...baseArgs,
        source: pluginDir,
        roleRefs: ["qa"],
        db: {},
      });
      throw new Error("expected installFlowPlugin to throw, but it resolved");
    } catch (err) {
      if (!isMaisterError(err)) throw err;
      expect(["CONFIG", "FLOW_INSTALL"]).toContain(err.code);
      expect(err.message).toMatch(/unknown .*role "reviewer"/i);
    }
  });

  it("keeps legacy packages compatible when no project role registry is supplied", async () => {
    const pluginDir = join(workDir, "legacy-plugin");

    await mkdir(pluginDir);
    await writeFile(
      join(pluginDir, "flow.yaml"),
      `
schemaVersion: 1
name: Legacy role flow
compat:
  engine_min: "1.1.0"
nodes:
  - id: review
    type: human
    finish:
      human:
        role: reviewer
        decisions: [approve]
    transitions:
      approve: done
`,
      "utf8",
    );

    await expect(
      installFlowPlugin({
        ...baseArgs,
        source: pluginDir,
        db: {
          insert: () => {
            throw new Error("db reached after manifest validation");
          },
        },
      }),
    ).rejects.toThrow(/db reached after manifest validation/);
  });
});
