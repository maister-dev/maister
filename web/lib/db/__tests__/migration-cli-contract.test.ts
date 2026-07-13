import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("database migration CLI contract", () => {
  it("keeps migration ownership in the E2E wrapper before Playwright starts", async () => {
    const root = process.cwd();
    const packageJson = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const preflight = await readFile(
      join(root, "e2e/_seed/prepare-db.ts"),
      "utf8",
    );
    const wrapper = await readFile(join(root, "e2e/run.ts"), "utf8");

    expect(packageJson.scripts["db:migrate"]).toContain(
      "tsx --import ./scripts/_register-shim.mjs lib/db/migrate.ts",
    );
    expect(preflight).toContain("prepareE2eDatabase(");
    expect(preflight).toContain("lib/db/migrate.ts");
    expect(preflight).toContain("lib/db/migrate-brain.ts");
    expect(wrapper).toContain("prepareE2eDatabase");
    expect(packageJson.scripts["test:e2e"]).toBe("tsx e2e/run.ts");
    expect(packageJson.scripts["e2e:preflight"]).toBeUndefined();
  });

  it("loads the same layered environment source as the web runtime", async () => {
    const config = await readFile(
      join(process.cwd(), "drizzle.config.ts"),
      "utf8",
    );

    expect(config).toContain('import "./lib/load-env"');
    expect(config).not.toContain('import "dotenv/config"');
  });
});
