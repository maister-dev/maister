// M30 (ADR-078): gate-chat availability predicate (DD2) + the rework-compose
// chat fold (ADR-072 extension). Pure units — no DB, no git.

import { describe, expect, it } from "vitest";

import { composeReworkPayload } from "@/lib/review-comments/serialize";
import { gateChatAvailability, gateChatStepId } from "@/lib/services/gate-chat";

const base = {
  runStatus: "NeedsInput",
  hitlKind: "human" as string | null,
  hitlRespondedAt: null as Date | null,
  acpSessionId: "acp-1" as string | null,
};

describe("gateChatAvailability (DD2 allow-list)", () => {
  it("is available at NeedsInput + human HITL + live session handle", () => {
    expect(gateChatAvailability(base).available).toBe(true);
  });

  it("is available at NeedsInputIdle + form HITL", () => {
    expect(
      gateChatAvailability({
        ...base,
        runStatus: "NeedsInputIdle",
        hitlKind: "form",
      }).available,
    ).toBe(true);
  });

  it("excludes permission-kind pauses (session mid-prompt-turn)", () => {
    const r = gateChatAvailability({ ...base, hitlKind: "permission" });

    expect(r.available).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("excludes HumanWorking (manual takeover owns the worktree)", () => {
    expect(
      gateChatAvailability({ ...base, runStatus: "HumanWorking" }).available,
    ).toBe(false);
  });

  it("excludes Running and terminal statuses", () => {
    for (const status of ["Running", "Review", "Done", "Failed", "Crashed"]) {
      expect(
        gateChatAvailability({ ...base, runStatus: status }).available,
      ).toBe(false);
    }
  });

  it("excludes the no-session case (explanatory empty state)", () => {
    expect(
      gateChatAvailability({ ...base, acpSessionId: null }).available,
    ).toBe(false);
  });

  it("excludes a responded HITL (the pause ended)", () => {
    expect(
      gateChatAvailability({ ...base, hitlRespondedAt: new Date() }).available,
    ).toBe(false);
  });
});

describe("gateChatStepId (DD4 marker)", () => {
  it("uses a dash, never a colon (supervisor SAFE_PATH_SEGMENT)", () => {
    const id = gateChatStepId("0f9d6c1e-1111-4222-8333-444455556666");

    expect(id).toBe("gate-chat-0f9d6c1e-1111-4222-8333-444455556666");
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe("composeReworkPayload folds chat history (ADR-072 + ADR-078)", () => {
  it("appends a gate-chat section after the review comments", () => {
    const composed = composeReworkPayload(
      "tighten the parser",
      [],
      [
        { role: "user", authorLabel: "Reviewer", body: "why regex here?" },
        { role: "agent", authorLabel: "agent", body: "it mirrors X" },
      ],
    );

    expect(composed).toContain("tighten the parser");
    expect(composed).toContain("## Gate chat");
    expect(composed).toContain("why regex here?");
    expect(composed).toContain("it mirrors X");
  });

  it("keeps the D3 zero-input guarantee: no threads + no chat = raw summary bytes", () => {
    expect(composeReworkPayload("raw", [], [])).toBe("raw");
    expect(composeReworkPayload("raw", [])).toBe("raw");
  });
});
