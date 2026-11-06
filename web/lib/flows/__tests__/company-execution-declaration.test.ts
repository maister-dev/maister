import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { loadFlowManifest } from "@/lib/config";
import { flowYamlV1Schema } from "@/lib/config.schema";
import { flowYamlDiagnostics } from "@/lib/flows/authored-lint";

const result = { schema: "./schemas/diagnosis.json", required: true };
const producer = {
  id: "diagnose",
  type: "ai_coding",
  action: { prompt: "Report the observed diagnosis with its limitations." },
  output: { result },
  transitions: { success: "done" },
};
const manifest = {
  schemaVersion: 1,
  name: "Company result-only contract",
  compat: { engine_min: "3.12.0" },
  execution: { workspace: "none", completion: "result" },
  result: { export: { ...result, from: ["diagnose"] } },
  nodes: [producer],
};

describe("CBS-03 result-only execution declaration", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "company-flow-declaration-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("retains the declared contract through the actual loader and leaves legacy absence absent", async () => {
    const path = join(directory, "flow.yaml");

    await writeFile(path, stringify(manifest));
    expect((await loadFlowManifest(path)).execution).toEqual(
      manifest.execution,
    );
    const { execution: _execution, ...legacy } = manifest;

    await writeFile(
      path,
      stringify({ ...legacy, compat: { engine_min: "3.11.1" } }),
    );
    expect(await loadFlowManifest(path)).not.toHaveProperty("execution");
  });

  it.each([
    {
      type: "orchestrator",
      action: producer.action,
      settings: {
        delegation: {
          budget: {
            max_tokens: 2000,
            wall_clock_minutes: 2,
            max_child_runs: 2,
            consecutive_failures: 1,
          },
        },
      },
    },
    {
      type: "human",
      settings: { roles: ["operator"], decisions: ["approve"] },
    },
    {
      type: "form",
      settings: { form_schema: "./schemas/request.json", roles: ["operator"] },
    },
  ])("loads each supported coordinator or human node: $type", async (node) => {
    const path = join(directory, "flow.yaml");
    const value = {
      ...manifest,
      nodes: [
        { ...producer, transitions: { success: "next" } },
        {
          id: "next",
          ...node,
          transitions: { success: "done", approve: "done" },
        },
      ],
    };

    await writeFile(path, stringify(value));
    expect((await loadFlowManifest(path)).nodes[1].type).toBe(node.type);
  });

  it("allows explicit keep policies without changing repository checkpoint defaults", () => {
    const retry_policy = {
      attempts: 2,
      on_errors: ["SPAWN"],
      workspace: "keep",
    };
    const rework = {
      allowedTargets: ["diagnose"],
      workspacePolicies: ["keep"],
      maxLoops: 2,
    };

    expect(
      flowYamlV1Schema.safeParse({
        ...manifest,
        nodes: [{ ...producer, retry_policy, rework }],
      }).success,
    ).toBe(true);
  });

  it.each([
    null,
    { workspace: "none" },
    { workspace: "worktree", completion: "result" },
    { workspace: "none", completion: "review" },
    {
      workspace: "none",
      completion: "result",
      owner: { kind: "company", companyId: "untrusted" },
    },
  ])(
    "refuses a malformed or authority-bearing execution declaration: %j",
    (execution) => {
      expect(
        flowYamlV1Schema.safeParse({ ...manifest, execution }).success,
      ).toBe(false);
    },
  );

  it("refuses a lower declared floor at both loader and editor boundaries", async () => {
    const value = { ...manifest, compat: { engine_min: "3.11.1" } };
    const text = stringify(value);
    const path = join(directory, "flow.yaml");

    await writeFile(path, text);
    await expect(loadFlowManifest(path)).rejects.toMatchObject({
      code: "CONFIG",
    });
    expect(flowYamlDiagnostics(text)).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("3.12.0"),
      }),
    );
  });

  it.each([
    { result: undefined },
    { result: { export: { ...result, from: ["diagnose"], required: false } } },
    { nodes: [{ ...producer, type: "cli", action: { command: "true" } }] },
    { nodes: [{ ...producer, type: "judge" }] },
    {
      nodes: [
        {
          ...producer,
          settings: { context_repos: [{ project: "private-repo" }] },
        },
      ],
    },
    { nodes: [{ ...producer, settings: { workspaceAccess: "write" } }] },
    {
      nodes: [
        {
          ...producer,
          pre_finish: {
            gates: [{ id: "shell", kind: "command_check", command: "true" }],
          },
        },
      ],
    },
    {
      nodes: [
        { ...producer, retry_policy: { attempts: 2, on_errors: ["SPAWN"] } },
      ],
    },
    {
      nodes: [
        {
          ...producer,
          retry_policy: {
            attempts: 2,
            on_errors: ["SPAWN"],
            workspace: "fresh-attempt",
          },
        },
      ],
    },
    {
      nodes: [
        {
          ...producer,
          rework: {
            allowedTargets: ["diagnose"],
            workspacePolicies: ["keep", "rewind-to-node-checkpoint"],
            maxLoops: 2,
          },
        },
      ],
    },
    {
      nodes: [
        producer,
        {
          id: "review",
          type: "human",
          settings: { allowTakeover: true },
          transitions: { approve: "done" },
        },
      ],
    },
    {
      nodes: [
        producer,
        {
          id: "review",
          type: "human",
          settings: { allowFurtherTracks: true },
          transitions: { approve: "done" },
        },
      ],
    },
    { setup: "setup.sh" },
    { requirements: [{ name: "shell probe", probe: "true" }] },
    { mcps: ["project:database"] },
    ...[
      { mcps: ["project:database"] },
      { skills: ["project:skill"] },
      { restrictions: ["project:restriction"] },
      { tools: { claude: ["Read"] } },
      { permissionMode: "allow" },
      { enforcement: { tools: "instruct" } },
      { settingsProfile: "project:settings" },
    ].map((settings) => ({ nodes: [{ ...producer, settings }] })),
  ])(
    "refuses an unsupported lifecycle or repository capability before admission: %j",
    (change) => {
      expect(
        flowYamlV1Schema.safeParse({ ...manifest, ...change }).success,
      ).toBe(false);
    },
  );
});
