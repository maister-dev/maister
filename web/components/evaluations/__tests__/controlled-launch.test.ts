import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

import {
  BatchStatusStrip,
  buildRecipeDefinition,
  ControlledLaunch,
  csvRefs,
  LaunchDisabledReason,
  makeVariant,
  overlayChangeCount,
  PreflightPreviewList,
  toVerdictView,
  VariantEditorFields,
  type ControlledFlowScaffold,
  type ControlledLaunchContext,
  type ControlledRunnerOption,
  type VariantDraft,
} from "@/components/evaluations/controlled-launch";
import { evaluationRecipeDefinitionSchema } from "@/lib/evaluations/recipe-schema";

const scaffold: ControlledFlowScaffold = {
  flowRefId: "core:bugfix",
  flowRevisionId: "rev-1",
  inputContractDigest: "digest-in",
  artifactContractDigest: "digest-art",
  taskSnapshotRef: "task-1",
  slotKeys: ["session:default"],
  requiredSlotKeys: [],
};

const runnerOptions: ControlledRunnerOption[] = [
  {
    id: "runner-a",
    capabilityAgent: "claude",
    model: "claude-sonnet-4-6",
    ready: true,
  },
  { id: "runner-b", capabilityAgent: "codex", model: "gpt-5", ready: false },
];

describe("csvRefs", () => {
  it("trims, drops blanks, and dedupes", () => {
    expect(csvRefs("  a , b ,, a , c ")).toEqual(["a", "b", "c"]);
    expect(csvRefs("")).toEqual([]);
  });
});

describe("overlayChangeCount", () => {
  it("sums add + remove refs across all classes", () => {
    const v = makeVariant(1, "V");

    v.overlay.rules.add = "r1, r2";
    v.overlay.skills.remove = "s1";

    expect(overlayChangeCount(v.overlay)).toBe(3);
  });
});

describe("buildRecipeDefinition", () => {
  it("stamps the server scaffold's flow refs + digests and the forced hold", () => {
    const def = buildRecipeDefinition(
      scaffold,
      makeVariant(1, "Control"),
    ) as any;

    expect(def.schemaVersion).toBe(1);
    expect(def.flow.flowRefId).toBe("core:bugfix");
    expect(def.flow.flowRevisionId).toBe("rev-1");
    expect(def.flow.inputContractDigest).toBe("digest-in");
    expect(def.flow.artifactContractDigest).toBe("digest-art");
    expect(def.inputs.taskSnapshotRef).toBe("task-1");
    expect(def.executionPolicy.preset).toBe("supervised");
    expect(def.promotionHold.source).toBe("evaluation_study");
  });

  it("omits optional axes when unset (sparse payload)", () => {
    const def = buildRecipeDefinition(
      scaffold,
      makeVariant(1, "Control"),
    ) as any;

    expect(def.slotBindings).toBeUndefined();
    expect(def.capabilityOverlay).toBeUndefined();
    expect(def.materializationIntent).toBeUndefined();
    expect(def.flow.packageInstallId).toBeUndefined();
  });

  it("includes a hard-pin slot binding for a picked runner", () => {
    const variant: VariantDraft = {
      ...makeVariant(1, "Candidate"),
      slotRunners: { "session:default": "runner-a", "session:blank": "" },
    };
    const def = buildRecipeDefinition(scaffold, variant) as any;

    expect(def.slotBindings).toEqual({
      "session:default": { mode: "runner", runnerId: "runner-a" },
    });
  });

  it("includes overlay + package pin + materialization intent when set", () => {
    const variant: VariantDraft = {
      ...makeVariant(1, "Candidate"),
      packageInstallId: "install-9",
      overlay: {
        rules: { add: "rule-x", remove: "" },
        skills: { add: "", remove: "" },
        mcps: { add: "", remove: "" },
        subagents: { add: "", remove: "" },
      },
    };
    const def = buildRecipeDefinition(scaffold, variant) as any;

    expect(def.capabilityOverlay.rules.add).toEqual(["rule-x"]);
    expect(def.flow.packageInstallId).toBe("install-9");
    expect(def.materializationIntent.packagePins[0].packageInstallId).toBe(
      "install-9",
    );
  });

  it("produces a definition the strict recipe schema accepts", () => {
    const variant: VariantDraft = {
      ...makeVariant(1, "Candidate"),
      packageInstallId: "install-9",
      policyPreset: "assisted",
      slotRunners: { "session:default": "runner-a" },
      overlay: {
        rules: { add: "rule-x, rule-y", remove: "rule-z" },
        skills: { add: "", remove: "" },
        mcps: { add: "", remove: "" },
        subagents: { add: "", remove: "" },
      },
    };
    const def = buildRecipeDefinition(scaffold, variant);

    const parsed = evaluationRecipeDefinitionSchema.safeParse(def);

    expect(parsed.success).toBe(true);
  });
});

describe("toVerdictView", () => {
  it("reduces typed refusals/warnings to code-only view", () => {
    expect(
      toVerdictView({
        ok: false,
        refusals: [{ code: "flow_untrusted" }],
        warnings: [{ code: "slot_intent_soft_mismatch" }],
      }),
    ).toEqual({
      ok: false,
      refusalCodes: ["flow_untrusted"],
      warningCodes: ["slot_intent_soft_mismatch"],
    });
  });
});

describe("VariantEditorFields render contract", () => {
  function render(
    overrides: Partial<Parameters<typeof VariantEditorFields>[0]> = {},
  ) {
    return renderToStaticMarkup(
      createElement(VariantEditorFields, {
        variant: makeVariant(1, "Control"),
        scaffold,
        runnerOptions,
        pinOptions: [
          {
            packageInstallId: "install-9",
            packageName: "core",
            versionLabel: "v1.0.0",
            kind: "upstream",
          },
        ],
        overlayCatalog: {
          rules: ["rule-x"],
          skills: [],
          mcps: [],
          subagents: [],
        },
        canRemove: true,
        onChange: () => {},
        onRemove: () => {},
        ...overrides,
      }),
    );
  }

  it("renders every parity axis (runner slot, pin, policy, replicates, overlay)", () => {
    const markup = render();

    expect(markup).toContain("launch.variantLabel");
    // A per-slot runner picker keyed on the scaffold's slot key.
    expect(markup).toContain("launch.runnerFor");
    expect(markup).toContain("session:default");
    expect(markup).toContain("launch.packagePin");
    expect(markup).toContain("launch.policy");
    expect(markup).toContain("policy.supervised");
    expect(markup).toContain("launch.replicates");
    expect(markup).toContain("launch.overlay.rules.add");
    expect(markup).toContain("launch.overlay.subagents.remove");
  });

  it("shows the no-slots note when the Flow declares no pinnable slots", () => {
    const markup = render({ scaffold: { ...scaffold, slotKeys: [] } });

    expect(markup).toContain("launch.noSlots");
    expect(markup).not.toContain("launch.runnerFor");
  });
});

describe("PreflightPreviewList render contract", () => {
  it("renders localized refusal copy per variant (no raw codes/messages)", () => {
    const markup = renderToStaticMarkup(
      createElement(PreflightPreviewList, {
        labels: ["Control"],
        verdicts: [
          { ok: false, refusalCodes: ["flow_untrusted"], warningCodes: [] },
        ],
      }),
    );

    expect(markup).toContain("launch.previewHeading");
    expect(markup).toContain("preflight.refusal.flow_untrusted");
  });
});

describe("BatchStatusStrip render contract", () => {
  it("renders per-item chips and a retry control when an item failed", () => {
    const markup = renderToStaticMarkup(
      createElement(BatchStatusStrip, {
        batch: {
          id: "batch-1",
          status: "partial",
          items: [
            {
              id: "i1",
              recipeId: "r1",
              replicateOrdinal: 0,
              status: "launched",
              runId: "run-abcdef12",
              attempt: 1,
              errorReason: null,
            },
            {
              id: "i2",
              recipeId: "r2",
              replicateOrdinal: 0,
              status: "failed",
              runId: null,
              attempt: 2,
              errorReason: "spawn failed",
            },
          ],
        },
        retrying: false,
        onRetry: () => {},
      }),
    );

    expect(markup).toContain("launch.batch.partial");
    expect(markup).toContain("launch.item.launched");
    expect(markup).toContain("launch.item.failed");
    expect(markup).toContain("run-abcd");
    expect(markup).toContain("launch.retry");
  });

  it("hides retry when no item failed", () => {
    const markup = renderToStaticMarkup(
      createElement(BatchStatusStrip, {
        batch: {
          id: "batch-1",
          status: "completed",
          items: [
            {
              id: "i1",
              recipeId: "r1",
              replicateOrdinal: 0,
              status: "launched",
              runId: "run-1",
              attempt: 1,
              errorReason: null,
            },
          ],
        },
        retrying: false,
        onRetry: () => {},
      }),
    );

    expect(markup).not.toContain("launch.retry");
  });
});

describe("LaunchDisabledReason render contract", () => {
  it("renders the given reason key", () => {
    const markup = renderToStaticMarkup(
      createElement(LaunchDisabledReason, {
        reasonKey: "launch.disabledKillSwitch",
      }),
    );

    expect(markup).toContain("launch.disabledKillSwitch");
  });
});

describe("ControlledLaunch launch-precondition gating (M5)", () => {
  const baseContext: ControlledLaunchContext = {
    enabled: true,
    launchable: true,
    taskId: "task-1",
    scaffold,
    runnerOptions,
    overlayCatalog: { rules: [], skills: [], mcps: [], subagents: [] },
    existingRecipes: [],
  };

  function renderLaunch(ctx: Partial<ControlledLaunchContext>): string {
    return renderToStaticMarkup(
      createElement(ControlledLaunch, {
        slug: "proj",
        studyId: "study-1",
        context: { ...baseContext, ...ctx },
      }),
    );
  }

  it("disables the trigger with the kill-switch reason when controlled recipes are off", () => {
    const markup = renderLaunch({ enabled: false });

    expect(markup).toContain("launch.disabledKillSwitch");
  });

  it("disables the trigger with the status reason on a decided/archived study", () => {
    const markup = renderLaunch({ launchable: false });

    expect(markup).toContain("launch.disabledStatus");
    expect(markup).not.toContain("launch.disabledKillSwitch");
  });

  it("disables the trigger with the no-flow reason when the study has no launchable scaffold", () => {
    const markup = renderLaunch({ scaffold: null });

    expect(markup).toContain("launch.disabledNoFlow");
  });

  it("shows no disabled reason when every launch precondition holds", () => {
    const markup = renderLaunch({});

    expect(markup).not.toContain("launch.disabledKillSwitch");
    expect(markup).not.toContain("launch.disabledStatus");
    expect(markup).not.toContain("launch.disabledNoFlow");
  });
});
