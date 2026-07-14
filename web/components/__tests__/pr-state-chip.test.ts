import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PrStateChip,
  type PrStateChipLabels,
  type PrStateChipProps,
} from "@/components/pr-state-chip";

const labels: PrStateChipLabels = {
  open: "PR open",
  merged: "PR merged",
  closed: "PR closed",
  conflicts: "Conflicts",
  reopen: "Reopen PR",
};

function render(over: Partial<PrStateChipProps> = {}): string {
  return renderToStaticMarkup(
    createElement(PrStateChip, {
      prState: null,
      prHasConflicts: null,
      labels,
      ...over,
    }),
  );
}

describe("PrStateChip", () => {
  it("renders nothing when there is no PR state and no conflict", () => {
    expect(render({ prState: null, prHasConflicts: null })).toBe("");
    expect(render({ prState: null, prHasConflicts: false })).toBe("");
  });

  it("renders a neutral open chip", () => {
    const html = render({ prState: "open" });

    expect(html).toContain('data-testid="pr-state-chip"');
    expect(html).toContain('data-pr-state="open"');
    expect(html).toContain("PR open");
    expect(html).toContain("text-ink-2");
  });

  it("renders a green merged chip (success glyph, not the word Succeeded)", () => {
    const html = render({ prState: "merged" });

    expect(html).toContain('data-pr-state="merged"');
    expect(html).toContain("PR merged");
    expect(html).toContain("text-good");
    expect(html).not.toContain("Succeeded");
    // The green check glyph is an inline SVG, not a bare unicode tick.
    expect(html).toContain("<svg");
  });

  it("renders a muted closed chip", () => {
    const html = render({ prState: "closed" });

    expect(html).toContain('data-pr-state="closed"');
    expect(html).toContain("PR closed");
    expect(html).toContain("text-red-700");
  });

  it("renders the warning-toned conflicts variant with a disabled reopen affordance", () => {
    const html = render({ prState: "open", prHasConflicts: true });

    expect(html).toContain('data-pr-conflicts="true"');
    expect(html).toContain("Conflicts");
    expect(html).toContain("text-amber");
    // Reopen is present but disabled (Task 12 wires the action).
    expect(html).toContain('data-testid="pr-reopen"');
    expect(html).toContain("disabled");
    expect(html).toContain('aria-label="Reopen PR"');
    // Conflicts win over the state chip — no plain open chip alongside.
    expect(html).not.toContain('data-pr-state="open"');
  });
});
