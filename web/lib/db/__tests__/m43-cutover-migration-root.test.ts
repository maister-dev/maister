import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMigrationRootBefore } from "@/lib/db/m43-cutover-migration-root";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("M43 temporary migration root", () => {
  it("preserves the complete journal prefix before the cut-over", async () => {
    const source = await mkdtemp(join(tmpdir(), "maister-migration-source-"));

    temporaryRoots.push(source);

    await mkdir(join(source, "meta"), { recursive: true });
    await writeFile(join(source, "0001_first.sql"), "SELECT 1;");
    await writeFile(join(source, "0092_before.sql"), "SELECT 2;");
    await writeFile(join(source, "0093_mcp_management_v2.sql"), "SELECT 3;");
    await writeFile(
      join(source, "0094_postgres_graph_only_cutover.sql"),
      "SELECT 4;",
    );
    await writeFile(
      join(source, "meta", "_journal.json"),
      JSON.stringify({
        entries: [
          { idx: 1, tag: "0001_first", when: 1 },
          { idx: 92, tag: "0092_before", when: 2 },
          { idx: 93, tag: "0093_mcp_management_v2", when: 3 },
          { idx: 94, tag: "0094_postgres_graph_only_cutover", when: 4 },
        ],
      }),
    );

    const root = await createMigrationRootBefore(
      source,
      "0094_postgres_graph_only_cutover",
    );

    temporaryRoots.push(root);

    const journal = JSON.parse(
      await readFile(join(root, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string; when: number }> };

    expect(journal.entries).toEqual([
      { idx: 1, tag: "0001_first", when: 1 },
      { idx: 92, tag: "0092_before", when: 2 },
      { idx: 93, tag: "0093_mcp_management_v2", when: 3 },
    ]);
    await expect(readFile(join(root, "0001_first.sql"), "utf8")).resolves.toBe(
      "SELECT 1;",
    );
    await expect(readFile(join(root, "0092_before.sql"), "utf8")).resolves.toBe(
      "SELECT 2;",
    );
    await expect(
      readFile(join(root, "0093_mcp_management_v2.sql"), "utf8"),
    ).resolves.toBe("SELECT 3;");
    await expect(
      readFile(join(root, "0094_postgres_graph_only_cutover.sql"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
