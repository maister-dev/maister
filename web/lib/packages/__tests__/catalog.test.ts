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
    { name: "aif", tags: ["aif/v2.1.0", "aif/v2.0.0"] },
    { name: "core", tags: [] },
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
