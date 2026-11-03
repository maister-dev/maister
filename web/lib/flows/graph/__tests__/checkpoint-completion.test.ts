import { describe, expect, it } from "vitest";

import { decodeNodePromptCompletion } from "../node-prompt-owner";

describe("checkpoint command application", () => {
  it("projects the intentional no_progress interruption as a paused action", async () => {
    const completion = await decodeNodePromptCompletion({
      commandId: "checkpointed-command",
      promptOrdinal: 1,
      acpSessionId: "retained-session",
      outcome: {
        state: "failed",
        error: {
          code: "CHECKPOINT",
          message: "intentionally checkpointed",
          details: {
            reason: "session_checkpointed",
            stopReason: "no_progress",
          },
        },
      },
    });

    expect(completion.result).toMatchObject({
      ok: false,
      errorCode: "STEP_CHECKPOINTED",
      reason: "no_progress",
      acpSessionId: "retained-session",
    });
  });

  it.each(["ACP_PROTOCOL", "CHECKPOINT"])(
    "retains unrelated %s failures",
    async (code) => {
      const completion = await decodeNodePromptCompletion({
        commandId: "failed-command",
        promptOrdinal: 1,
        acpSessionId: "retained-session",
        outcome: {
          state: "failed",
          error: { code, message: "unrelated failure" },
        },
      });

      expect(completion.result).toMatchObject({ ok: false, errorCode: code });
      expect(completion.result.reason).toBeUndefined();
    },
  );
});
