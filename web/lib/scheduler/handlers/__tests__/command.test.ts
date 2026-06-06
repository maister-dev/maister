import { describe, expect, it } from "vitest";

import { runCommandJob } from "@/lib/scheduler/handlers/command";

describe("runCommandJob console_ping host validation", () => {
  it("rejects option-like ping hosts before spawning ping", async () => {
    await expect(
      runCommandJob({
        commandKind: "console_ping",
        host: "-c",
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("rejects empty labels", async () => {
    await expect(
      runCommandJob({
        commandKind: "console_ping",
        host: "example..com",
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });
});
