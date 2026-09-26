import { describe, expect, it } from "vitest";

import { redactPayload } from "@/lib/execution-host/redact";

// ADR-182 D-F2: the steer text is the operator's message; the ledger keeps its
// size and its parent, never its words.
describe("session.steer ledger projection", () => {
  it("keeps parentCommandId, promptBytes and contentBlockCount only", () => {
    const secret = "please also rotate the ZAI_API_KEY=sk-live-1234";
    const projected = redactPayload("session.steer", {
      parentCommandId: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
      contentBlocks: [
        { type: "text", text: secret },
        {
          type: "resource_link",
          uri: "file:///Users/me/secret.txt",
          name: "secret.txt",
        },
      ],
      prompt: secret,
    });

    expect(Object.keys(projected).sort()).toEqual([
      "contentBlockCount",
      "parentCommandId",
      "promptBytes",
    ]);
    expect(projected).toMatchObject({
      parentCommandId: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
      contentBlockCount: 2,
    });
    expect(projected.promptBytes).toBeGreaterThan(secret.length);
    expect(JSON.stringify(projected)).not.toContain("rotate");
    expect(JSON.stringify(projected)).not.toContain("file://");
  });
});
