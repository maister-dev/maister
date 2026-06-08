import { describe, expect, it, vi } from "vitest";

import {
  assertDraftVersion,
  canonicalAuthoredContentHash,
  createAuthoredCapability,
  publishAuthoredCapabilityLocal,
  type AuthoredCapabilityKind,
} from "@/lib/catalog/authored-service";
import { isMaisterError, MaisterError } from "@/lib/errors";

describe("canonicalAuthoredContentHash", () => {
  it("is stable across object key order", () => {
    const first = canonicalAuthoredContentHash({
      kind: "rule",
      body: { title: "Review", content: "Check tests" },
    });
    const second = canonicalAuthoredContentHash({
      body: { content: "Check tests", title: "Review" },
      kind: "rule",
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("includes the capability kind in the hash", () => {
    const kinds = ["rule", "skill", "flow"] satisfies AuthoredCapabilityKind[];

    expect(
      new Set(
        kinds.map((kind) =>
          canonicalAuthoredContentHash({
            kind,
            body: { title: "Same body", content: "Same body" },
          }),
        ),
      ).size,
    ).toBe(3);
  });
});

describe("assertDraftVersion", () => {
  it("throws CONFLICT for stale draft edits", () => {
    let caught: unknown;

    try {
      assertDraftVersion({ expectedDraftVersion: 4, actualDraftVersion: 5 });
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as MaisterError).code).toBe("CONFLICT");
  });
});

describe("createAuthoredCapability", () => {
  it("maps duplicate project/kind/slug rows to CONFLICT", async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: "project-1" }] })
        .mockRejectedValueOnce({
          code: "23505",
          constraint: "authored_capabilities_project_kind_slug_uq",
        }),
    };
    const db = {
      execute: vi.fn(),
      transaction: vi.fn((fn) => fn(tx)),
    };

    await expect(
      createAuthoredCapability({
        projectSlug: "demo",
        input: {
          kind: "flow",
          slug: "release-review",
          title: "Release review",
        },
        db,
      }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("release-review"),
    });
  });
});

describe("publishAuthoredCapabilityLocal", () => {
  it("validates the loaded draft inside the publish transaction", async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: "project-1" }] })
        .mockResolvedValueOnce({ rows: [capabilityRow({ draftVersion: 2 })] })
        .mockResolvedValueOnce({ rows: [revisionRow({ draftVersion: 2 })] }),
    };
    const db = {
      execute: vi.fn(),
      transaction: vi.fn((fn) => fn(tx)),
    };

    await expect(
      publishAuthoredCapabilityLocal({
        projectSlug: "demo",
        capId: "cap-1",
        expectedDraftVersion: 2,
        validateDraftRevision: () => {
          throw new MaisterError("CONFIG", "draft package is invalid");
        },
        db,
      }),
    ).rejects.toMatchObject({ code: "CONFIG" });

    expect(tx.execute).toHaveBeenCalledTimes(3);
  });

  it("refuses stale publish requests before mutating rows", async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ id: "project-1" }] })
        .mockResolvedValueOnce({ rows: [capabilityRow({ draftVersion: 2 })] })
        .mockResolvedValueOnce({ rows: [revisionRow({ draftVersion: 2 })] }),
    };
    const db = {
      execute: vi.fn(),
      transaction: vi.fn((fn) => fn(tx)),
    };

    await expect(
      publishAuthoredCapabilityLocal({
        projectSlug: "demo",
        capId: "cap-1",
        expectedDraftVersion: 1,
        db,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(tx.execute).toHaveBeenCalledTimes(3);
  });
});

function capabilityRow(args: {
  draftVersion: number;
}): Record<string, unknown> {
  return {
    id: "cap-1",
    project_id: "project-1",
    kind: "flow",
    slug: "release-review",
    title: "Release review",
    lifecycle: "DRAFT",
    draft_version: args.draftVersion,
    current_draft_revision_id: "rev-1",
    current_published_revision_id: null,
    archived_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function revisionRow(args: { draftVersion: number }): Record<string, unknown> {
  return {
    id: "rev-1",
    capability_id: "cap-1",
    project_id: "project-1",
    kind: "flow",
    revision_number: 1,
    lifecycle: "DRAFT",
    draft_version: args.draftVersion,
    title: "Release review",
    body: { flowYaml: "foo: bar\n" },
    manifest: null,
    schema_version: 1,
    content_hash: "hash",
    created_at: new Date(),
    published_at: null,
    archived_at: null,
  };
}
