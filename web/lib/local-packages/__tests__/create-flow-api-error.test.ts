import { describe, expect, it } from "vitest";

import { readCreateFlowApiError } from "@/lib/local-packages/create-flow-api-error";
import en from "@/messages/en.json";
import ru from "@/messages/ru.json";

interface MessageTree {
  [key: string]: string | MessageTree;
}

function messageAt(messages: MessageTree, key: string): string {
  const value = key.split(".").reduce<string | MessageTree>((current, part) => {
    if (typeof current === "string")
      throw new Error(`unexpected leaf: ${part}`);
    return (
      current[part] ??
      (() => {
        throw new Error(`missing message: ${key}`);
      })()
    );
  }, messages);

  if (typeof value !== "string")
    throw new Error(`message is not a leaf: ${key}`);
  return value;
}

describe("readCreateFlowApiError", () => {
  it("maps only approved Flow-create conflict reasons to actionable EN and RU messages", async () => {
    const reasons = [
      "duplicate_flow_id",
      "edit_lock_not_held",
      "assistant_active",
      "creation_recovery_required",
      "operation_in_progress",
    ];

    for (const reason of reasons) {
      const response = new Response(
        JSON.stringify({
          code: "CONFLICT",
          message: "server-only detail must not be rendered",
          details: { reason },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
      const key = `errors.${reason}`;

      await expect(
        readCreateFlowApiError(
          response.clone(),
          (errorKey) => `api:${errorKey}`,
          (messageKey) =>
            messageAt(
              en as MessageTree,
              `studio.local.createFlow.${messageKey}`,
            ),
        ),
      ).resolves.toBe(
        messageAt(en as MessageTree, `studio.local.createFlow.${key}`),
      );
      await expect(
        readCreateFlowApiError(
          response,
          (errorKey) => `api:${errorKey}`,
          (messageKey) =>
            messageAt(
              ru as MessageTree,
              `studio.local.createFlow.${messageKey}`,
            ),
        ),
      ).resolves.toBe(
        messageAt(ru as MessageTree, `studio.local.createFlow.${key}`),
      );
    }
  });

  it("keeps unknown details on the generic error path", async () => {
    const response = new Response(
      JSON.stringify({
        code: "CONFLICT",
        message: "do not render this server message",
        details: { reason: "unrecognized" },
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );

    await expect(
      readCreateFlowApiError(
        response,
        (key) => `api:${key}`,
        (key) => `flow:${key}`,
      ),
    ).resolves.toBe("api:CONFLICT");
  });
});
