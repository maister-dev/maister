import type { RunPublicResultDto } from "@/lib/runs/run-result-dto";
import type { ResultStatus } from "@/lib/run-results/types";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  RunPublicResultPanel,
  type RunPublicResultLabels,
} from "@/components/runs/run-public-result-panel";
import enMessages from "@/messages/en.json";
import ruMessages from "@/messages/ru.json";

// ADR-165 AC-34. renderToStaticMarkup (no jsdom), labels as props — the repo's
// component-test convention.

const STATUSES: ResultStatus[] = [
  "pending",
  "valid",
  "absent",
  "missing",
  "stale",
  "invalid",
  "unavailable",
];

const labels: RunPublicResultLabels = {
  title: "Public result",
  schemaRef: "Schema",
  revision: "revision",
  superseded: "superseded",
  collected: "collected",
  notCollected: "not collected",
  value: "Value",
  noValue: "No published value",
  completedWithoutPromotion: "Completed without promotion",
  failureReason: "Reason",
  status: {
    pending: "Pending",
    valid: "Valid",
    absent: "Absent",
    missing: "Missing",
    stale: "Stale",
    invalid: "Invalid",
    unavailable: "Unavailable",
  },
};

function dto(over: Partial<RunPublicResultDto> = {}): RunPublicResultDto {
  return {
    schemaRef: "core-rah@1a2b3c4d5e6f:research-result.v1",
    resultStatus: "valid",
    revision: 1,
    supersededCount: 0,
    collectedAt: null,
    value: { summary: "found it", outcome: "completed" },
    valueBytes: 48,
    failure: null,
    completedWithoutPromotion: false,
    ...over,
  };
}

function render(result: RunPublicResultDto | null): string {
  return renderToStaticMarkup(
    createElement(RunPublicResultPanel, { result, labels }),
  );
}

describe("RunPublicResultPanel", () => {
  it("renders NOTHING for a run with no contract and no rows", () => {
    expect(render(null)).toBe("");
  });

  it("renders schemaRef, revision, the status and a JSON viewer for a valid result", () => {
    const html = render(dto());

    expect(html).toContain('data-testid="run-public-result"');
    expect(html).toContain('data-result-status="valid"');
    expect(html).toContain("core-rah@1a2b3c4d5e6f:research-result.v1");
    expect(html).toContain("revision 1");
    expect(html).toContain("Valid");
    expect(html).toContain('data-testid="run-public-result-value"');
    // The value is rendered as formatted JSON, not as [object Object].
    expect(html).toContain("&quot;summary&quot;");
    expect(html).not.toContain("[object Object]");
  });

  it("shows the not-collected marker until a collect stamps it, then the collected one", () => {
    expect(render(dto())).toContain("not collected");
    expect(render(dto({ collectedAt: "2026-09-02T10:00:00.000Z" }))).toContain(
      ">collected<",
    );
  });

  it("shows the superseded count only when there is one", () => {
    expect(render(dto())).not.toContain(
      'data-testid="run-public-result-superseded"',
    );
    expect(render(dto({ supersededCount: 2 }))).toContain("superseded: 2");
  });

  it("renders a failure reason and no value viewer for an invalid result", () => {
    const html = render(
      dto({
        resultStatus: "invalid",
        value: null,
        revision: 2,
        failure: { reason: "schema_mismatch" },
      }),
    );

    expect(html).toContain("Reason: schema_mismatch");
    expect(html).toContain('data-testid="run-public-result-no-value"');
    expect(html).not.toContain('data-testid="run-public-result-value"');
  });

  it("shows the completed-without-promotion fact only for a result-only Done", () => {
    expect(render(dto())).not.toContain(
      'data-testid="run-public-result-no-promotion"',
    );
    expect(render(dto({ completedWithoutPromotion: true }))).toContain(
      "Completed without promotion",
    );
  });

  // A reader expanding a result should know its scale first — payloads run to
  // the 256 KB validate-seam cap.
  it("shows the payload size on the disclosure, and omits it when unknown", () => {
    expect(render(dto())).toContain("48 B");
    expect(render(dto({ valueBytes: 200_000 }))).toContain("195 KB");
    expect(render(dto({ valueBytes: null }))).not.toContain(
      'data-testid="run-public-result-value-size"',
    );
  });

  it.each(STATUSES)("renders a glyph and a label for %s", (resultStatus) => {
    const html = render(
      dto({
        resultStatus,
        value: resultStatus === "valid" ? { ok: true } : null,
      }),
    );

    expect(html).toContain(`data-result-status="${resultStatus}"`);
    expect(html).toContain('data-testid="run-public-result-glyph"');
    expect(html).toContain(labels.status[resultStatus]);
  });
});

// The i18n rule: a key is done only when something CONSUMES it, and EN/RU must
// both resolve. Asserted here rather than in a parity test, which checks
// presence and would pass on a key nothing renders.
describe("i18n coverage for the panel (EN + RU)", () => {
  const KEYS = [
    "publicResultTitle",
    "publicResultSchemaRef",
    "publicResultRevision",
    "publicResultSuperseded",
    "publicResultCollected",
    "publicResultNotCollected",
    "publicResultValue",
    "publicResultNoValue",
    "publicResultNoPromotion",
    "publicResultFailureReason",
    "treeTokenTotal",
    "treeWallClock",
    ...STATUSES.map(
      (s) => `publicResultStatus${s[0].toUpperCase()}${s.slice(1)}`,
    ),
  ];

  it.each(KEYS)("%s resolves in both catalogs and is non-empty", (key) => {
    const en = (enMessages as unknown as Record<string, Record<string, string>>)
      .run?.[key];
    const ru = (ruMessages as unknown as Record<string, Record<string, string>>)
      .run?.[key];

    expect(typeof en, `EN run.${key}`).toBe("string");
    expect((en ?? "").length).toBeGreaterThan(0);
    expect(typeof ru, `RU run.${key}`).toBe("string");
    expect((ru ?? "").length).toBeGreaterThan(0);
  });
});
