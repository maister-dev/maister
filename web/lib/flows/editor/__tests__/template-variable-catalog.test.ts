import type { FlowYamlV1 } from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import {
  STATIC_TEMPLATE_VARIABLES,
  buildTemplateVariableCatalog,
} from "@/lib/flows/editor/template-variable-catalog";

type Entry = ReturnType<typeof buildTemplateVariableCatalog>["entries"][number];

function nodeManifest(nodes: FlowYamlV1["nodes"]): FlowYamlV1 {
  return { schemaVersion: 1, name: "Prompt assists", nodes } as FlowYamlV1;
}

function stepManifest(steps: FlowYamlV1["steps"]): FlowYamlV1 {
  return { schemaVersion: 1, name: "Legacy", steps } as FlowYamlV1;
}

function file(
  path: string,
  content: string,
): { path: string; content: string } {
  return { path, content };
}

function schema(fields: unknown[]): string {
  return JSON.stringify({ schemaVersion: 1, fields });
}

function byPath(entries: readonly Entry[]): Map<string, Entry> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

describe("buildTemplateVariableCatalog", () => {
  it("exposes static globals with executor.router optional and no env keys", () => {
    const catalog = buildTemplateVariableCatalog({
      manifest: nodeManifest([
        { id: "plan", type: "ai_coding", action: { prompt: "p" } },
        { id: "review", type: "human" },
      ]),
      selectedNodeId: "review",
      files: [],
    });
    const entries = byPath(catalog.entries);

    expect(STATIC_TEMPLATE_VARIABLES.map((entry) => entry.path)).toEqual([
      "task.id",
      "task.title",
      "task.prompt",
      "task.attemptNumber",
      "run.id",
      "run.attemptNumber",
      "run.projectSlug",
      "executor.id",
      "executor.agent",
      "executor.model",
      "executor.router",
    ]);
    expect(entries.get("executor.model")).toMatchObject({
      availability: "definite",
      presence: "required",
      insertText: "executor.model",
    });
    expect(entries.get("executor.router")).toMatchObject({
      availability: "definite",
      presence: "optional",
      insertText: "executor.router ?? ''",
    });
    expect(catalog.entries.some((entry) => entry.path.startsWith("env."))).toBe(
      false,
    );
  });

  it("classifies graph predecessors, schema fields, artifacts, and unavailable paths", () => {
    const catalog = buildTemplateVariableCatalog({
      manifest: nodeManifest([
        {
          id: "intake",
          type: "form",
          settings: { form_schema: "./schemas/intake.json" },
          transitions: { success: "branch" },
        },
        {
          id: "branch",
          type: "judge",
          action: { prompt: "decide" },
          transitions: { route_plan: "plan", skip: "review" },
        },
        {
          id: "plan",
          type: "ai_coding",
          action: { prompt: "plan" },
          output: {
            result: { schema: "./schemas/plan.json" },
            produces: [{ id: "plan_doc", kind: "plan" }],
          },
          transitions: { success: "review" },
        },
        { id: "review", type: "human", transitions: { approve: "done" } },
        { id: "done", type: "human" },
      ]),
      selectedNodeId: "review",
      files: [
        file(
          "schemas/intake.json",
          schema([
            {
              name: "request",
              type: "object",
              required: true,
              fields: [{ name: "id", type: "string", required: true }],
            },
            { name: "priority", type: "enum", options: ["high", "low"] },
          ]),
        ),
        file(
          "schemas/plan.json",
          schema([
            { name: "verdict", type: "string", required: true },
            { name: "notes", type: "string" },
          ]),
        ),
      ],
    });
    const entries = byPath(catalog.entries);

    expect(entries.get("steps.intake.output")).toMatchObject({
      availability: "definite",
      presence: "required",
      insertText: "steps.intake.output",
    });
    expect(entries.get("steps.intake.vars.request.id")).toMatchObject({
      availability: "definite",
      presence: "required",
      valueType: "string",
      insertText: "steps.intake.vars.request.id",
    });
    expect(entries.get("steps.intake.vars.priority")).toMatchObject({
      availability: "definite",
      presence: "optional",
      valueType: "enum",
      insertText: "steps.intake.vars.priority ?? ''",
    });
    expect(entries.get("steps.plan.vars.verdict")).toMatchObject({
      availability: "conditional",
      presence: "optional",
      insertText: "steps.plan.vars.verdict ?? ''",
    });
    expect(entries.get("steps.plan.exitCode")).toMatchObject({
      availability: "conditional",
      presence: "optional",
      insertText: "steps.plan.exitCode ?? ''",
    });
    expect(entries.get("artifacts.plan_doc.kind")).toMatchObject({
      availability: "conditional",
      presence: "optional",
    });
    expect(entries.get("artifacts.plan_doc.uri")).toMatchObject({
      availability: "conditional",
      presence: "optional",
      insertText: "artifacts.plan_doc.uri ?? ''",
    });
    expect(entries.has("steps.review.output")).toBe(false);
    expect(entries.has("steps.done.output")).toBe(false);
    expect(entries.has("artifacts.future_doc.kind")).toBe(false);
    expect(catalog.unavailablePaths).toContain("steps.review.output");
    expect(
      catalog.entries.findIndex(
        (entry) => entry.path === "steps.intake.vars.request.id",
      ),
    ).toBeLessThan(
      catalog.entries.findIndex((entry) => entry.path === "task.id"),
    );
  });

  it("discovers rework-only predecessors and exposes declared rework comments", () => {
    const catalog = buildTemplateVariableCatalog({
      manifest: nodeManifest([
        {
          id: "review",
          type: "human",
          rework: {
            allowedTargets: ["fix"],
            workspacePolicies: ["keep"],
            maxLoops: 2,
            commentsVar: "review_comments",
          },
        },
        { id: "fix", type: "ai_coding", action: { prompt: "fix" } },
      ]),
      selectedNodeId: "fix",
      files: [],
    });
    const entries = byPath(catalog.entries);

    expect(entries.get("steps.review.output")).toMatchObject({
      availability: "definite",
      presence: "required",
    });
    expect(entries.get("review_comments")).toMatchObject({
      availability: "conditional",
      presence: "optional",
      insertText: "review_comments ?? ''",
    });
  });

  it("degrades legacy steps to a predecessor chain", () => {
    const catalog = buildTemplateVariableCatalog({
      manifest: stepManifest([
        { id: "build", type: "cli", command: "pnpm test" },
        {
          id: "approval",
          type: "human",
          form_schema: "./schemas/approval.json",
        },
        {
          id: "agent",
          type: "agent",
          mode: "new-session",
          prompt: "ship it",
        },
      ]),
      selectedNodeId: "agent",
      files: [
        file(
          "schemas/approval.json",
          schema([{ name: "approved", type: "boolean", required: true }]),
        ),
      ],
    });
    const entries = byPath(catalog.entries);

    expect(entries.get("steps.build.exitCode")).toMatchObject({
      availability: "definite",
      presence: "required",
      insertText: "steps.build.exitCode",
    });
    expect(entries.get("steps.approval.exitCode")).toMatchObject({
      availability: "definite",
      presence: "optional",
      insertText: "steps.approval.exitCode ?? ''",
    });
    expect(entries.get("steps.approval.vars.approved")).toMatchObject({
      availability: "definite",
      presence: "required",
    });
    expect(entries.has("steps.agent.output")).toBe(false);
  });

  it("turns missing, invalid, and non-root schema refs into warnings", () => {
    const catalog = buildTemplateVariableCatalog({
      manifest: nodeManifest([
        {
          id: "plan",
          type: "ai_coding",
          action: { prompt: "p" },
          output: { result: { schema: "../secret.json" } },
          transitions: { success: "review" },
        },
        {
          id: "form",
          type: "form",
          settings: { form_schema: "./schemas/missing.json" },
          transitions: { success: "review" },
        },
        {
          id: "broken",
          type: "ai_coding",
          action: { prompt: "p" },
          output: { result: { schema: "./schemas/broken.json" } },
          transitions: { success: "review" },
        },
        { id: "review", type: "human" },
      ]),
      selectedNodeId: "review",
      files: [file("schemas/broken.json", JSON.stringify({ fields: "bad" }))],
    });
    const entries = byPath(catalog.entries);

    expect(entries.get("steps.plan.vars")).toMatchObject({
      path: "steps.plan.vars",
    });
    expect(catalog.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        "schema_ref_out_of_scope",
        "schema_missing",
        "schema_invalid",
      ]),
    );
    expect(entries.has("steps.plan.vars.secret")).toBe(false);
    expect(entries.has("steps.form.vars.approved")).toBe(false);
    expect(entries.has("steps.broken.vars.any")).toBe(false);
  });
});
