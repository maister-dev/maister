import type { DepsFile } from "@/lib/auto-promotion/deps-check";

import { describe, expect, it } from "vitest";

import {
  checkDepsDiff,
  isRegistryVersionSpecifier,
} from "@/lib/auto-promotion/deps-check";

function manifest(
  base: Record<string, unknown> | null,
  branch: Record<string, unknown> | null,
  status = "M",
): DepsFile {
  return {
    path: "package.json",
    status,
    base: base === null ? null : JSON.stringify(base),
    branch: branch === null ? null : JSON.stringify(branch),
  };
}

const PKG = (
  deps: Record<string, string>,
  extra: Record<string, unknown> = {},
) => ({
  name: "x",
  version: "1.0.0",
  ...extra,
  dependencies: deps,
});

describe("isRegistryVersionSpecifier — accepts the registry range grammar", () => {
  it.each([
    "1.2.3",
    "^1.2.3",
    "~1.2",
    ">=1.0.0 <2.0.0",
    "1.2.3 - 2.3.4",
    "1.x",
    "*",
    "1 || 2",
    "1.2.3-beta.1",
    "v1.2.3",
  ])("accepts %s", (s) => {
    expect(isRegistryVersionSpecifier(s)).toBe(true);
  });
});

describe("isRegistryVersionSpecifier — rejects protocol/path/alias (protocol-swap defense)", () => {
  it.each([
    "file:../x",
    "git+https://github.com/o/r.git",
    "git://github.com/o/r",
    "github:o/r",
    "gitlab:o/r",
    "link:../p",
    "portal:../p",
    "ssh://git@host/x",
    "http://x.test/a.tgz",
    "https://x.test/a.tgz",
    "workspace:*",
    "npm:alias@1.0.0",
    "./local",
    "../up",
    "/abs",
    "o/r",
    "latest",
    "",
  ])("rejects %s", (s) => {
    expect(isRegistryVersionSpecifier(s)).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(isRegistryVersionSpecifier(123 as unknown)).toBe(false);
    expect(isRegistryVersionSpecifier(null)).toBe(false);
  });
});

describe("checkDepsDiff — manifest gate", () => {
  it("registry version bump ⇒ ok", () => {
    const r = checkDepsDiff([
      manifest(PKG({ a: "^1.0.0" }), PKG({ a: "^1.1.0" })),
    ]);

    expect(r.ok).toBe(true);
  });

  it("change outside dependency blocks (scripts) ⇒ deps_content", () => {
    const r = checkDepsDiff([
      manifest(
        PKG({ a: "^1.0.0" }, { scripts: { build: "x" } }),
        PKG({ a: "^1.0.0" }, { scripts: { build: "y" } }),
      ),
    ]);

    expect(r.ok).toBe(false);
  });

  it("dependency added ⇒ deps_content", () => {
    const r = checkDepsDiff([
      manifest(PKG({ a: "^1.0.0" }), PKG({ a: "^1.0.0", b: "^2.0.0" })),
    ]);

    expect(r.ok).toBe(false);
  });

  it("dependency removed ⇒ deps_content", () => {
    const r = checkDepsDiff([
      manifest(PKG({ a: "^1.0.0", b: "^2.0.0" }), PKG({ a: "^1.0.0" })),
    ]);

    expect(r.ok).toBe(false);
  });

  it("malformed JSON ⇒ deps_content, never throws", () => {
    const r = checkDepsDiff([
      {
        path: "package.json",
        status: "M",
        base: "{ not json",
        branch: JSON.stringify(PKG({ a: "^1.0.0" })),
      },
    ]);

    expect(r.ok).toBe(false);
  });

  it("manifest added (status A) ⇒ deps_content", () => {
    const r = checkDepsDiff([manifest(null, PKG({ a: "^1.0.0" }), "A")]);

    expect(r.ok).toBe(false);
  });

  it("manifest deleted (status D) ⇒ deps_content", () => {
    const r = checkDepsDiff([manifest(PKG({ a: "^1.0.0" }), null, "D")]);

    expect(r.ok).toBe(false);
  });
});

describe("checkDepsDiff — protocol-swap: one RED case per rejected family, both sides", () => {
  const bad = [
    "file:../x",
    "git+https://github.com/o/r.git",
    "github:o/r",
    "link:../p",
    "portal:../p",
    "workspace:*",
    "npm:alias@1.0.0",
    "../bare/path",
  ];

  it.each(bad)("new side swapped to %s ⇒ deps_content", (spec) => {
    const r = checkDepsDiff([manifest(PKG({ a: "^1.0.0" }), PKG({ a: spec }))]);

    expect(r.ok).toBe(false);
  });

  it.each(bad)("base side is %s ⇒ deps_content", (spec) => {
    const r = checkDepsDiff([manifest(PKG({ a: spec }), PKG({ a: "^1.0.0" }))]);

    expect(r.ok).toBe(false);
  });
});

describe("checkDepsDiff — lockfile rules", () => {
  it("lockfile-only diff (no manifest change) ⇒ deps_content", () => {
    const r = checkDepsDiff([
      { path: "pnpm-lock.yaml", status: "M", base: "a: 1", branch: "a: 2" },
    ]);

    expect(r.ok).toBe(false);
  });

  it("registry manifest bump + benign lockfile ⇒ ok", () => {
    const r = checkDepsDiff([
      manifest(PKG({ a: "^1.0.0" }), PKG({ a: "^1.1.0" })),
      {
        path: "pnpm-lock.yaml",
        status: "M",
        base: "a@1.0.0:\n  resolution: {registry: 'a-1.0.0'}",
        branch: "a@1.1.0:\n  resolution: {registry: 'a-1.1.0'}",
      },
    ]);

    expect(r.ok).toBe(true);
  });

  it("manifest bump + lockfile introducing a git+ resolution ⇒ deps_content", () => {
    const r = checkDepsDiff([
      manifest(PKG({ a: "^1.0.0" }), PKG({ a: "^1.1.0" })),
      {
        path: "pnpm-lock.yaml",
        status: "M",
        base: "a@1.0.0:",
        branch: "a@1.1.0:\n  resolution: git+https://github.com/o/r.git",
      },
    ]);

    expect(r.ok).toBe(false);
  });

  it("manifest bump + lockfile introducing an off-registry http host ⇒ deps_content", () => {
    const r = checkDepsDiff([
      manifest(PKG({ a: "^1.0.0" }), PKG({ a: "^1.1.0" })),
      {
        path: "pnpm-lock.yaml",
        status: "M",
        base: "a@1.0.0:",
        branch: "a@1.1.0:\n  resolved: https://evil.test/a.tgz",
      },
    ]);

    expect(r.ok).toBe(false);
  });
});
