// T24/T25 (ADR-156): the cross-project reach grant on the attach/edit modal.
// Static render only (renderToStaticMarkup, no jsdom — project convention): the
// three properties under test are all render-time — the labelled control, the
// honest helper copy, and the INERT presentation on an attachment that is not
// enabled ("grantable now, ineffective later" is the defect this guards).

import type {
  AttachedAgentRow,
  AgentRecommendedView,
} from "@/components/board/panels/agents-attach-panel";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Resolve through the REAL catalog, and throw on a miss: a key that is not in
// `en.json` fails the render, so these cases double as proof that every key
// added for this axis is actually consumed by the component.
vi.mock("next-intl", () => ({
  useTranslations:
    (namespace: string) =>
    (key: string): string => {
      const catalog = en as unknown as Record<
        string,
        Record<string, string> | undefined
      >;
      const value = catalog[namespace]?.[key];

      if (value === undefined) {
        throw new Error(`missing en.json key: ${namespace}.${key}`);
      }

      return value;
    },
}));

import en from "@/messages/en.json";
import ru from "@/messages/ru.json";
import { AttachEditModal } from "@/components/board/panels/agents-attach-edit-modal";

const copy = en.agentsAttach as unknown as Record<string, string>;

const REACH_KEYS = [
  "crossProjectSection",
  "crossProjectToggle",
  "crossProjectAdmits",
  "crossProjectDenies",
  "crossProjectInert",
  "crossProjectActive",
] as const;

function buildRow(over?: {
  enabled?: boolean;
  crossProjectReach?: boolean;
}): AttachedAgentRow {
  const recommended: AgentRecommendedView | null = null;

  return {
    linkId: "link-1",
    enabled: over?.enabled ?? true,
    runnerOverrideId: null,
    branchBase: null,
    executionPolicyOverride: null,
    config: null,
    canReadBrain: false,
    canWriteBrain: false,
    memoryEnabled: false,
    crossProjectReach: over?.crossProjectReach ?? false,
    schedulesRevision: 1,
    schedules: [],
    agent: {
      id: "core:triager",
      name: "triager",
      packageName: "core",
      workspace: "none",
      mode: "session",
      triggers: ["manual"],
      riskTier: "read_only",
      enabled: true,
      quarantinedAt: null,
      flowRef: null,
      recommended,
      configSchema: null,
      effectiveMcps: [],
    },
  };
}

function render(row: AttachedAgentRow): string {
  return renderToStaticMarkup(
    createElement(AttachEditModal, {
      slug: "proj",
      row,
      runners: [],
      eventKinds: [],
      onClose() {},
      onSaved() {},
    }),
  );
}

// The `<label>` that wraps the reach checkbox — implicit label association is
// the property under test, so the assertion has to see them in ONE element.
function reachLabel(html: string): string {
  const match = html.match(
    /<label[^>]*>(?:(?!<\/label>)[\s\S])*data-testid="cross-project-reach"[\s\S]*?<\/label>/,
  );

  if (!match) throw new Error("reach checkbox is not inside a <label>");

  return match[0];
}

describe("AttachEditModal cross-project reach (ADR-156)", () => {
  it("renders the toggle inside its label, beside the memory axis", () => {
    const html = render(buildRow());

    expect(html).toContain('data-testid="cross-project-section"');
    expect(html).toContain(copy.crossProjectSection);

    const label = reachLabel(html);

    expect(label).toContain('type="checkbox"');
    expect(label).toContain(copy.crossProjectToggle);

    // "beside the memoryEnabled axis" — the Brain/memory block comes first.
    expect(html.indexOf('data-testid="brain-section"')).toBeLessThan(
      html.indexOf('data-testid="cross-project-section"'),
    );
  });

  it("names BOTH what the grant admits and what it never admits", () => {
    const html = render(buildRow());

    expect(html).toContain(copy.crossProjectAdmits);
    expect(html).toContain(copy.crossProjectDenies);
    // The admitted set is read + comment + relate…
    for (const admitted of [
      "read tasks",
      "create tasks",
      "comments",
      "relations",
    ]) {
      expect(copy.crossProjectAdmits).toContain(admitted);
    }
    // …and every deliberate exclusion is named, not implied by omission.
    for (const denied of [
      "runs",
      "triage",
      "editing existing tasks",
      "HITL",
      "catalogs",
      "Brain",
      "memory",
    ]) {
      expect(copy.crossProjectDenies).toContain(denied);
    }
  });

  it("renders INERT with its reason when the attachment is not enabled", () => {
    const html = render(buildRow({ enabled: false, crossProjectReach: true }));
    const label = reachLabel(html);

    expect(label).toContain("disabled");
    // Disabled WITH the reason, and never the live-grant affirmation.
    expect(html).toContain(copy.crossProjectInert);
    expect(html).not.toContain(copy.crossProjectActive);
    // The stored grant is still shown truthfully rather than faked to off.
    expect(label).toContain("checked");
  });

  it("stays editable and shows the live-grant check when the attachment is enabled", () => {
    const html = render(buildRow({ enabled: true, crossProjectReach: true }));
    const label = reachLabel(html);

    expect(label).not.toContain("disabled");
    expect(html).toContain(copy.crossProjectActive);
    expect(html).toContain("✓");
    expect(html).not.toContain(copy.crossProjectInert);
    // Async/state result is announced, not only coloured.
    expect(html).toContain('aria-live="polite"');
  });

  it("carries every reach key in EN and RU with real RU copy", () => {
    const enNs = en.agentsAttach as unknown as Record<string, string>;
    const ruNs = ru.agentsAttach as unknown as Record<string, string>;

    for (const key of REACH_KEYS) {
      expect(enNs[key], `en.agentsAttach.${key}`).toBeTruthy();
      expect(ruNs[key], `ru.agentsAttach.${key}`).toBeTruthy();
      expect(ruNs[key], `ru.agentsAttach.${key} is untranslated`).not.toBe(
        enNs[key],
      );
    }
  });
});
