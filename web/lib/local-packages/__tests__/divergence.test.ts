import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getTableName } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { computeUpstreamDivergence } from "@/lib/local-packages/divergence";
import { isMaisterError } from "@/lib/errors";

// ADR-129 §d prerequisite (T17): fork-vs-source divergence is a pure local
// byte comparison — ours = the fork working dir (or a chosen cut's bundle),
// theirs = the lineage source install's bundle. Paths in the DTO are
// PACKAGE-RELATIVE (never absolute host paths), `.git/` and runtime dirs are
// excluded, and a GC'd source degrades to a typed CONFIG the UI can render.

let oursDir: string;
let theirsDir: string;
let cutDir: string;

const state = {
  localPackages: [] as Record<string, unknown>[],
  packageInstalls: [] as Record<string, unknown>[],
};

// Extract string params from a drizzle SQL predicate (eq(col, "x") carries a
// Param{value:"x"} inside queryChunks) so the fake can serve BY-ID lookups
// honestly — the source and cut installs are fetched by different ids.
function predicateParams(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  const rec = node as Record<string, unknown>;

  if (typeof rec.value === "string") out.push(rec.value);
  if (Array.isArray(rec.queryChunks)) {
    for (const chunk of rec.queryChunks) predicateParams(chunk, out);
  }

  return out;
}

// FIXME(any): minimal fake drizzle — table-identity dispatch via getTableName.
const fakeDb = {
  select: () => ({
    from: (table: unknown) => {
      const name = getTableName(table as never);
      const rows =
        name === "local_packages"
          ? state.localPackages
          : name === "package_installs"
            ? state.packageInstalls
            : [];

      return {
        where: (predicate: unknown) => {
          const params = predicateParams(predicate);
          const matched = rows.filter((r) =>
            params.includes(String(r.id ?? "")),
          );

          return Promise.resolve(params.length > 0 ? matched : rows);
        },
      };
    },
  }),
} as never;

beforeAll(async () => {
  oursDir = await mkdtemp(join(tmpdir(), "div-ours-"));
  theirsDir = await mkdtemp(join(tmpdir(), "div-theirs-"));
  cutDir = await mkdtemp(join(tmpdir(), "div-cut-"));
});

afterAll(async () => {
  for (const dir of [oursDir, theirsDir, cutDir]) {
    await rm(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  state.localPackages = [
    {
      id: "lp1",
      name: "demo",
      slug: "demo",
      status: "active",
      workingDir: oursDir,
      sourceInstallId: "inst-src",
    },
  ];
  state.packageInstalls = [
    {
      id: "inst-src",
      name: "demo",
      versionLabel: "demo/v1.0.0",
      installedPath: theirsDir,
      sourceLocalPackageId: null,
    },
  ];
});

async function seedFile(
  root: string,
  rel: string,
  content: string,
): Promise<void> {
  await mkdir(join(root, rel, ".."), { recursive: true });
  await writeFile(join(root, rel), content);
}

describe("computeUpstreamDivergence", () => {
  it("identical trees → empty divergence (changedCount 0)", async () => {
    await seedFile(oursDir, "maister-package.yaml", "name: demo\n");
    await seedFile(theirsDir, "maister-package.yaml", "name: demo\n");

    const result = await computeUpstreamDivergence({
      localPackageId: "lp1",
      db: fakeDb,
    });

    expect(result.changedCount).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.base).toEqual({
      installId: "inst-src",
      versionLabel: "demo/v1.0.0",
    });
    expect(result.compared).toEqual({ kind: "working_dir" });
  });

  it("modified/added/deleted files appear with PACKAGE-RELATIVE paths; .git/ is excluded", async () => {
    await seedFile(oursDir, "flows/flow-a/flow.yaml", "name: edited\n");
    await seedFile(theirsDir, "flows/flow-a/flow.yaml", "name: original\n");
    await seedFile(oursDir, "skills/new-skill.md", "added by fork\n");
    await seedFile(theirsDir, "rules/gone.md", "deleted in fork\n");
    // A fork working dir carries .git/ — never part of the divergence.
    await seedFile(oursDir, ".git/HEAD", "ref: refs/heads/main\n");

    const result = await computeUpstreamDivergence({
      localPackageId: "lp1",
      db: fakeDb,
    });
    const paths = result.files.map((f) => f.path).sort();

    expect(paths).toEqual([
      "flows/flow-a/flow.yaml",
      "rules/gone.md",
      "skills/new-skill.md",
    ]);
    expect(result.changedCount).toBe(3);
    for (const p of paths) expect(p.startsWith("/")).toBe(false);
    expect(paths.some((p) => p.includes(".git"))).toBe(false);
  });

  it("element prefix narrows the divergence to that subtree", async () => {
    const result = await computeUpstreamDivergence({
      localPackageId: "lp1",
      element: "flows/flow-a",
      db: fakeDb,
    });

    expect(result.files.map((f) => f.path)).toEqual(["flows/flow-a/flow.yaml"]);
    expect(result.changedCount).toBe(1);
  });

  it("compares a chosen CUT instead of the working dir, validating the cut belongs to this package", async () => {
    await seedFile(cutDir, "flows/flow-a/flow.yaml", "name: original\n");
    await seedFile(cutDir, "maister-package.yaml", "name: demo\n");
    state.packageInstalls = [
      {
        id: "inst-cut",
        name: "demo",
        versionLabel: "local-abcdef123456",
        installedPath: cutDir,
        sourceLocalPackageId: "lp1",
      },
      state.packageInstalls[0]!,
    ];

    const result = await computeUpstreamDivergence({
      localPackageId: "lp1",
      cutInstallId: "inst-cut",
      db: fakeDb,
    });

    expect(result.compared).toEqual({
      kind: "cut",
      installId: "inst-cut",
      versionLabel: "local-abcdef123456",
    });
    // The cut lacks the fork's added skill + still has rules/gone.md absent.
    const paths = result.files.map((f) => f.path);

    expect(paths).toContain("rules/gone.md");
    expect(paths).not.toContain("flows/flow-a/flow.yaml");
  });

  it("a cut install NOT cut from this package → CONFLICT (id is lineage-validated, never a raw path)", async () => {
    state.packageInstalls.push({
      id: "inst-foreign",
      name: "other",
      versionLabel: "local-ffffffffffff",
      installedPath: cutDir,
      sourceLocalPackageId: "lp-OTHER",
    });

    await expect(
      computeUpstreamDivergence({
        localPackageId: "lp1",
        cutInstallId: "inst-foreign",
        db: fakeDb,
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "CONFLICT",
    );
  });

  it("lineage-less package → CONFIG 'source install unavailable' degradation", async () => {
    state.localPackages = [
      { ...state.localPackages[0]!, sourceInstallId: null },
    ];

    await expect(
      computeUpstreamDivergence({ localPackageId: "lp1", db: fakeDb }),
    ).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "CONFIG",
    );
  });

  it("source install bytes GONE from disk → CONFIG degradation", async () => {
    state.packageInstalls = [
      {
        ...state.packageInstalls[0]!,
        installedPath: join(theirsDir, "vanished-subdir"),
      },
    ];

    await expect(
      computeUpstreamDivergence({ localPackageId: "lp1", db: fakeDb }),
    ).rejects.toSatisfy(
      (err: unknown) => isMaisterError(err) && err.code === "CONFIG",
    );
  });
});
