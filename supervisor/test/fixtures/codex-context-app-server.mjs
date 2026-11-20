#!/usr/bin/env node
import { createInterface } from "node:readline";

const threadId = "context-fixture-thread";
const turnId = "context-fixture-turn";
const model = "fixture-model";
const lines = createInterface({ input: process.stdin });
const fixture = process.env.MAISTER_CODEX_CONTEXT_FIXTURE;
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const thread = { id: threadId, cwd: process.cwd(), turns: [], status: { type: "idle" } };

for await (const line of lines) {
  const { method, id } = JSON.parse(line);

  if (id === undefined) continue;
  const respond = (result) => write({ id, result });

  switch (method) {
    case "initialize":
      respond({ codexHome: process.cwd(), userAgent: "fixture" });
      break;
    case "account/read":
      respond({ account: { type: "apiKey" }, requiresOpenaiAuth: false });
      break;
    case "config/read":
      respond({ config: {}, origins: {}, layers: null });
      break;
    case "model/list":
      respond({
        data: [{
          id: model, model, displayName: "Fixture", description: "Fixture",
          defaultReasoningEffort: "medium", isDefault: true, hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Fixture" }],
        }],
        nextCursor: null,
      });
      break;
    case "thread/start":
    case "thread/read":
      respond({ thread, model, modelProvider: "fixture", reasoningEffort: "medium" });
      break;
    case "turn/start": {
      const turn = { id: turnId, items: [] };
      const failed = ["notification", "completion", "budget"].includes(fixture);
      const error = {
        message: "Synthetic turn limit",
        codexErrorInfo: fixture === "budget" ? "sessionBudgetExceeded" : "contextWindowExceeded",
        additionalDetails: null,
      };

      respond({ turn: { ...turn, status: "inProgress" } });
      if (["notification", "retry-warning", "out-of-turn"].includes(fixture)) {
        write({
          method: "error",
          params: {
            threadId, turnId: fixture === "out-of-turn" ? "other-turn" : turnId,
            error, willRetry: fixture === "retry-warning",
          },
        });
      }
      write({
        method: "turn/completed",
        params: { threadId, turn: { ...turn, status: failed ? "failed" : "completed", error: failed ? error : null } },
      });
      break;
    }
    default:
      respond(method.startsWith("skills/") ? { data: [], errors: [] } : {});
  }
}
