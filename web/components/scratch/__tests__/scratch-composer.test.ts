// Render-only smoke test (createElement + renderToStaticMarkup, no jsdom),
// mirroring scratch-transcript.test.ts. next-intl is mocked to echo
// `namespace.key` so label wiring is asserted without a provider.
import type { ScratchDialogStatus } from "@/lib/scratch-runs/dialog";
import type { QuickReply } from "@/lib/scratch-runs/transcript";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) =>
    `${namespace}.${key}`,
}));

vi.mock("@/components/capabilities/capability-composer", () => ({
  CapabilityComposer: (props: {
    agent: string;
    catalog: readonly unknown[];
    disabled?: boolean;
    testId?: string;
    value: string;
  }) =>
    createElement("div", {
      "data-agent": props.agent,
      "data-catalog-count": props.catalog.length,
      "data-disabled": String(Boolean(props.disabled)),
      "data-testid": props.testId,
      "data-value": props.value,
    }),
}));

import { ScratchComposer } from "@/components/scratch/scratch-composer";

async function noop(): Promise<boolean> {
  return true;
}

function render(status: ScratchDialogStatus, quickReplies: QuickReply[] = []) {
  return renderToStaticMarkup(
    createElement(ScratchComposer, {
      status,
      pending: false,
      quickReplies,
      agent: "codex",
      catalog: [
        {
          kind: "skill",
          refId: "aif-plan",
          slug: "aif-plan",
          displayName: "AIF Plan",
          description: "Plan",
          argHint: null,
          canonicalToken: "@skill:aif-plan",
          surfaceForm: "$aif-plan",
          supported: true,
        },
      ],
      onSend: noop,
      onRecover: noop,
    }),
  );
}

describe("ScratchComposer", () => {
  it("shows Send and an enabled capability composer for WaitingForUser", () => {
    const html = render("WaitingForUser");

    expect(html).toContain('data-testid="scratch-message-composer"');
    expect(html).toContain('data-agent="codex"');
    expect(html).toContain('data-catalog-count="1"');
    expect(html).toContain('data-disabled="false"');
    expect(html).toContain('data-testid="scratch-composer-send"');
    expect(html).toContain("scratch.send");
    expect(html).not.toContain("<textarea");
  });

  it("shows Recover for a Crashed run", () => {
    expect(render("Crashed")).toContain("scratch.recover");
  });

  it("disables the capability composer when the dialog is not composable", () => {
    expect(render("Running")).toContain('data-disabled="true"');
  });

  it("renders quick replies when present", () => {
    const html = render("WaitingForUser", [
      { label: "Yes, proceed", value: "yes" },
    ]);

    expect(html).toContain("Yes, proceed");
  });
});
