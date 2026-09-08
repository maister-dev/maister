import { describe, expect, it } from "vitest";

import { resolvePromptRuntimeObjects } from "../prompt-runtime-objects";

describe("resolvePromptRuntimeObjects", () => {
  it("derives an ACP resource link only inside the host from an opaque object ID", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const blocks = await resolvePromptRuntimeObjects({
      blocks: [
        { type: "text", text: "inspect this attachment" },
        {
          type: "runtime_object",
          objectId: "b7e5e032-6049-48b2-806f-e5db714a93cb",
          name: "evidence.txt",
          description: "uploaded evidence",
        },
      ],
      resolver: {
        async resolvePromptReference(input) {
          calls.push(input);

          return {
            metadata: { mimeType: "text/plain" },
            path: "/private/execution-host/runtime-objects/b7e5e032-6049-48b2-806f-e5db714a93cb.1",
          };
        },
      },
      runId: "run-1",
      assignmentId: "a0f7f6c8-9f3b-471e-8e0d-74af1bf4c7a8",
      assignmentEpoch: 2,
    });

    // The registry refuses any kind other than the one it is told to expect,
    // so the resolver call must name the prompt-reference kind explicitly.
    expect(calls).toEqual([
      {
        objectId: "b7e5e032-6049-48b2-806f-e5db714a93cb",
        runId: "run-1",
        assignmentId: "a0f7f6c8-9f3b-471e-8e0d-74af1bf4c7a8",
        assignmentEpoch: 2,
        expectedKind: "attachment",
      },
    ]);
    expect(blocks).toEqual([
      { type: "text", text: "inspect this attachment" },
      {
        type: "resource_link",
        uri: "file:///private/execution-host/runtime-objects/b7e5e032-6049-48b2-806f-e5db714a93cb.1",
        name: "evidence.txt",
        mimeType: "text/plain",
        description: "uploaded evidence",
      },
    ]);
  });

  it("does not invoke the object resolver for a prompt with no object references", async () => {
    const blocks = await resolvePromptRuntimeObjects({
      blocks: [{ type: "text", text: "plain prompt" }],
      resolver: {
        async resolvePromptReference() {
          throw new Error("unexpected object resolution");
        },
      },
      runId: "run-1",
      assignmentId: "a0f7f6c8-9f3b-471e-8e0d-74af1bf4c7a8",
      assignmentEpoch: 2,
    });

    expect(blocks).toEqual([{ type: "text", text: "plain prompt" }]);
  });
});
