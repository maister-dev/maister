import { describe, expect, it } from "vitest";

import {
  composeEffectivePrompt,
  deriveAwaitingClarification,
  orderedAnsweredClarifications,
} from "@/lib/tasks/clarifications";

describe("task clarification context", () => {
  it("preserves the authored prompt exactly when no answer is eligible", () => {
    const prompt = "Keep this {{ task.prompt }} byte-identical.";
    const clarifications = orderedAnsweredClarifications([
      {
        id: "unanswered",
        seq: 1,
        question: "Unanswered?",
        answer: null,
        answeredAt: null,
        supersededAt: null,
      },
      {
        id: "superseded",
        seq: 2,
        question: "Stale?",
        answer: { target: "old" },
        answeredAt: new Date("2026-07-13T10:00:00.000Z"),
        supersededAt: new Date("2026-07-13T10:01:00.000Z"),
      },
    ]);

    expect(clarifications).toEqual([]);
    expect(composeEffectivePrompt(prompt, clarifications)).toBe(prompt);
  });

  it("orders eligible answers by sequence then id and composes a bounded standalone prompt", () => {
    const clarifications = orderedAnsweredClarifications([
      {
        id: "z",
        seq: 2,
        question: "Second?",
        answer: { enabled: true },
        answeredAt: new Date("2026-07-13T10:02:00.000Z"),
        supersededAt: null,
      },
      {
        id: "b",
        seq: 1,
        question: "First B?",
        answer: { region: "eu" },
        answeredAt: new Date("2026-07-13T10:01:00.000Z"),
        supersededAt: null,
      },
      {
        id: "a",
        seq: 1,
        question: "First A?",
        answer: { region: "us" },
        answeredAt: new Date("2026-07-13T10:00:00.000Z"),
        supersededAt: null,
      },
    ]);

    expect(clarifications.map((item) => item.id)).toEqual(["a", "b", "z"]);
    expect(composeEffectivePrompt("Deploy.", clarifications)).toBe(
      [
        "Deploy.",
        "## Human clarifications",
        "### Clarification 1",
        "Question: First A?",
        'Answer: {"region":"us"}',
        "### Clarification 1",
        "Question: First B?",
        'Answer: {"region":"eu"}',
        "### Clarification 2",
        "Question: Second?",
        'Answer: {"enabled":true}',
      ].join("\n\n"),
    );
  });

  it("derives awaiting only from an active unsuperseded unanswered question", () => {
    expect(
      deriveAwaitingClarification([
        {
          activationState: "pending_termination",
          respondedAt: null,
          supersededAt: null,
        },
        {
          activationState: "active",
          respondedAt: new Date("2026-07-13T10:00:00.000Z"),
          supersededAt: null,
        },
      ]),
    ).toBe(false);

    expect(
      deriveAwaitingClarification([
        {
          activationState: "active",
          respondedAt: null,
          supersededAt: null,
        },
      ]),
    ).toBe(true);
  });
});
