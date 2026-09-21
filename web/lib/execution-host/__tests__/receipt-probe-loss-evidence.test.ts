// Codex adversarial review — the receipt probe must PROVE a lost turn.
//
// Two production shapes made "not completed and not inflight" mean "lost", and
// both crashed runs that were perfectly healthy:
//
//   1. `normalizeCommandReceiptV2` hardcodes `inflight: false` (the v2 wire has
//      no liveness field) while v2's phase enum still includes `accepted`. An
//      accepted v2 receipt for a RUNNING turn was therefore indistinguishable
//      from a lost one.
//   2. The supervisor's `completeAsync` catch writes `rejected` for ORDINARY
//      failures. Every one of those became a `turn_lost` crash instead of a
//      failed node action the owner applies.
//
// Asserted against the REAL normalizer, not a hand-written receipt: the whole
// defect was a property of what that function produces.

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { normalizeCommandReceiptV2 } from "@/lib/execution-host/command-receipt";
import { isTurnLostError } from "@/lib/reconcile-evidence";
import { probeReceipt } from "@/lib/reconcile-evidence-db";

// The v2 shape is strictly validated (`exactKeys` on both the receipt and its
// terminal), which is the point: the assertions below are about what the REAL
// parser + normalizer produce, not about a convenient literal.
function v2(phase: "accepted" | "rejected", error?: Record<string, unknown>) {
  return normalizeCommandReceiptV2({
    receiptVersion: 2,
    commandId: randomUUID(),
    kind: "session.prompt",
    hostKey: "host-key",
    runId: "run-1",
    assignmentId: randomUUID(),
    assignmentEpoch: 1,
    hostSessionId: "sess-1",
    requestSchema: "maister.command.request.v2",
    requestSha256: "a".repeat(64),
    phase,
    httpStatus: phase === "accepted" ? 202 : 409,
    receivedAt: new Date().toISOString(),
    terminal:
      phase === "accepted"
        ? null
        : {
            outcomeVersion: 2,
            status: "failed",
            eventId: randomUUID(),
            streamId: randomUUID(),
            sequence: "1",
            result: null,
            error: error ?? {},
          },
  });
}

describe("v2 receipts carry no liveness", () => {
  it("an ACCEPTED v2 receipt reports inflight:false even while the turn runs", () => {
    // The trap, pinned. Any probe that reads `inflight` as evidence of death
    // will crash a healthy v2 turn — this assertion is why the probe branches
    // on `evidenceV2` before it trusts that field.
    const receipt = v2("accepted");

    expect(receipt.phase).toBe("accepted");
    expect(receipt.inflight).toBe(false);
    expect(
      receipt.evidenceV2,
      "the v2 marker is what lets a reader know `inflight` is meaningless here",
    ).toBeTruthy();
  });
});

describe("rejected is not synonymous with lost", () => {
  it("an ordinary failure body is NOT a lost turn", () => {
    const receipt = v2("rejected", {
      code: "ACP_PROTOCOL",
      message: "adapter refused",
    });

    expect(isTurnLostError(receipt.body)).toBe(false);
  });

  it("a genuine turn_lost body IS one", () => {
    // The v2 terminal error admits only `code | message | details`, so on this
    // path a lost turn always arrives NESTED under `details` — the flat shape
    // is a v1/foldReceipt artefact. `isTurnLostError` accepts both.
    const receipt = v2("rejected", {
      code: "PRECONDITION",
      message: "turn lost",
      details: { reason: "turn_lost" },
    });

    expect(isTurnLostError(receipt.body)).toBe(true);
  });
});

// The two suites above pin what the normalizer PRODUCES and what
// `isTurnLostError` makes of it. Neither pins the step between them — the
// mapping `probeReceipt` performs — and that step is where the defect lived.
// Without these cases, restoring either wrong reading leaves the whole lane
// green, which is exactly how both shipped the first time.
function transportReturning(receipt: unknown) {
  return {
    getCommandReceipt: async () => receipt,
  } as never;
}

describe("probeReceipt maps each receipt to what it actually PROVES", () => {
  it("a v2 accepted receipt is INDETERMINATE, never a lost turn", async () => {
    // `indeterminate` and not `pending_ingest`: the latter asserts a named
    // writer owes the next move, and fires regardless of grace. Since v2 is the
    // production request schema, answering it here would skip EVERY production
    // candidate forever and silently delete the pre-ADR-177 safety net. `none`
    // — what `indeterminate` classifies to — keeps the grace rule instead.
    await expect(
      probeReceipt(transportReturning(v2("accepted")), "c"),
    ).resolves.toBe("indeterminate");
  });

  it("a rejected receipt with an ORDINARY error is pending_ingest", async () => {
    await expect(
      probeReceipt(
        transportReturning(
          v2("rejected", { code: "ACP_PROTOCOL", message: "adapter refused" }),
        ),
        "c",
      ),
    ).resolves.toBe("pending_ingest");
  });

  it("a rejected receipt naming turn_lost IS a lost turn", async () => {
    await expect(
      probeReceipt(
        transportReturning(
          v2("rejected", {
            code: "PRECONDITION",
            message: "turn lost",
            details: { reason: "turn_lost" },
          }),
        ),
        "c",
      ),
    ).resolves.toBe("turn_lost");
  });

  it("only a v1 accepted receipt may read its liveness field", async () => {
    // v1 is the one shape where `inflight` means something, so it is the one
    // shape from which a lost turn may be concluded without a terminal error.
    const v1 = (inflight: boolean) => ({
      phase: "accepted" as const,
      inflight,
      evidenceV2: false,
      body: null,
    });

    await expect(probeReceipt(transportReturning(v1(true)), "c")).resolves.toBe(
      "inflight",
    );
    await expect(
      probeReceipt(transportReturning(v1(false)), "c"),
    ).resolves.toBe("turn_lost");
  });

  it("an absent receipt and a throwing transport are both unknown, never a crash", async () => {
    await expect(probeReceipt(transportReturning(null), "c")).resolves.toBe(
      "unknown",
    );
    await expect(
      probeReceipt(
        {
          getCommandReceipt: async () => {
            throw new Error("connection reset");
          },
        } as never,
        "c",
      ),
    ).resolves.toBe("unknown");
  });
});
