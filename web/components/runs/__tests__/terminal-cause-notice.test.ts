// B6 (ADR-177 amendment 2026-09-26), T4.3: the run page names why a run ended,
// composed from the cause's code and reason copy — never a raw token as the
// primary text. Labels are the shipped EN/RU catalogs, so a missing copy key
// fails here, not on the page.

import type { TerminalCause } from "@/lib/domain-events/taxonomy";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  TerminalCauseNotice,
  type TerminalCauseLabels,
} from "@/components/runs/terminal-cause-notice";
import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

function labelsOf(messages: typeof en): TerminalCauseLabels {
  return {
    ...messages.run.terminalCause,
    codes: messages.run.failure.codes,
  };
}

const EN = labelsOf(en);

function render(
  status: string,
  cause: TerminalCause | null,
  showTitle?: boolean,
): string {
  // Copy is compared as written; the markup escapes its apostrophes.
  return renderToStaticMarkup(
    createElement(TerminalCauseNotice, {
      status,
      cause,
      labels: EN,
      ...(showTitle === undefined ? {} : { showTitle }),
    }),
  ).replaceAll("&#x27;", "'");
}

describe("TerminalCauseNotice", () => {
  it("a budget-failed run renders the title, the code's copy and the reason's copy", () => {
    const html = render("Failed", {
      code: "BUDGET_EXCEEDED",
      reason: "budget_breach",
      source: "sweeper",
    });

    expect(html).toContain(EN.title.Failed);
    expect(html).toContain(EN.codes.BUDGET_EXCEEDED);
    expect(html).toContain(EN.reasons.budget_breach);
    // The source is provenance, not operator copy.
    expect(html).not.toContain("sweeper");
  });

  it("inside the crash panel the line drops its title", () => {
    const html = render(
      "Crashed",
      { code: "CRASH", reason: "turn_lost", source: "graph" },
      false,
    );

    expect(html).not.toContain(EN.title.Crashed);
    expect(html).toContain(EN.codes.CRASH);
    expect(html).toContain(EN.reasons.turn_lost);
  });

  it("an unknown reason shows the code's copy and the token only as a muted line", () => {
    const html = render("Failed", {
      code: "CONFIG",
      reason: "brand_new_token",
      source: "graph",
    });

    expect(html).toContain(EN.codes.CONFIG);
    expect(html).toContain(`${EN.reasonLabel}: <code>brand_new_token</code>`);
  });

  it("an abandon with no code renders the reason alone", () => {
    const html = render("Abandoned", {
      code: null,
      reason: "ttl",
      source: "sweeper",
    });

    expect(html).toContain(EN.title.Abandoned);
    expect(html).toContain(EN.reasons.ttl);
  });

  it("renders nothing without a cause or for a status that is not a failure", () => {
    expect(render("Failed", null)).toBe("");
    expect(
      render("Done", { code: "CRASH", reason: "turn_lost", source: "graph" }),
    ).toBe("");
  });

  it("RU carries every title, reason and code the EN catalog does", () => {
    const RU = labelsOf(ru as typeof en);

    expect(Object.keys(RU.title).sort()).toEqual(Object.keys(EN.title).sort());
    expect(Object.keys(RU.reasons).sort()).toEqual(
      Object.keys(EN.reasons).sort(),
    );
    expect(Object.keys(RU.codes).sort()).toEqual(Object.keys(EN.codes).sort());
    expect(RU.reasonLabel).not.toBe("");
  });
});
