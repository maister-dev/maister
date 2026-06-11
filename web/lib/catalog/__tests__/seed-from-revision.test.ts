import { describe, expect, it } from "vitest";

import { resolveForkSlug } from "@/lib/catalog/seed-from-revision";
import { isMaisterError } from "@/lib/errors-core";

function existsIn(taken: Set<string>) {
  return (slug: string) => Promise.resolve(taken.has(slug));
}

describe("resolveForkSlug — probe (T2.2)", () => {
  it("uses the flowRefId default when it is free (no probe suffix)", async () => {
    const slug = await resolveForkSlug({
      defaultSlug: "bugfix",
      slugExists: existsIn(new Set()),
    });

    expect(slug).toBe("bugfix");
  });

  it("falls back to -fork when the default collides", async () => {
    const slug = await resolveForkSlug({
      defaultSlug: "bugfix",
      slugExists: existsIn(new Set(["bugfix"])),
    });

    expect(slug).toBe("bugfix-fork");
  });

  it("falls back to -fork-2 when both the default and -fork collide", async () => {
    const slug = await resolveForkSlug({
      defaultSlug: "bugfix",
      slugExists: existsIn(new Set(["bugfix", "bugfix-fork"])),
    });

    expect(slug).toBe("bugfix-fork-2");
  });

  it("keeps incrementing the suffix until a free slug is found", async () => {
    const slug = await resolveForkSlug({
      defaultSlug: "bugfix",
      slugExists: existsIn(
        new Set(["bugfix", "bugfix-fork", "bugfix-fork-2", "bugfix-fork-3"]),
      ),
    });

    expect(slug).toBe("bugfix-fork-4");
  });

  it("returns an EXPLICIT slug verbatim when it is free (never probed)", async () => {
    const slug = await resolveForkSlug({
      explicitSlug: "my-edit",
      defaultSlug: "bugfix",
      slugExists: existsIn(new Set(["my-edit-fork"])),
    });

    expect(slug).toBe("my-edit");
  });

  it("throws CONFLICT (no probe) when an EXPLICIT slug collides", async () => {
    await expect(
      resolveForkSlug({
        explicitSlug: "my-edit",
        defaultSlug: "bugfix",
        slugExists: existsIn(new Set(["my-edit"])),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("throws a typed MaisterError on explicit collision", async () => {
    const err = await resolveForkSlug({
      explicitSlug: "taken",
      defaultSlug: "bugfix",
      slugExists: existsIn(new Set(["taken"])),
    }).catch((e: unknown) => e);

    expect(isMaisterError(err)).toBe(true);
  });
});
