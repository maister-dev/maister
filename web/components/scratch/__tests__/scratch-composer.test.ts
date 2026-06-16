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
      onSend: noop,
      onRecover: noop,
    }),
  );
}

describe("ScratchComposer", () => {
  it("shows Send and an enabled textarea for WaitingForUser", () => {
    const html = render("WaitingForUser");

    expect(html).toContain('data-testid="scratch-composer-input"');
    expect(html).toContain('data-testid="scratch-composer-send"');
    expect(html).toContain("scratch.send");
    // The textarea is composable, so it is NOT disabled.
    expect(html).not.toMatch(/<textarea[^>]*disabled/);
  });

  it("shows Recover for a Crashed run", () => {
    expect(render("Crashed")).toContain("scratch.recover");
  });

  it("disables the textarea when the dialog is not composable", () => {
    expect(render("Running")).toMatch(/<textarea[^>]*disabled/);
  });

  it("renders quick replies when present", () => {
    const html = render("WaitingForUser", [
      { label: "Yes, proceed", value: "yes" },
    ]);

    expect(html).toContain("Yes, proceed");
  });
});
