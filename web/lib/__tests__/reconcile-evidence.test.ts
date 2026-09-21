// ADR-177 T2.1 — the evidence derivation, one case per row of the D1 table
// plus the two order-sensitivity cases that are the whole reason the order is
// written down.
//
// Pure: no Postgres, no host, no clock. `classifyPromptEvidence` is the single
// implementation of the derivation — the sweep's builder, this suite and the
// analytics table all read the same one.

import type { PromptEvidenceRow } from "@/lib/reconcile-evidence";

import { describe, expect, it } from "vitest";

import {
  classifyPromptEvidence,
  isTurnLostError,
  PROMPT_EVIDENCE_CLASSES,
} from "@/lib/reconcile-evidence";

function row(overrides: Partial<PromptEvidenceRow> = {}): PromptEvidenceRow {
  return {
    state: "accepted",
    applicationState: "pending",
    applicationError: null,
    lastError: null,
    terminalEventId: null,
    terminalEvidenceSha256: null,
    ...overrides,
  };
}

const TURN_LOST_NESTED = {
  code: "PRECONDITION",
  details: { reason: "turn_lost" },
};
const TURN_LOST_FLAT = { code: "ACP_PROTOCOL", reason: "turn_lost" };

describe("isTurnLostError — both production shapes, neither code", () => {
  it("accepts the NESTED shape the ingested terminal event writes", () => {
    expect(isTurnLostError(TURN_LOST_NESTED)).toBe(true);
  });

  it("accepts the FLAT shape foldReceipt's fallback writes", () => {
    // This is the case a `details.reason`-only matcher silently never fires on.
    expect(isTurnLostError(TURN_LOST_FLAT)).toBe(true);
  });

  it("does NOT key on the error code — both codes are reachable for one cause", () => {
    // `PRECONDITION` and `ACP_PROTOCOL` each appear on a turn_lost AND on
    // ordinary failures, so the code cannot be the discriminator in either
    // direction.
    expect(isTurnLostError({ code: "PRECONDITION" })).toBe(false);
    expect(isTurnLostError({ code: "ACP_PROTOCOL" })).toBe(false);
    expect(
      isTurnLostError({
        code: "ACP_PROTOCOL",
        details: { reason: "receipt_missing" },
      }),
    ).toBe(false);
  });

  it("is total over junk", () => {
    for (const value of [null, undefined, "turn_lost", 7, ["turn_lost"], {}])
      expect(isTurnLostError(value)).toBe(false);
  });
});

describe("classifyPromptEvidence — the D1 derivation, in order", () => {
  it("row 1: no owned prompt for this attempt → none", () => {
    expect(classifyPromptEvidence(null)).toBe("none");
  });

  it.each(["queued", "delivering"])(
    "row 2: a %s row → none — nothing the host could have lost",
    (state) => {
      expect(classifyPromptEvidence(row({ state }))).toBe("none");
    },
  );

  it("row 3: a prompt_terminal_conflict → quarantined", () => {
    expect(
      classifyPromptEvidence(
        row({
          state: "succeeded",
          applicationError: { reason: "prompt_terminal_conflict" },
        }),
      ),
    ).toBe("quarantined");
  });

  it("row 4: application_state poisoned → poisoned", () => {
    expect(
      classifyPromptEvidence(
        row({ state: "failed", applicationState: "poisoned" }),
      ),
    ).toBe("poisoned");
  });

  it.each(["applied", "superseded"])(
    "row 5: application_state %s → applied",
    (applicationState) => {
      expect(
        classifyPromptEvidence(row({ state: "succeeded", applicationState })),
      ).toBe("applied");
    },
  );

  it("row 6: application_state applying → applying", () => {
    expect(
      classifyPromptEvidence(
        row({ state: "succeeded", applicationState: "applying" }),
      ),
    ).toBe("applying");
  });

  it.each([
    ["nested", TURN_LOST_NESTED],
    ["flat", TURN_LOST_FLAT],
  ])("row 7: a settled %s turn_lost → turn_lost", (_shape, lastError) => {
    expect(classifyPromptEvidence(row({ state: "failed", lastError }))).toBe(
      "turn_lost",
    );
  });

  it.each(["succeeded", "failed", "fenced"])(
    "row 8: a settled %s row the owner has not applied → pending_application",
    (state) => {
      expect(classifyPromptEvidence(row({ state }))).toBe(
        "pending_application",
      );
    },
  );

  it("row 9: accepted + the probe says the turn is running → inflight", () => {
    expect(classifyPromptEvidence(row(), "inflight")).toBe("inflight");
  });

  it("row 9: accepted + the probe says completed → pending_ingest", () => {
    expect(classifyPromptEvidence(row(), "completed")).toBe("pending_ingest");
  });

  it("row 9: accepted + the probe reports a lost turn → turn_lost", () => {
    expect(classifyPromptEvidence(row(), "turn_lost")).toBe("turn_lost");
  });

  it.each([
    ["a probe that did not answer (404, timeout, network)", "unknown" as const],
    ["no probe at all", undefined],
  ])("row 9: %s → pending_ingest, never a crash", (_label, probe) => {
    // A probe failure is NOT evidence. Classifying it as anything that crashes
    // would turn a transport blip into a terminalized run.
    expect(classifyPromptEvidence(row(), probe)).toBe("pending_ingest");
  });
});

describe("classifyPromptEvidence — the two load-bearing orderings", () => {
  it("a conflict found AFTER application reads quarantined, not applied", () => {
    // `quarantine()` writes applicationState = completionAppliedAt ? 'applied'
    // : 'poisoned'. Keyed on 'poisoned' alone this row classifies as healthy
    // and a disagreeing turn is skipped forever — the defect row 3 prevents.
    expect(
      classifyPromptEvidence(
        row({
          state: "succeeded",
          applicationState: "applied",
          applicationError: { reason: "prompt_terminal_conflict" },
        }),
      ),
    ).toBe("quarantined");
  });

  it("a settled turn_lost still PENDING application reads turn_lost, not pending_application", () => {
    // Both predicates are true for this row. If `pending_application` won, the
    // sweep would wait for a writer whose only possible answer is a failed node
    // action — which is exactly the outcome this contract exists to prevent.
    expect(
      classifyPromptEvidence(
        row({
          state: "failed",
          applicationState: "pending",
          lastError: TURN_LOST_NESTED,
        }),
      ),
    ).toBe("turn_lost");
  });
});

describe("classifyPromptEvidence — totality", () => {
  it("every declared class is reachable from some row", () => {
    const reached = new Set([
      classifyPromptEvidence(null),
      classifyPromptEvidence(row({ state: "queued" })),
      classifyPromptEvidence(row(), "inflight"),
      classifyPromptEvidence(row(), "completed"),
      classifyPromptEvidence(row({ state: "failed" })),
      classifyPromptEvidence(
        row({ state: "failed", applicationState: "applying" }),
      ),
      classifyPromptEvidence(
        row({ state: "failed", applicationState: "applied" }),
      ),
      classifyPromptEvidence(
        row({ state: "failed", lastError: TURN_LOST_FLAT }),
      ),
      classifyPromptEvidence(
        row({
          state: "failed",
          applicationError: { reason: "prompt_terminal_conflict" },
        }),
      ),
      classifyPromptEvidence(
        row({ state: "failed", applicationState: "poisoned" }),
      ),
    ]);

    // A class nothing can produce is a dead arm in the decision table — and a
    // dead arm is how a future member gets added without a rule.
    expect([...reached].sort()).toEqual([...PROMPT_EVIDENCE_CLASSES].sort());
  });
});
