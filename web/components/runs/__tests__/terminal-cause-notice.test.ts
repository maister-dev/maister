// B6 (ADR-177 amendment 2026-09-26), T4.3: the run page names why a run ended,
// composed from the cause's reason copy (else its code's) — never a raw token
// as the primary text. Labels are the shipped EN/RU catalogs, and every token
// an emitter writes (`TERMINAL_CAUSE_REASONS`) and every code must have copy in
// both, so a missing key fails here, not on the page.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MAISTER_ERROR_CODES } from "@/lib/errors-core";
import {
  TERMINAL_CAUSE_REASONS,
  type TerminalCause,
} from "@/lib/domain-events/taxonomy";
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
  it("a budget-failed run renders the title and the reason's copy, which leads over the code's", () => {
    const html = render("Failed", {
      code: "BUDGET_EXCEEDED",
      reason: "budget_breach",
      source: "sweeper",
    });

    expect(html).toContain(EN.title.Failed);
    expect(html).toContain(EN.reasons.budget_breach);
    expect(html).not.toContain(EN.codes.BUDGET_EXCEEDED);
    // The source is provenance, not operator copy.
    expect(html).not.toContain("sweeper");
  });

  // A time limit is filed under PRECONDITION; side by side the two copies
  // would contradict each other.
  it("a time-limited run reads its reason, not the PRECONDITION copy", () => {
    const html = render("Failed", {
      code: "PRECONDITION",
      reason: "max_duration",
      source: "sweeper",
    });

    expect(html).toContain(EN.reasons.max_duration);
    expect(html).not.toContain(EN.codes.PRECONDITION);
  });

  it("a cause with a code and no reason renders the code's copy", () => {
    const html = render("Failed", { code: "CONFIG", source: "graph" });

    expect(html).toContain(EN.codes.CONFIG);
  });

  it("inside the crash panel the line drops its title", () => {
    const html = render(
      "Crashed",
      { code: "CRASH", reason: "turn_lost", source: "graph" },
      false,
    );

    expect(html).not.toContain(EN.title.Crashed);
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

  it("an unknown reason with no code is never the primary text", () => {
    const html = render("Abandoned", {
      code: null,
      reason: "brand_new_token",
      source: "operator",
    });

    expect(html).toContain(`<p>${EN.unknownReason}</p>`);
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
    expect(RU.unknownReason).not.toBe("");
  });

  it("every reason an emitter writes and every error code has copy in both catalogs", () => {
    const RU = labelsOf(ru as typeof en);
    const missing = [
      ...TERMINAL_CAUSE_REASONS.filter(
        (token) => !(EN.reasons as Record<string, string>)[token],
      ).map((token) => `en reason ${token}`),
      ...TERMINAL_CAUSE_REASONS.filter(
        (token) => !(RU.reasons as Record<string, string>)[token],
      ).map((token) => `ru reason ${token}`),
      ...MAISTER_ERROR_CODES.filter(
        (code) => !(EN.codes as Record<string, string>)[code],
      ).map((code) => `en code ${code}`),
      ...MAISTER_ERROR_CODES.filter(
        (code) => !(RU.codes as Record<string, string>)[code],
      ).map((code) => `ru code ${code}`),
    ];

    expect(missing).toEqual([]);
  });
});
