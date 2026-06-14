import { describe, expect, it } from "vitest";

import {
  deriveUpdateAvailable,
  parsePackageTags,
} from "@/lib/packages/catalog";

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
