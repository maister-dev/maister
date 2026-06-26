import type { ReferenceSourceGroup } from "@/lib/flows/editor/reference-sources";
import type { ReactElement } from "react";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReferenceCombobox } from "@/components/flows/node-form/reference-combobox";
import {
  resolveFreeTextSourceKind,
  sourcePatchFromSelection,
} from "@/lib/flows/editor/reference-sources";

const GROUPS: ReferenceSourceGroup[] = [
  {
    label: "Runners",
    kind: "runner",
    options: [
      {
        value: "codex-main",
        label: "Codex Main",
        kind: "runner",
        hint: "codex - gpt-5 - default",
      },
    ],
  },
  {
    label: "Agents",
    kind: "agent",
    options: [
      {
        value: "delivery-kit:triager",
        label: "triager",
        kind: "agent",
        filePath: "maister-agents/triager.md",
      },
    ],
  },
];

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

function combobox(
  props: Partial<Parameters<typeof ReferenceCombobox>[0]> = {},
): ReactElement {
  return createElement(ReferenceCombobox, {
    value: "",
    groups: GROUPS,
    label: "Participant source",
    placeholder: "Pick or type",
    emptyHint: "No sources",
    readOnly: false,
    testid: "participant-source",
    onInputValue: () => undefined,
    onSelect: () => undefined,
    onUnknownKindChange: () => undefined,
    ...props,
  });
}

describe("ReferenceCombobox", () => {
  it("renders grouped options with group labels, option labels, and hints", () => {
    const html = render(combobox());

    expect(html).toContain("Participant source");
    expect(html).toContain("Pick or type");
    expect(html).toContain("Runners");
    expect(html).toContain("Codex Main");
    expect(html).toContain("codex - gpt-5 - default");
    expect(html).toContain("Agents");
    expect(html).toContain("triager");
  });

  it("disables the input and hides option buttons in read-only mode", () => {
    const html = render(combobox({ value: "codex-main", readOnly: true }));

    expect(html).toContain("codex-main");
    expect(html).toMatch(/disabled=""/);
    expect(html).not.toContain("<button");
  });

  it("renders the empty hint when every group is empty", () => {
    const html = render(
      combobox({
        groups: [
          { label: "Runners", kind: "runner", options: [] },
          { label: "Agents", kind: "agent", options: [] },
        ],
        emptyHint: "No package sources yet",
      }),
    );

    expect(html).toContain("No package sources yet");
  });

  it("renders unknown free-text toggles only when labels are supplied", () => {
    const withToggle = render(
      combobox({
        value: "fresh-source",
        unknownKind: "runner",
        asRunnerLabel: "as runner",
        asAgentLabel: "as agent",
      }),
    );
    const withoutToggle = render(
      combobox({ value: "fresh-source", unknownKind: "runner" }),
    );

    expect(withToggle).toContain("as runner");
    expect(withToggle).toContain("as agent");
    expect(withoutToggle).not.toContain("as runner");
    expect(withoutToggle).not.toContain("as agent");
  });

  it("keeps source selection intent in pure helper outputs", () => {
    const kind = resolveFreeTextSourceKind("delivery-kit:triager", {
      runners: new Set(["codex-main"]),
      agents: new Set(["delivery-kit:triager"]),
    });

    expect(sourcePatchFromSelection(kind, "delivery-kit:triager")).toEqual({
      agent: "delivery-kit:triager",
      runner: undefined,
    });
  });
});
