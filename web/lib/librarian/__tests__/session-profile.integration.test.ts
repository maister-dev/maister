import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import {
  materializeLibrarianAdapterSettings,
  materializeLibrarianSummaryAdapterSettings,
} from "@/lib/librarian/session-profile";

it("IT-LAU-11: Claude owner and summary sessions deny host built-ins on disk", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "librarian-profile-"));

  try {
    const result = await materializeLibrarianAdapterSettings(cwd, "claude");
    const settingsPath = path.join(cwd, ".claude", "settings.local.json");
    const ownerSettings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      permissions: { allow: string[]; deny: string[] };
    };

    expect(result.materialized).toBe(true);
    expect(ownerSettings.permissions.allow).toEqual(["mcp__maister"]);
    expect(ownerSettings.permissions.deny).toEqual(
      expect.arrayContaining([
        "Read",
        "Glob",
        "Grep",
        "WebFetch",
        "WebSearch",
        "Bash",
        "Edit",
        "Write",
      ]),
    );

    await materializeLibrarianSummaryAdapterSettings(cwd, "claude");
    const summarySettings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      permissions: { allow: string[]; deny: string[] };
    };

    expect(summarySettings.permissions.allow).toEqual([]);
    expect(summarySettings.permissions.deny).toEqual(
      ownerSettings.permissions.deny,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
