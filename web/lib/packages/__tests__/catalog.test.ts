import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyVersionTargets,
  createPackageSource,
  deriveUpdateAvailable,
  packageSourceCreateBodySchema,
  packageSourceUpdateBodySchema,
  parsePackageTags,
} from "@/lib/packages/catalog";

describe("packageSourceCreateBodySchema (ADR-129 kind/baseBranch)", () => {
  it("defaults kind to git when absent and accepts kind local", () => {
    expect(
      packageSourceCreateBodySchema.parse({ url: "https://example.com/repo" }),
    ).toMatchObject({ kind: "git" });
    expect(
      packageSourceCreateBodySchema.parse({
        url: "/Users/dev/maister-plugins",
        kind: "local",
      }),
    ).toMatchObject({ kind: "local" });
  });

  it("refuses an unknown kind and an empty baseBranch", () => {
    expect(
      packageSourceCreateBodySchema.safeParse({ url: "u", kind: "svn" })
        .success,
    ).toBe(false);
    expect(
      packageSourceCreateBodySchema.safeParse({ url: "u", baseBranch: "" })
        .success,
    ).toBe(false);
  });

  it("accepts a non-empty baseBranch for git sources", () => {
    expect(
      packageSourceCreateBodySchema.parse({
        url: "https://example.com/repo",
        baseBranch: "develop",
      }),
    ).toMatchObject({ baseBranch: "develop" });
  });
});

describe("packageSourceUpdateBodySchema (ADR-129 baseBranch SET/CLEAR)", () => {
  it("accepts a baseBranch set and an explicit null clear", () => {
    expect(
      packageSourceUpdateBodySchema.parse({ baseBranch: "develop" }),
    ).toMatchObject({ baseBranch: "develop" });
    expect(
      packageSourceUpdateBodySchema.parse({ baseBranch: null }),
    ).toMatchObject({ baseBranch: null });
  });

  it("refuses an empty-string baseBranch (whitespace is not a branch)", () => {
    expect(
      packageSourceUpdateBodySchema.safeParse({ baseBranch: "" }).success,
    ).toBe(false);
  });
});

describe("parsePackageTags", () => {
  it("groups per-package tags newest-first and drops peeled/non-package refs", () => {
    const stdout = [
      "aaa\trefs/tags/aif/v1.0.0",
      "bbb\trefs/tags/aif/v2.0.0",
      "ccc\trefs/tags/aif/v2.0.0^{}",
      "ddd\trefs/tags/aif/v1.10.0",
      "eee\trefs/tags/core/v0.1.0",
      "fff\trefs/tags/standalone-tag",
      "ggg\trefs/heads/main",
      "",
    ].join("\n");

    const byName = parsePackageTags(stdout);

    expect([...byName.keys()].sort()).toEqual(["aif", "core"]);
    expect(byName.get("aif")).toEqual([
      "aif/v2.0.0",
      "aif/v1.10.0",
      "aif/v1.0.0",
    ]);
    expect(byName.get("core")).toEqual(["core/v0.1.0"]);
  });
});

describe("deriveUpdateAvailable", () => {
  const discovered = [
    { name: "aif", dir: "aif", tags: ["aif/v2.1.0", "aif/v2.0.0"] },
    { name: "core", dir: "core", tags: [] },
  ];

  it("flags an attachment older than the newest discovered tag", () => {
    expect(
      deriveUpdateAvailable({
        packageName: "aif",
        versionLabel: "aif/v2.0.0",
        discovered,
      }),
    ).toBe(true);
  });

  it("does not flag the newest version", () => {
    expect(
      deriveUpdateAvailable({
        packageName: "aif",
        versionLabel: "aif/v2.1.0",
        discovered,
      }),
    ).toBe(false);
  });

  it("never flags local versions or unknown packages", () => {
    expect(
      deriveUpdateAvailable({
        packageName: "aif",
        versionLabel: "local-abcdef123456",
        discovered,
      }),
    ).toBe(false);
    expect(
      deriveUpdateAvailable({
        packageName: "ghost",
        versionLabel: "ghost/v1.0.0",
        discovered,
      }),
    ).toBe(false);
    expect(
      deriveUpdateAvailable({
        packageName: "core",
        versionLabel: "core/v1.0.0",
        discovered,
      }),
    ).toBe(false);
  });
});

describe("classifyVersionTargets", () => {
  it("never offers an older install as an upgrade (the reported downgrade-as-upgrade bug)", () => {
    const result = classifyVersionTargets({
      currentVersionLabel: "aif/v2.1.0",
      candidates: [{ installId: "i-200", versionLabel: "aif/v2.0.0" }],
    });

    expect(result.upgrade).toBeNull();
    expect(result.downgrade).toEqual([
      { installId: "i-200", versionLabel: "aif/v2.0.0" },
    ]);
  });

  it("upgrades to the NEWEST strictly-newer install and lists older ones as downgrades", () => {
    const result = classifyVersionTargets({
      currentVersionLabel: "aif/v2.1.0",
      candidates: [
        { installId: "i-200", versionLabel: "aif/v2.0.0" },
        { installId: "i-220", versionLabel: "aif/v2.2.0" },
        { installId: "i-300", versionLabel: "aif/v3.0.0" },
        { installId: "i-100", versionLabel: "aif/v1.0.0" },
      ],
    });

    expect(result.upgrade).toEqual({
      installId: "i-300",
      versionLabel: "aif/v3.0.0",
    });
    // Downgrades sorted closest-first (newest-of-the-older first).
    expect(result.downgrade).toEqual([
      { installId: "i-200", versionLabel: "aif/v2.0.0" },
      { installId: "i-100", versionLabel: "aif/v1.0.0" },
    ]);
  });

  it("skips off-catalog labels (local-*, no /v) and equal versions", () => {
    expect(
      classifyVersionTargets({
        currentVersionLabel: "local-abcdef123456",
        candidates: [{ installId: "i-200", versionLabel: "aif/v2.0.0" }],
      }),
    ).toEqual({ upgrade: null, downgrade: [] });

    const result = classifyVersionTargets({
      currentVersionLabel: "aif/v2.0.0",
      candidates: [
        { installId: "i-local", versionLabel: "local-deadbeef0001" },
        { installId: "i-same", versionLabel: "aif/v2.0.0" },
        { installId: "i-100", versionLabel: "aif/v1.0.0" },
      ],
    });

    expect(result.upgrade).toBeNull();
    expect(result.downgrade).toEqual([
      { installId: "i-100", versionLabel: "aif/v1.0.0" },
    ]);
  });
});

describe("staleness filter (startup debounce)", () => {
  const now = new Date("2026-06-12T12:00:00Z");
  const hoursAgo = (h: number): Date =>
    new Date(now.getTime() - h * 60 * 60 * 1000);

  it("selects enabled sources never checked or past the window", async () => {
    const { staleSourceFilter } = await import("@/lib/packages/catalog");

    const ids = staleSourceFilter(
      [
        { id: "never", enabled: true, lastCheckedAt: null },
        { id: "old", enabled: true, lastCheckedAt: hoursAgo(25) },
        { id: "fresh", enabled: true, lastCheckedAt: hoursAgo(1) },
        { id: "disabled", enabled: false, lastCheckedAt: null },
      ],
      now,
      24,
    );

    expect(ids).toEqual(["never", "old"]);
  });

  it("reads the window from env with a 24h default", async () => {
    const { discoveryStaleHours } = await import("@/lib/packages/catalog");

    expect(discoveryStaleHours({} as NodeJS.ProcessEnv)).toBe(24);
    expect(
      discoveryStaleHours({
        MAISTER_PACKAGE_DISCOVERY_STALE_HOURS: "6",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(6);
    expect(
      discoveryStaleHours({
        MAISTER_PACKAGE_DISCOVERY_STALE_HOURS: "garbage",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(24);
    expect(
      discoveryStaleHours({
        MAISTER_PACKAGE_DISCOVERY_STALE_HOURS: "-5",
      } as unknown as NodeJS.ProcessEnv),
    ).toBe(24);
  });
});

describe("defaultPackageSourceUrls (default-source env parse)", () => {
  it("returns the built-in default list when the env is unset", async () => {
    const { defaultPackageSourceUrls, DEFAULT_PACKAGE_SOURCE_URLS } =
      await import("@/lib/packages/catalog");

    expect(defaultPackageSourceUrls({} as NodeJS.ProcessEnv)).toEqual(
      DEFAULT_PACKAGE_SOURCE_URLS,
    );
  });

  it("parses a CSV list and trims surrounding whitespace", async () => {
    const { defaultPackageSourceUrls } = await import("@/lib/packages/catalog");

    expect(
      defaultPackageSourceUrls({
        MAISTER_DEFAULT_PACKAGE_SOURCES:
          " https://a.example/x , https://b.example/y ",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual(["https://a.example/x", "https://b.example/y"]);
  });

  it("de-duplicates repeated urls", async () => {
    const { defaultPackageSourceUrls } = await import("@/lib/packages/catalog");

    expect(
      defaultPackageSourceUrls({
        MAISTER_DEFAULT_PACKAGE_SOURCES:
          "https://a.example/x,https://a.example/x",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual(["https://a.example/x"]);
  });

  it("treats an empty or whitespace-only value as opt-out", async () => {
    const { defaultPackageSourceUrls } = await import("@/lib/packages/catalog");

    expect(
      defaultPackageSourceUrls({
        MAISTER_DEFAULT_PACKAGE_SOURCES: "",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual([]);
    expect(
      defaultPackageSourceUrls({
        MAISTER_DEFAULT_PACKAGE_SOURCES: "   ",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual([]);
  });

  it("drops blank entries among valid ones", async () => {
    const { defaultPackageSourceUrls } = await import("@/lib/packages/catalog");

    expect(
      defaultPackageSourceUrls({
        MAISTER_DEFAULT_PACKAGE_SOURCES:
          "https://a.example/x,,  ,https://b.example/y",
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual(["https://a.example/x", "https://b.example/y"]);
  });
});

describe("createPackageSource kind:git url validation (ADR-129 hardening)", () => {
  function recordingDb(): { db: any; inserted: Record<string, unknown>[] } {
    const inserted: Record<string, unknown>[] = [];

    return {
      inserted,
      db: {
        insert: () => ({
          values: (values: Record<string, unknown>) => {
            inserted.push(values);

            return {
              onConflictDoNothing: () => ({
                returning: async () => [{ id: values.id }],
              }),
            };
          },
        }),
      },
    };
  }

  // Both the plain forms AND the scp-shaped bypasses (`<helper>::…@host:` and
  // `-flag…@host:`) that slip the bare `[^/@]+@[^/:]+:` scp regex.
  it.each([
    ["plain ext::", "ext::sh -c 'id'"],
    ["scp-shaped ext:: (slash-free)", "ext::sh${IFS}-c${IFS}id;x@h:"],
    ["scp-shaped ext:: (spaced)", "ext::sh -c touch${IFS}MARKER;x@h:"],
    ["option-shaped scp host", "-oProxyCommand=evil@host:path"],
    ["option-shaped scheme", "--upload-pack=evil"],
  ])(
    "refuses a %s url before any persistence (no RCE remote)",
    async (_label, url) => {
      const { db, inserted } = recordingDb();

      await expect(
        createPackageSource({ url, kind: "git", db }),
      ).rejects.toMatchObject({ code: "PRECONDITION" });
      expect(inserted).toHaveLength(0);
    },
  );

  it("accepts a legitimate scp remote", async () => {
    const { db, inserted } = recordingDb();

    await createPackageSource({ url: "git@github.com:org/repo.git", db });
    expect(inserted).toHaveLength(1);
  });

  it("accepts an https git url (default kind)", async () => {
    const { db, inserted } = recordingDb();

    await createPackageSource({ url: "https://example.com/repo.git", db });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ kind: "git" });
  });
});

describe("createPackageSource kind:local path validation (ADR-129)", () => {
  function recordingDb(): { db: any; inserted: Record<string, unknown>[] } {
    const inserted: Record<string, unknown>[] = [];

    return {
      inserted,
      db: {
        insert: () => ({
          values: (values: Record<string, unknown>) => {
            inserted.push(values);

            return {
              onConflictDoNothing: () => ({
                returning: async () => [{ id: values.id }],
              }),
            };
          },
        }),
      },
    };
  }

  it("refuses a relative path with CONFIG before any persistence", async () => {
    const { db, inserted } = recordingDb();

    await expect(
      createPackageSource({ url: "relative/dir", kind: "local", db }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    expect(inserted).toHaveLength(0);
  });

  it("refuses a missing directory with CONFIG", async () => {
    const { db, inserted } = recordingDb();

    await expect(
      createPackageSource({
        url: join(tmpdir(), `nope-${Date.now()}`),
        kind: "local",
        db,
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });
    expect(inserted).toHaveLength(0);
  });

  it("refuses a directory without any maister-package.yaml with CONFIG", async () => {
    const dir = await mkdtemp(join(tmpdir(), "src-empty-"));
    const { db, inserted } = recordingDb();

    try {
      await expect(
        createPackageSource({ url: dir, kind: "local", db }),
      ).rejects.toMatchObject({ code: "CONFIG" });
      expect(inserted).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a root-manifest dir and persists kind local", async () => {
    const dir = await mkdtemp(join(tmpdir(), "src-root-"));

    await writeFile(join(dir, "maister-package.yaml"), "schemaVersion: 1\n");
    const { db, inserted } = recordingDb();

    try {
      await createPackageSource({ url: dir, kind: "local", db });
      expect(inserted[0]).toMatchObject({ url: dir, kind: "local" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a packages/*/maister-package.yaml monorepo layout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "src-mono-"));

    await mkdir(join(dir, "packages/aif"), { recursive: true });
    await writeFile(
      join(dir, "packages/aif/maister-package.yaml"),
      "schemaVersion: 1\n",
    );
    const { db, inserted } = recordingDb();

    try {
      await createPackageSource({ url: dir, kind: "local", db });
      expect(inserted[0]).toMatchObject({ url: dir, kind: "local" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a git source keeps the unvalidated fast path (no fs probe on URLs)", async () => {
    const { db, inserted } = recordingDb();

    await createPackageSource({
      url: "https://example.com/org/repo",
      kind: "git",
      db,
    });
    expect(inserted[0]).toMatchObject({ kind: "git" });
  });
});

describe("digest-as-version carve by SOURCE KIND (ADR-129)", () => {
  const localDiscovered = [
    {
      name: "aif",
      dir: "aif",
      tags: [],
      digestVersionLabel: "local-aaaaaaaaaaaa",
    },
  ];

  it("deriveUpdateAvailable flags a kind:local attachment whose discovered digest drifted", () => {
    expect(
      deriveUpdateAvailable({
        packageName: "aif",
        versionLabel: "local-000000000000",
        discovered: localDiscovered,
        sourceKind: "local",
      }),
    ).toBe(true);
  });

  it("deriveUpdateAvailable stays quiet when the pinned digest IS the discovered digest", () => {
    expect(
      deriveUpdateAvailable({
        packageName: "aif",
        versionLabel: "local-aaaaaaaaaaaa",
        discovered: localDiscovered,
        sourceKind: "local",
      }),
    ).toBe(false);
  });

  it("Studio-cut installs (no source row → no kind) keep the existing local-* skip", () => {
    expect(
      deriveUpdateAvailable({
        packageName: "aif",
        versionLabel: "local-000000000000",
        discovered: localDiscovered,
      }),
    ).toBe(false);
  });

  it("classifyVersionTargets offers the discovered-digest install as the upgrade for kind:local (no ordered downgrades)", () => {
    const result = classifyVersionTargets({
      currentVersionLabel: "local-000000000000",
      candidates: [
        { installId: "i-new", versionLabel: "local-aaaaaaaaaaaa" },
        { installId: "i-old", versionLabel: "local-bbbbbbbbbbbb" },
      ],
      sourceKind: "local",
      discoveredDigestLabel: "local-aaaaaaaaaaaa",
    });

    expect(result.upgrade).toEqual({
      installId: "i-new",
      versionLabel: "local-aaaaaaaaaaaa",
    });
    expect(result.downgrade).toEqual([]);
  });

  it("classifyVersionTargets returns no upgrade when the discovered digest is the current pin or not installed", () => {
    expect(
      classifyVersionTargets({
        currentVersionLabel: "local-aaaaaaaaaaaa",
        candidates: [{ installId: "i-x", versionLabel: "local-bbbbbbbbbbbb" }],
        sourceKind: "local",
        discoveredDigestLabel: "local-aaaaaaaaaaaa",
      }).upgrade,
    ).toBeNull();
    expect(
      classifyVersionTargets({
        currentVersionLabel: "local-000000000000",
        candidates: [{ installId: "i-x", versionLabel: "local-bbbbbbbbbbbb" }],
        sourceKind: "local",
        discoveredDigestLabel: "local-aaaaaaaaaaaa",
      }).upgrade,
    ).toBeNull();
  });
});
