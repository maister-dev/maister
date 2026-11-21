import { describe, expect, it } from "vitest";

import { evaluateCiObservation, type CiCheck } from "../ci-evidence";

const headSha = "1".repeat(40);
const expected = {
  headSha,
  ref: "refs/heads/run/17",
  issuer: "release-ci",
  checks: ["test", "smoke"],
};
const check = (name: string, values: Partial<CiCheck> = {}): CiCheck => ({
  name,
  headSha,
  ref: expected.ref,
  issuer: expected.issuer,
  attempt: 1n,
  state: "success",
  ...values,
});

describe("B02 resolves complete exact-publication CI evidence", () => {
  it("holds green when completeness, source, or newest-attempt evidence is missing", () => {
    const green = [check("test"), check("smoke")];

    expect(
      evaluateCiObservation(expected, { complete: true, checks: green }),
    ).toMatchObject({ outcome: "success" });
    for (const reads of [
      { complete: false, checks: green },
      {
        complete: true,
        checks: [green[0], check("smoke", { headSha: "2".repeat(40) })],
      },
      {
        complete: true,
        checks: [green[0], check("smoke", { ref: "refs/heads/main" })],
      },
      {
        complete: true,
        checks: [green[0], check("smoke", { issuer: "another" })],
      },
      {
        complete: true,
        checks: [...green, check("test", { attempt: 2n, state: "pending" })],
      },
      {
        complete: true,
        checks: [...green, check("test", { state: "invalid" })],
      },
    ])
      expect(evaluateCiObservation(expected, reads)).toBeNull();
  });

  it("chooses failure over cancellation and reports only declared failures", () => {
    expect(
      evaluateCiObservation(expected, {
        complete: true,
        checks: [
          check("test", { state: "failure" }),
          check("smoke", { state: "cancelled" }),
          check("unrelated", { state: "failure" }),
        ],
      }),
    ).toEqual({ outcome: "failure", nonPassingChecks: ["test"] });
    expect(
      evaluateCiObservation(expected, {
        complete: true,
        checks: [check("smoke", { state: "cancelled" })],
      }),
    ).toEqual({ outcome: "cancelled", nonPassingChecks: ["smoke"] });
    expect(
      evaluateCiObservation(
        { ...expected, checks: [] },
        { complete: true, checks: [] },
      ),
    ).toBeNull();
  });
});
