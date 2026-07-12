import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("database migration CLI contract", () => {
  it("loads the server-only shim before Playwright starts the web server", async () => {
    const root = process.cwd();
    const packageJson = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const preflight = await readFile(
      join(root, "e2e/_seed/prepare-db.ts"),
      "utf8",
    );
    const playwrightConfig = await readFile(
      join(root, "playwright.config.ts"),
      "utf8",
    );

    expect(packageJson.scripts["db:migrate"]).toContain(
      "tsx --import ./scripts/_register-shim.mjs lib/db/migrate.ts",
    );
    expect(preflight).toContain(
      "pnpm exec tsx --import ./scripts/_register-shim.mjs lib/db/migrate.ts",
    );
    expect(playwrightConfig).toContain(
      "pnpm e2e:preflight && pnpm exec next dev",
    );
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
