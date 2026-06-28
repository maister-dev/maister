import { describe, expect, it } from "vitest";

import {
  analyzeTemplateVariableUsage,
  type TemplateVariableCatalogResult,
  type TemplateVariableEntry,
} from "@/lib/flows/editor/template-variable-catalog";

function entry(
  path: string,
  overrides: Partial<TemplateVariableEntry> = {},
): TemplateVariableEntry {
  const availability = overrides.availability ?? "definite";
  const presence = overrides.presence ?? "required";

  return {
    path,
    label: path,
    source: "step",
    availability,
    presence,
    insertText:
      availability === "definite" && presence === "required"
        ? path
        : `${path} ?? ''`,
    ...overrides,
  };
}

function catalog(
  entries: TemplateVariableEntry[],
): TemplateVariableCatalogResult {
  return {
    entries,
    warnings: [],
    unavailablePaths: ["steps.current.output"],
  };
}

describe("analyzeTemplateVariableUsage", () => {
  it("finds known variable tokens and keeps definite required paths warning-free", () => {
    const result = analyzeTemplateVariableUsage(
      "Use {{ steps.plan.vars.verdict }} and @skill:aif-plan.",
      catalog([entry("steps.plan.vars.verdict")]),
    );

    expect(result.tokens).toEqual([
      expect.objectContaining({
        path: "steps.plan.vars.verdict",
        defaulted: false,
      }),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("treats guarded optional and conditional paths as safe", () => {
    const result = analyzeTemplateVariableUsage(
      "Use {{ steps.plan.vars.notes ?? '' }} and {{ artifacts.report.uri ?? \"\" }}",
      catalog([
        entry("steps.plan.vars.notes", { presence: "optional" }),
        entry("artifacts.report.uri", {
          availability: "conditional",
          presence: "optional",
          source: "artifact",
        }),
      ]),
    );

    expect(result.tokens.map((token) => token.path)).toEqual([
      "steps.plan.vars.notes",
      "artifacts.report.uri",
    ]);
    expect(result.tokens.every((token) => token.defaulted)).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("warns when optional or conditional paths are referenced bare", () => {
    const result = analyzeTemplateVariableUsage(
      "{{ executor.router }} {{ steps.branch.vars.verdict }}",
      catalog([
        entry("executor.router", { source: "global", presence: "optional" }),
        entry("steps.branch.vars.verdict", {
          availability: "conditional",
          presence: "optional",
        }),
      ]),
    );

    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "missing_default",
      "missing_default",
    ]);
  });

  it("ignores section syntax and does not treat skills or slash commands as variables", () => {
    const result = analyzeTemplateVariableUsage(
      "{{# steps.plan.vars.items }}{{/ steps.plan.vars.items }} @skill:aif-plan /aif-plan",
      catalog([entry("steps.plan.vars.items")]),
    );

    expect(result.tokens).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("warns for unknown and unavailable current-node paths", () => {
    const result = analyzeTemplateVariableUsage(
      "{{ steps.future.output }} {{ steps.current.output }}",
      catalog([]),
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "unknown_path",
        path: "steps.future.output",
        severity: "error",
      }),
      expect.objectContaining({
        code: "unavailable_path",
        path: "steps.current.output",
        severity: "warning",
      }),
    ]);
  });

  it("downgrades unenumerated env paths because runtime env keys are dynamic", () => {
    const result = analyzeTemplateVariableUsage("{{ env.LANG }}", catalog([]));

    expect(result.tokens).toEqual([
      expect.objectContaining({
        path: "env.LANG",
        defaulted: false,
      }),
    ]);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "unknown_path",
        path: "env.LANG",
        severity: "warning",
      }),
    ]);
  });

  it("classifies bare artifact variables with the same safety rules", () => {
    const result = analyzeTemplateVariableUsage(
      "{{ artifacts.plan_doc.uri }}",
      catalog([
        entry("artifacts.plan_doc.uri", {
          source: "artifact",
          availability: "conditional",
          presence: "optional",
        }),
      ]),
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "missing_default",
        path: "artifacts.plan_doc.uri",
      }),
    ]);
  });
});
