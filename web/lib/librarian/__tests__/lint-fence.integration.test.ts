import { fileURLToPath } from "node:url";
import path from "node:path";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const webRoot = fileURLToPath(new URL("../../../", import.meta.url));
const configPath = path.join(webRoot, "eslint.config.mjs");
const probePath = path.join(webRoot, "lib/librarian/memory-fence-probe.ts");

describe("IT-LMM-11: personal librarian imports cannot cross into shared memory stores", () => {
  it("rejects Project Brain and agent memory imports through the shipped ESLint config", async () => {
    const eslint = new ESLint({ cwd: webRoot, overrideConfigFile: configPath });
    const [result] = await eslint.lintText(
      [
        'import "@/lib/brain/store";',
        'import "@/lib/agents/memory-store";',
      ].join("\n"),
      { filePath: probePath },
    );
    const restricted = result.messages.filter(
      (message) => message.ruleId === "no-restricted-imports",
    );

    expect(restricted).toHaveLength(2);
  });
});
