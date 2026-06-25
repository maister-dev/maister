import type { LocalPackage } from "@/lib/db/schema";
import type { FlowAssistantAction } from "../protocol";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validateAndApplyFlowAssistantAction } from "../apply";
import { packageFileHash, validateFlowAssistantAction } from "../actions";
import { FLOW_ASSISTANT_ACTION_SCHEMA_VERSION } from "../protocol";

let tempRoot = "";
let previousRuntimeRoot: string | undefined;

describe("Flow assistant action validation and apply", () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "maister-flow-ai-"));
    previousRuntimeRoot = process.env.MAISTER_RUNTIME_ROOT;
    process.env.MAISTER_RUNTIME_ROOT = tempRoot;
  });

  afterEach(async () => {
    if (previousRuntimeRoot === undefined) {
      delete process.env.MAISTER_RUNTIME_ROOT;
    } else {
      process.env.MAISTER_RUNTIME_ROOT = previousRuntimeRoot;
    }
    await rm(tempRoot, { force: true, recursive: true });
  });

  it("applies a valid full-file upsert in place", async () => {
    const pkg = await createPackage({ "README.md": "old\n" });
    const action = actionFor({
      summary: "Update README",
      operations: [
        {
          op: "upsert_file",
          path: "README.md",
          baseHash: packageFileHash("old\n"),
          content: "new\n",
        },
      ],
    });

    const result = await validateAndApplyFlowAssistantAction({
      localPackage: pkg,
      runId: "run-1",
      action,
      assertCanApply: async () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(result.result.status).toBe("applied");
    await expect(
      readFile(path.join(pkg.workingDir, "README.md"), "utf8"),
    ).resolves.toBe("new\n");
  });

  it("rejects before writing when the write-time lock assertion fails", async () => {
    const pkg = await createPackage({ "README.md": "old\n" });
    const action = actionFor({
      summary: "Update README",
      operations: [
        {
          op: "upsert_file",
          path: "README.md",
          baseHash: packageFileHash("old\n"),
          content: "new\n",
        },
      ],
    });

    const result = await validateAndApplyFlowAssistantAction({
      localPackage: pkg,
      runId: "run-1",
      action,
      assertCanApply: async () => {
        throw new Error("lock gone");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.result.status).toBe("rejected");
    await expect(
      readFile(path.join(pkg.workingDir, "README.md"), "utf8"),
    ).resolves.toBe("old\n");
  });

  it("applies a canonical nested flow manifest path", async () => {
    const pkg = await createPackage({});
    const action = actionFor({
      summary: "Add generated flow",
      operations: [
        {
          op: "upsert_file",
          path: "flows/generated/flow.yaml",
          baseHash: null,
          content: validFlowYaml("generated"),
        },
      ],
    });

    const result = await validateAndApplyFlowAssistantAction({
      localPackage: pkg,
      runId: "run-1",
      action,
      assertCanApply: async () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(result.result.status).toBe("applied");
    await expect(
      readFile(
        path.join(pkg.workingDir, "flows", "generated", "flow.yaml"),
        "utf8",
      ),
    ).resolves.toContain("name: generated");
  });

  it("rejects stale base hashes before writing", async () => {
    const pkg = await createPackage({ "README.md": "current\n" });
    const action = actionFor({
      summary: "Update README",
      operations: [
        {
          op: "upsert_file",
          path: "README.md",
          baseHash: packageFileHash("old\n"),
          content: "new\n",
        },
      ],
    });

    const result = await validateFlowAssistantAction({
      localPackage: pkg,
      runId: "run-1",
      action,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result.status).toBe("stale");
    await expect(
      readFile(path.join(pkg.workingDir, "README.md"), "utf8"),
    ).resolves.toBe("current\n");
  });

  it("rejects path escapes before writing", async () => {
    const pkg = await createPackage({});
    const action = actionFor({
      summary: "Escape",
      operations: [
        {
          op: "upsert_file",
          path: "../outside.md",
          baseHash: null,
          content: "bad",
        },
      ],
    });

    const result = await validateFlowAssistantAction({
      localPackage: pkg,
      runId: "run-1",
      action,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result.status).toBe("rejected");
  });

  it("rejects invalid virtual package artifacts before writing", async () => {
    const pkg = await createPackage({});
    const action = actionFor({
      summary: "Add invalid flow",
      operations: [
        {
          op: "upsert_file",
          path: "flow.yaml",
          baseHash: null,
          content: "schemaVersion: nope\n",
        },
      ],
    });

    const result = await validateFlowAssistantAction({
      localPackage: pkg,
      runId: "run-1",
      action,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result.status).toBe("invalid");
    await expect(
      readFile(path.join(pkg.workingDir, "flow.yaml"), "utf8"),
    ).rejects.toThrow();
  });
});

async function createPackage(
  files: Record<string, string>,
): Promise<LocalPackage> {
  const workingDir = await mkdtemp(path.join(tempRoot, "pkg-"));

  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(workingDir, relPath);

    await writeFile(abs, content, "utf8");
  }

  return {
    id: "pkg-1",
    name: "Package",
    slug: "package",
    workingDir,
    status: "active",
    branchName: "main",
    sourceInstallId: null,
    sourceRepoUrl: null,
    sourceRef: null,
    lastCutInstallId: null,
    projectId: null,
    isDefault: false,
    lockedByUserId: null,
    lockedBySession: null,
    lockExpiresAt: null,
    createdBy: "user-1",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as LocalPackage;
}

function actionFor(args: {
  summary: string;
  operations: FlowAssistantAction["operations"];
}): FlowAssistantAction {
  return {
    schemaVersion: FLOW_ASSISTANT_ACTION_SCHEMA_VERSION,
    actionId: "act_test",
    summary: args.summary,
    operations: args.operations,
  };
}

function validFlowYaml(name: string): string {
  return `schemaVersion: 1
name: ${name}
steps:
  - id: s1
    type: cli
    command: echo hi
`;
}
