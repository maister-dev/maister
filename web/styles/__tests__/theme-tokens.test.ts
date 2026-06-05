import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("theme token contract", () => {
  it("exposes danger colors to Tailwind utilities", async () => {
    const css = await readFile(
      join(process.cwd(), "styles/globals.css"),
      "utf8",
    );
    const themeInline = css.match(/@theme inline\s*\{(?<body>[\s\S]*?)\n\}/u);

    expect(themeInline?.groups?.body).toContain(
      "--color-danger: var(--danger);",
    );
    expect(themeInline?.groups?.body).toContain(
      "--color-danger-soft: var(--danger-soft);",
    );
  });
});
