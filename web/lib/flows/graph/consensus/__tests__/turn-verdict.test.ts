import { describe, expect, it } from "vitest";

import { consensusTurnVerdict } from "../prompt-owner";

const AXES = ["scope", "risk"];
const AGREE = JSON.stringify({
  verdict: "agree",
  axes: { scope: true, risk: true },
  disagreements: [],
});

describe("consensusTurnVerdict", () => {
  it("parses a complete retained end_turn", () => {
    const verdict = consensusTurnVerdict(
      { state: "succeeded", response: { stopReason: "end_turn" } },
      { text: `long reasoning first\n${AGREE}`, droppedBytes: 0 },
      AXES,
    );

    expect(verdict).toMatchObject({ ok: true, result: { verdict: "agree" } });
    expect(verdict.errorCode).toBeUndefined();
  });

  it("fails closed on overflow even when the retained prefix holds a valid agreement", () => {
    const verdict = consensusTurnVerdict(
      { state: "succeeded", response: { stopReason: "end_turn" } },
      { text: AGREE, droppedBytes: 1 },
      AXES,
    );

    expect(verdict).toMatchObject({
      ok: false,
      errorCode: "output_cap_exceeded",
      result: { verdict: "disagree", parseStatus: "invalid_json" },
    });
  });

  it.each([
    [
      { state: "succeeded", response: { stopReason: "max_tokens" } },
      "ACP_PROTOCOL",
    ],
    [{ state: "failed", error: { code: "CRASH" } }, "CRASH"],
    [{ state: "failed" }, "EXECUTOR_UNAVAILABLE"],
  ])("fails closed on a non-complete turn %j", (outcome, errorCode) => {
    const verdict = consensusTurnVerdict(
      outcome,
      { text: AGREE, droppedBytes: 0 },
      AXES,
    );

    expect(verdict).toMatchObject({
      ok: false,
      errorCode,
      result: { verdict: "disagree" },
    });
  });
});
