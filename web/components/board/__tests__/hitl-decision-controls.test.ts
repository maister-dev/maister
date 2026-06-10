import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// CONTRACT under test — `components/board/hitl-decision-controls.tsx` (M17 P4).
//
// RED until the Implementor builds the pure presentational subcomponent.
// The component is PURE (no hooks, no state, no "use client" directive needed
// for renderToStaticMarkup compatibility). It receives typed props covering
// three HITL kinds: "permission", "form", and "human" (review). The signature
// is HitlDecisionControlsProps (defined below) with controlled input values,
// no-op handlers, and a labels bundle.
//
// The component renders:
// - criticality badge at top when criticality is set (low/medium/high/critical
//   with i18n labels run.criticalityLabel + run.criticality.{level}).
// - review branch (when reviewSchema present): comments textarea + decision
//   buttons (one per allowedDecisions) + dedicated "send back with comments"
//   button + confidence input (when showConfidence).
// - permission branch: option buttons (from options[]) + NO confidence input.
// - form/human branch: raw-JSON textarea + schema <details> + confidence input
//   (when showConfidence) + submit button.
// - confidence input: <input type="number" min={0} max={1} step={0.1}>.
// - `compact` class adds tighter spacing (e.g. textarea min-h-[60px] vs [90/120px]).
// - error line when error is set.
//
// NOTE ON FILE EXTENSION (.ts, not .tsx): vitest unit glob is
// components/**/__tests__/**/*.test.ts (NO .tsx). Collection is guaranteed
// by the workspace config in vitest.workspace.ts.
//
// This harness mocks next-intl (namespace.key echo) so i18n keys are asserted
// literally in the markup.
// ---------------------------------------------------------------------------

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

import {
  HitlDecisionControls,
  reviewLoopInfo,
} from "@/components/board/hitl-decision-controls";

import type { HitlOption } from "@/lib/queries/hitl";

const LABELS = {
  criticalityLabel: "run.criticalityLabel",
  "criticality.low": "run.criticality.low",
  "criticality.medium": "run.criticality.medium",
  "criticality.high": "run.criticality.high",
  "criticality.critical": "run.criticality.critical",
  confidenceLabel: "run.confidenceLabel",
  reviewComments: "run.reviewComments",
  decisionApprove: "run.decisionApprove",
  decisionRework: "run.decisionRework",
  sendBackWithComments: "run.sendBackWithComments",
  responseLabel: "run.responseLabel",
  responseHint: "run.responseHint",
  schemaLabel: "run.schemaLabel",
  submit: "run.submit",
  reviewCommentsPlaceholder: "run.reviewCommentsPlaceholder",
  formInstructions: "run.formInstructions",
  formCustomPlaceholder: "run.formCustomPlaceholder",
};

type ControlsProps = Parameters<typeof HitlDecisionControls>[0];

function render(over: Partial<ControlsProps> = {}): string {
  const base: ControlsProps = {
    kind: "form",
    reviewSchema: null,
    options: [],
    schema: null,
    criticality: null,
    showConfidence: false,
    confidence: "",
    comments: "",
    jsonValue: "{}",
    formValues: {},
    disabled: false,
    error: null,
    labels: LABELS,
    onConfidenceChange: vi.fn(),
    onCommentsChange: vi.fn(),
    onJsonChange: vi.fn(),
    onFormFieldChange: vi.fn(),
    onDecision: vi.fn(),
    onSendBack: vi.fn(),
    onOption: vi.fn(),
    onSubmitJson: vi.fn(),
    onSubmitForm: vi.fn(),
  };

  return renderToStaticMarkup(
    createElement(HitlDecisionControls, { ...base, ...over }),
  );
}

describe("HitlDecisionControls — pure HITL response rendering (M17 P4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("criticality badge", () => {
    it("renders the criticality badge when criticality is set to 'low'", () => {
      const html = render({ criticality: "low" });

      expect(html).toContain("run.criticalityLabel");
      expect(html).toContain("run.criticality.low");
    });

    it("renders the criticality badge when criticality is set to 'medium'", () => {
      const html = render({ criticality: "medium" });

      expect(html).toContain("run.criticality.medium");
    });

    it("renders the criticality badge when criticality is set to 'high'", () => {
      const html = render({ criticality: "high" });

      expect(html).toContain("run.criticality.high");
    });

    it("renders the criticality badge when criticality is set to 'critical'", () => {
      const html = render({ criticality: "critical" });

      expect(html).toContain("run.criticality.critical");
    });

    it("does not render the criticality badge when criticality is null", () => {
      const html = render({ criticality: null });

      // The criticalityLabel should not appear if there's no criticality.
      expect(html).not.toContain("run.criticalityLabel");
    });
  });

  describe("review branch (human review HITL)", () => {
    it("renders a button for each allowedDecision", () => {
      const reviewSchema = {
        allowedDecisions: ["approve", "rework"],
        transitions: { rework: "rework-target" },
        reworkTargets: ["rework-target"],
        workspacePolicies: [],
      };

      const html = render({ kind: "human", reviewSchema });

      expect(html).toContain("run.decisionApprove");
      expect(html).toContain("run.decisionRework");
    });

    it("renders the comments textarea", () => {
      const reviewSchema = {
        allowedDecisions: ["approve"],
        transitions: {},
        reworkTargets: [],
        workspacePolicies: [],
      };

      const html = render({
        kind: "human",
        reviewSchema,
        comments: "looks good",
      });

      expect(html).toContain("run.reviewComments");
      expect(html).toContain("looks good");
    });

    it("renders the confidence input when showConfidence is true", () => {
      const reviewSchema = {
        allowedDecisions: ["approve"],
        transitions: {},
        reworkTargets: [],
        workspacePolicies: [],
      };

      const html = render({
        kind: "human",
        reviewSchema,
        showConfidence: true,
        confidence: "0.8",
      });

      expect(html).toContain("run.confidenceLabel");
      expect(html).toContain("0.8");
      // Should have a number input with min/max.
      expect(html).toContain('type="number"');
      expect(html).toContain('min="0"');
      expect(html).toContain('max="1"');
    });

    it("does not render the confidence input when showConfidence is false", () => {
      const reviewSchema = {
        allowedDecisions: ["approve"],
        transitions: {},
        reworkTargets: [],
        workspacePolicies: [],
      };

      const html = render({
        kind: "human",
        reviewSchema,
        showConfidence: false,
      });

      // The label and input should not be present.
      expect(html).not.toContain("run.confidenceLabel");
    });

    it("renders the dedicated send-back-with-comments button", () => {
      const reviewSchema = {
        allowedDecisions: ["approve"],
        transitions: {},
        reworkTargets: [],
        workspacePolicies: [],
      };

      const html = render({
        kind: "human",
        reviewSchema,
      });

      expect(html).toContain("run.sendBackWithComments");
    });
  });

  describe("permission branch", () => {
    it("renders option buttons", () => {
      const options: HitlOption[] = [
        { optionId: "allow", label: "Allow this request" },
        { optionId: "deny", label: "Deny" },
      ];

      const html = render({
        kind: "permission",
        options,
      });

      expect(html).toContain("Allow this request");
      expect(html).toContain("Deny");
    });

    it("does NOT render a confidence input for permission", () => {
      const options: HitlOption[] = [
        { optionId: "allow", label: "Allow this request" },
      ];

      const html = render({
        kind: "permission",
        options,
        showConfidence: true, // Even if true, permission ignores it.
        confidence: "0.9",
      });

      // Confidence input and label should not appear.
      expect(html).not.toContain("run.confidenceLabel");
    });
  });

  describe("form/human branch (structured form)", () => {
    it("renders the JSON textarea", () => {
      const html = render({
        kind: "form",
        jsonValue: '{"key": "value"}',
      });

      expect(html).toContain("run.responseLabel");
      // The textarea is the editing surface; renderToStaticMarkup HTML-encodes
      // its value, so assert the textarea + the (decoded-equivalent) key/value
      // words rather than the raw quoted JSON.
      expect(html).toContain('id="hitl-json-response"');
      expect(html).toContain("key");
      expect(html).toContain("value");
    });

    it("renders the schema <details> block when schema is not null", () => {
      const schema = {
        type: "object",
        properties: { name: { type: "string" } },
      };

      const html = render({
        kind: "form",
        schema,
      });

      expect(html).toContain("<details");
      expect(html).toContain("run.schemaLabel");
      // The schema is JSON-stringified inside the <pre> (React HTML-encodes the
      // quotes); assert the field words, which survive encoding.
      expect(html).toContain("type");
      expect(html).toContain("object");
    });

    it("does not render the schema <details> when schema is null", () => {
      const html = render({
        kind: "form",
        schema: null,
      });

      expect(html).not.toContain("<details");
      expect(html).not.toContain("run.schemaLabel");
    });

    it("renders the confidence input when showConfidence is true", () => {
      const html = render({
        kind: "form",
        showConfidence: true,
        confidence: "0.5",
      });

      expect(html).toContain("run.confidenceLabel");
      expect(html).toContain("0.5");
    });

    it("does not render the confidence input when showConfidence is false", () => {
      const html = render({
        kind: "form",
        showConfidence: false,
      });

      expect(html).not.toContain("run.confidenceLabel");
    });

    it("renders the submit button", () => {
      const html = render({
        kind: "form",
      });

      expect(html).toContain("run.submit");
    });
  });

  describe("form structured-options branch (T4 intake)", () => {
    const intakeSchema = {
      schemaVersion: 1,
      fields: [
        {
          name: "tests",
          label: "Tests",
          type: "string",
          options: ["yes", "no"],
          required: true,
        },
        {
          name: "logging",
          label: "Logging",
          type: "string",
          options: ["verbose", "minimal"],
          required: true,
        },
      ],
    };

    it("renders an option button for each field option", () => {
      const html = render({ kind: "form", schema: intakeSchema });

      expect(html).toContain(">yes<");
      expect(html).toContain(">no<");
      expect(html).toContain(">verbose<");
      expect(html).toContain(">minimal<");
    });

    it("renders the author-provided field label for each field", () => {
      const html = render({ kind: "form", schema: intakeSchema });

      expect(html).toContain("Tests");
      expect(html).toContain("Logging");
    });

    it("renders the instructions line and a free-text input per field", () => {
      const html = render({ kind: "form", schema: intakeSchema });

      expect(html).toContain("run.formInstructions");
      expect(html).toContain('id="hitl-form-field-tests"');
      expect(html).toContain('id="hitl-form-field-logging"');
    });

    it("does NOT render the raw JSON textarea for an options form", () => {
      const html = render({ kind: "form", schema: intakeSchema });

      expect(html).not.toContain('id="hitl-json-response"');
    });

    it("carries the controlled field value into its input", () => {
      const html = render({
        kind: "form",
        schema: intakeSchema,
        formValues: { tests: "yes" },
      });

      expect(html).toContain('value="yes"');
    });

    it("does NOT render a confidence input for an options form", () => {
      const html = render({
        kind: "form",
        schema: intakeSchema,
        showConfidence: true,
        confidence: "0.5",
      });

      expect(html).not.toContain("run.confidenceLabel");
    });

    it("renders the submit button for an options form", () => {
      const html = render({ kind: "form", schema: intakeSchema });

      expect(html).toContain("run.submit");
    });

    it("falls back to the JSON textarea when the schema declares no fields", () => {
      const html = render({ kind: "form", schema: { type: "object" } });

      expect(html).toContain('id="hitl-json-response"');
    });
  });

  describe("compact mode", () => {
    it("renders a compact-only CSS class when compact is true", () => {
      const html = render({
        kind: "form",
        compact: true,
      });

      // The component should apply a "compact" variant or class that tightens
      // spacing. We assert that a specific tight class is present (e.g., min-h-[60px])
      // that is NOT in non-compact mode.
      expect(html).toContain("min-h-[60px]");
    });

    it("does not include the compact tight spacing when compact is false/undefined", () => {
      const html = render({
        kind: "form",
        compact: false,
      });

      // In non-compact form, the textarea should have a larger min-height.
      expect(html).toContain("min-h-[120px]");
    });
  });

  describe("error handling", () => {
    it("renders the error line when error is set", () => {
      const html = render({
        kind: "form",
        error: "This field is required",
      });

      expect(html).toContain("This field is required");
    });

    it("does not render an error line when error is null", () => {
      const html = render({
        kind: "form",
        error: null,
      });

      // No error text should appear. (This is a bit loose, but the key is
      // that we don't surface error markup for a null error.)
      // We can assert that a specific error role or class is absent.
      expect(html).not.toContain('role="alert"'); // If the component uses this.
    });
  });

  describe("controlled values", () => {
    it("carries the comments value in the textarea", () => {
      const reviewSchema = {
        allowedDecisions: ["approve"],
        transitions: {},
        reworkTargets: [],
        workspacePolicies: [],
      };

      const html = render({
        kind: "human",
        reviewSchema,
        comments: "Great work, ship it!",
      });

      expect(html).toContain("Great work, ship it!");
    });

    it("carries the jsonValue in the form textarea", () => {
      const html = render({
        kind: "form",
        jsonValue: '{"status": "approved"}',
      });

      // React HTML-encodes the textarea value; assert the textarea + the
      // (encoding-surviving) status/approved words rather than raw quoted JSON.
      expect(html).toContain('id="hitl-json-response"');
      expect(html).toContain("status");
      expect(html).toContain("approved");
    });

    it("carries the confidence value in the input", () => {
      const html = render({
        kind: "form",
        showConfidence: true,
        confidence: "0.75",
      });

      expect(html).toContain('value="0.75"');
    });
  });

  describe("disabled state", () => {
    it("disables buttons when disabled is true", () => {
      const options: HitlOption[] = [{ optionId: "allow", label: "Allow" }];

      const html = render({
        kind: "permission",
        options,
        disabled: true,
      });

      expect(html).toContain("disabled");
    });

    it("does not disable buttons when disabled is false", () => {
      const options: HitlOption[] = [{ optionId: "allow", label: "Allow" }];

      const html = render({
        kind: "permission",
        options,
        disabled: false,
      });

      // The disabled attribute should not be present on buttons.
      const buttonCount = (html.match(/<button[^>]*>/g) || []).length;
      const disabledCount = (html.match(/<button[^>]*disabled[^>]*>/g) || [])
        .length;

      expect(disabledCount).toBe(0);
      expect(buttonCount).toBeGreaterThan(0);
    });
  });
});

// ---------------------------------------------------------------------------
// ADR-071 Task 13 — review-gate panel: loop chip, exhaustion boundary,
// approve soft-warn, unresolved/outdated count badges.
//
// All additions are OPTIONAL (props + labels): every pre-existing case above
// renders without them and stays green. The boundary semantics mirror
// `lib/flows/hitl-validate.ts` (frozen docs): total allowed gate visits =
// maxLoops + 1; rework is disabled when gateAttempt > maxLoops; the chip is
// "Rework loop N of M" with N = gateAttempt, M = maxLoops + 1. Approve is
// NEVER blocked — open threads only soft-warn.
// ---------------------------------------------------------------------------

const PANEL_LABELS = {
  ...LABELS,
  reviewOpenCount: "$count unresolved",
  reviewOutdatedCount: "$count outdated",
  reviewLoopChip: "Rework loop $n of $m",
  reviewApproveOpenWarn: "$count open threads stay unresolved on approve",
  reviewReworkExhausted: "rework limit reached: all $m review visits used",
};

const REVIEW_SCHEMA_BASE = {
  allowedDecisions: ["approve", "rework"],
  transitions: { approve: "done", rework: "implement" },
  reworkTargets: ["implement"],
  workspacePolicies: ["keep"],
};

// The opening tag of the <button> whose text content contains `label`.
function buttonTagFor(html: string, label: string): string {
  const idx = html.indexOf(label);

  expect(idx).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", idx);

  expect(start).toBeGreaterThan(-1);

  return html.slice(start, html.indexOf(">", start) + 1);
}

describe("HitlDecisionControls — review gate panel (ADR-071 Task 13)", () => {
  describe("rework-loop chip", () => {
    it("renders 'Rework loop N of M' with N = gateAttempt and M = maxLoops + 1", () => {
      const html = render({
        kind: "human",
        reviewSchema: { ...REVIEW_SCHEMA_BASE, maxLoops: 3, gateAttempt: 2 },
        labels: PANEL_LABELS,
      });

      expect(html).toContain("Rework loop 2 of 4");
    });

    it("renders the boundary visit as N = M", () => {
      const html = render({
        kind: "human",
        reviewSchema: { ...REVIEW_SCHEMA_BASE, maxLoops: 2, gateAttempt: 3 },
        labels: PANEL_LABELS,
      });

      expect(html).toContain("Rework loop 3 of 3");
    });

    it("renders no chip when the node declares no rework (maxLoops null)", () => {
      const html = render({
        kind: "human",
        reviewSchema: {
          ...REVIEW_SCHEMA_BASE,
          maxLoops: null,
          gateAttempt: 1,
        },
        labels: PANEL_LABELS,
      });

      expect(html).not.toContain("Rework loop");
    });

    it("renders no chip for a legacy schema without the loop fields", () => {
      const html = render({
        kind: "human",
        reviewSchema: { ...REVIEW_SCHEMA_BASE },
        labels: PANEL_LABELS,
      });

      expect(html).not.toContain("Rework loop");
    });
  });

  describe("exhaustion boundary (gateAttempt > maxLoops)", () => {
    it("disables the rework decision and the send-back button with a translated reason", () => {
      const html = render({
        kind: "human",
        reviewSchema: { ...REVIEW_SCHEMA_BASE, maxLoops: 1, gateAttempt: 2 },
        labels: PANEL_LABELS,
      });

      expect(buttonTagFor(html, "run.decisionRework")).toContain("disabled");
      expect(buttonTagFor(html, "run.sendBackWithComments")).toContain(
        "disabled",
      );
      expect(html).toContain("rework limit reached: all 2 review visits used");
    });

    it("never disables approve at the boundary", () => {
      const html = render({
        kind: "human",
        reviewSchema: { ...REVIEW_SCHEMA_BASE, maxLoops: 1, gateAttempt: 2 },
        labels: PANEL_LABELS,
      });

      expect(buttonTagFor(html, "run.decisionApprove")).not.toContain(
        "disabled",
      );
    });

    it("keeps rework enabled on the last allowed pass (gateAttempt = maxLoops)", () => {
      const html = render({
        kind: "human",
        reviewSchema: { ...REVIEW_SCHEMA_BASE, maxLoops: 2, gateAttempt: 2 },
        labels: PANEL_LABELS,
      });

      expect(buttonTagFor(html, "run.decisionRework")).not.toContain(
        "disabled",
      );
      expect(buttonTagFor(html, "run.sendBackWithComments")).not.toContain(
        "disabled",
      );
      expect(html).not.toContain("rework limit reached");
    });

    it("applies no boundary for a legacy schema without the loop fields", () => {
      const html = render({
        kind: "human",
        reviewSchema: { ...REVIEW_SCHEMA_BASE },
        labels: PANEL_LABELS,
      });

      expect(buttonTagFor(html, "run.decisionRework")).not.toContain(
        "disabled",
      );
    });
  });

  describe("approve soft-warn with open threads", () => {
    it("renders the warn when open threads exist and keeps approve enabled", () => {
      const html = render({
        kind: "human",
        reviewSchema: { ...REVIEW_SCHEMA_BASE },
        labels: PANEL_LABELS,
        reviewCounts: { openCount: 2, outdatedCount: 0 },
      });

      expect(html).toContain("2 open threads stay unresolved on approve");
      expect(buttonTagFor(html, "run.decisionApprove")).not.toContain(
        "disabled",
      );
    });

    it("renders no warn when zero threads are open", () => {
      const html = render({
        kind: "human",
        reviewSchema: { ...REVIEW_SCHEMA_BASE },
        labels: PANEL_LABELS,
        reviewCounts: { openCount: 0, outdatedCount: 0 },
      });

      expect(html).not.toContain("open threads stay unresolved");
    });

    it("renders no warn when counts are not provided (board/inbox consumers)", () => {
      const html = render({
        kind: "human",
        reviewSchema: { ...REVIEW_SCHEMA_BASE },
        labels: PANEL_LABELS,
      });

      expect(html).not.toContain("open threads stay unresolved");
    });
  });

  describe("count badges", () => {
    it("renders unresolved and outdated badges with their counts", () => {
      const html = render({
        kind: "human",
        reviewSchema: { ...REVIEW_SCHEMA_BASE },
        labels: PANEL_LABELS,
        reviewCounts: { openCount: 3, outdatedCount: 2 },
      });

      expect(html).toContain("3 unresolved");
      expect(html).toContain("2 outdated");
    });

    it("hides each badge when its count is zero", () => {
      const html = render({
        kind: "human",
        reviewSchema: { ...REVIEW_SCHEMA_BASE },
        labels: PANEL_LABELS,
        reviewCounts: { openCount: 0, outdatedCount: 0 },
      });

      expect(html).not.toContain("unresolved");
      expect(html).not.toContain("outdated");
    });
  });
});

describe("reviewLoopInfo — pure boundary helper (mirrors hitl-validate)", () => {
  it("returns null for a null schema", () => {
    expect(reviewLoopInfo(null)).toBeNull();
  });

  it("returns null when maxLoops is null (no rework declared)", () => {
    expect(
      reviewLoopInfo({ ...REVIEW_SCHEMA_BASE, maxLoops: null, gateAttempt: 1 }),
    ).toBeNull();
  });

  it("returns null for legacy schemas without the loop fields", () => {
    expect(reviewLoopInfo({ ...REVIEW_SCHEMA_BASE })).toBeNull();
    expect(reviewLoopInfo({ ...REVIEW_SCHEMA_BASE, maxLoops: 2 })).toBeNull();
    expect(
      reviewLoopInfo({ ...REVIEW_SCHEMA_BASE, gateAttempt: 1 }),
    ).toBeNull();
  });

  it("is not exhausted below and at the last allowed pass", () => {
    expect(
      reviewLoopInfo({ ...REVIEW_SCHEMA_BASE, maxLoops: 2, gateAttempt: 1 }),
    ).toEqual({ gateAttempt: 1, totalVisits: 3, exhausted: false });
    expect(
      reviewLoopInfo({ ...REVIEW_SCHEMA_BASE, maxLoops: 2, gateAttempt: 2 }),
    ).toEqual({ gateAttempt: 2, totalVisits: 3, exhausted: false });
  });

  it("is exhausted strictly above maxLoops (gateAttempt > maxLoops)", () => {
    expect(
      reviewLoopInfo({ ...REVIEW_SCHEMA_BASE, maxLoops: 2, gateAttempt: 3 }),
    ).toEqual({ gateAttempt: 3, totalVisits: 3, exhausted: true });
  });
});
