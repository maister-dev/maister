import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isMaisterError } from "@/lib/errors";

const installFlowPluginMock = vi.fn();
const gitCloneMock = vi.fn();
const gitRevParseHeadMock = vi.fn();
const localDigestMock = vi.fn();
const installCapabilityRevisionMock = vi.fn();
const runSetupMock = vi.fn();

vi.mock("@/lib/flows", () => ({
  installFlowPlugin: (...a: unknown[]) => installFlowPluginMock(...a),
  gitClone: (...a: unknown[]) => gitCloneMock(...a),
  gitRevParseHead: (...a: unknown[]) => gitRevParseHeadMock(...a),
  localDirectoryContentDigest: (...a: unknown[]) => localDigestMock(...a),
}));

vi.mock("@/lib/capabilities/import", () => ({
  installCapabilityRevision: (...a: unknown[]) =>
    installCapabilityRevisionMock(...a),
  runCapabilityRevisionSetup: (...a: unknown[]) => runSetupMock(...a),
  resolveCapabilityTrust: (source: string) =>
    source.startsWith("file://") || source.startsWith("/")
      ? "trusted_by_policy"
      : "untrusted",
}));

vi.mock("@/lib/flows/trust", () => ({
  resolveTrust: (source: string) =>
    source.startsWith("file://") || source.startsWith("/")
      ? "trusted_by_policy"
      : "untrusted",
}));

import { installPackage } from "@/lib/packages/install";

const GIT_SHA = "1234567890abcdef1234567890abcdef12345678";
const DIGEST64 = "d".repeat(64);
const DIGEST40 = "d".repeat(40);

const FLOW_YAML = (name: string): string =>
  `schemaVersion: 1\nname: ${name}\nsteps:\n  - id: s1\n    type: cli\n    command: echo hi\n`;

let workDir: string;

async function buildFixturePackage(root: string): Promise<void> {
  await mkdir(join(root, "flows/a"), { recursive: true });
  await mkdir(join(root, "flows/b"), { recursive: true });
  await mkdir(join(root, "capability"), { recursive: true });
  await writeFile(join(root, "flows/a/flow.yaml"), FLOW_YAML("flow-a"), "utf8");
  await writeFile(join(root, "flows/b/flow.yaml"), FLOW_YAML("flow-b"), "utf8");
  await writeFile(join(root, "capability/README.md"), "bundle\n", "utf8");
  await writeFile(
    join(root, "maister-package.yaml"),
    `schemaVersion: 1
name: testpkg
flows:
  - { id: flow-a, path: flows/a }
  - { id: flow-b, path: flows/b }
capabilities:
  - { id: bundle, path: capability }
`,
    "utf8",
  );
}

const baseArgs = {
  projectId: "11111111-1111-1111-1111-111111111111",
  projectSlug: "demo-app",
  workspaceRoot: "/tmp/pkg-test-ws",
  db: {} as never,
};

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "pkg-install-test-"));
  vi.clearAllMocks();
  localDigestMock.mockResolvedValue(DIGEST64);
  gitRevParseHeadMock.mockResolvedValue(GIT_SHA);
  installFlowPluginMock.mockImplementation(async (args: any) => ({
    flowRowId: `row-${args.flowId}`,
    revisionId: `rev-${args.flowId}`,
    installedPath: `/cache/${args.flowId}`,
    symlinkPath: `/ws/${args.flowId}`,
    manifest: { name: args.flowId },
    revision: args.resolvedRevisionOverride,
    trustStatus: "trusted_by_policy",
    enablementState: "Enabled",
  }));
  installCapabilityRevisionMock.mockImplementation(async (opts: any) => ({
    importRowId: "imp-1",
    resolvedRevision: opts.resolvedRevisionOverride,
    installedPath: "/cache/cap",
    trustStatus: "trusted_by_policy",
    setupStatus: "pending",
  }));
  runSetupMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("installPackage (local source)", () => {
  it("installs every manifest flow + bundle with the package digest as override", async () => {
    await buildFixturePackage(workDir);

    const result = await installPackage({
      ...baseArgs,
      source: workDir,
      version: "aif/v9.9.9",
    });

    expect(installFlowPluginMock).toHaveBeenCalledTimes(2);
    const [firstArgs, firstTrust] = installFlowPluginMock.mock.calls[0]!;

    expect(firstArgs.source).toBe(pathToFileURL(join(workDir, "flows/a")).href);
    expect(firstArgs.flowId).toBe("flow-a");
    expect(firstArgs.version).toBe("aif-v9.9.9");
    expect(firstArgs.resolvedRevisionOverride).toBe(DIGEST40);
    expect(firstTrust).toBe("trusted_by_policy");

    expect(installCapabilityRevisionMock).toHaveBeenCalledTimes(1);
    expect(installCapabilityRevisionMock.mock.calls[0]![0]).toMatchObject({
      capabilityRefId: "bundle",
      version: "aif-v9.9.9",
      resolvedRevisionOverride: DIGEST40,
    });
    expect(runSetupMock).toHaveBeenCalledTimes(1);

    expect(result.name).toBe("testpkg");
    expect(result.resolvedRevision).toBe(DIGEST40);
    expect(result.versionLabel).toBe("aif-v9.9.9");
    expect(result.flows.map((f) => f.revision)).toEqual([DIGEST40, DIGEST40]);
    expect(result.capabilityDerived).toEqual([
      expect.objectContaining({
        id: "bundle",
        kind: "agent_definition",
        source: "flow-package",
        revision: DIGEST40,
      }),
    ]);
  });

  it("honors the path subdir variant", async () => {
    const pkgDir = join(workDir, "packages/aif");

    await mkdir(pkgDir, { recursive: true });
    await buildFixturePackage(pkgDir);

    const result = await installPackage({
      ...baseArgs,
      source: pathToFileURL(workDir).href,
      version: "local-dev",
      path: "packages/aif",
    });

    expect(result.versionLabel).toBe("local-dev");
    expect(installFlowPluginMock.mock.calls[0]![0].source).toBe(
      pathToFileURL(join(pkgDir, "flows/a")).href,
    );
  });

  it("throws CONFIG when a manifest flow id mismatches the flow.yaml name", async () => {
    await buildFixturePackage(workDir);
    await writeFile(
      join(workDir, "flows/a/flow.yaml"),
      FLOW_YAML("other-name"),
      "utf8",
    );

    await expect(
      installPackage({ ...baseArgs, source: workDir, version: "local-dev" }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        isMaisterError(e) &&
        e.code === "CONFIG" &&
        /does not match/.test(e.message),
    );
    expect(installFlowPluginMock).not.toHaveBeenCalled();
  });
});

describe("installPackage (git source)", () => {
  function mockCloneWithFixture(): { target: () => string } {
    let captured = "";

    gitCloneMock.mockImplementation(async (opts: any) => {
      captured = opts.target;
      const stage = join(workDir, "stage");

      await buildFixturePackage(stage);
      await cp(stage, opts.target, { recursive: true });
    });

    return { target: () => captured };
  }

  it("clones ONCE, passes the tag SHA as override, untrusted source defers setup, tmp removed", async () => {
    const clone = mockCloneWithFixture();

    const result = await installPackage({
      ...baseArgs,
      source: "github.com/org/maister-plugins",
      version: "testpkg/v1.0.0",
    });

    expect(gitCloneMock).toHaveBeenCalledTimes(1);
    expect(gitCloneMock.mock.calls[0]![0].version).toBe("testpkg/v1.0.0");
    expect(result.resolvedRevision).toBe(GIT_SHA);
    expect(
      installFlowPluginMock.mock.calls[0]![0].resolvedRevisionOverride,
    ).toBe(GIT_SHA);
    // Untrusted git package source: flow trust override + deferred bundle setup.
    expect(installFlowPluginMock.mock.calls[0]![1]).toBe("untrusted");
    expect(runSetupMock).not.toHaveBeenCalled();

    await expect(stat(clone.target())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes the tmp clone when a sub-install fails (rethrow preserved)", async () => {
    const clone = mockCloneWithFixture();

    installFlowPluginMock.mockRejectedValueOnce(new Error("boom"));

    await expect(
      installPackage({
        ...baseArgs,
        source: "github.com/org/maister-plugins",
        version: "testpkg/v1.0.0",
      }),
    ).rejects.toThrow(/boom/);

    await expect(stat(clone.target())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
