// S4.2 / D9 step 4: page the whole run directory, account for every entry and
// every owner association, and prove an absent lane against the scope that was
// actually inspected. Nothing here reaches Postgres — the mapping is pure enough
// to be exercised against a real directory alone.

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { inventoryLegacyRun, type LegacyRunInventoryInput } from "../inventory";
import { relativePathDigest } from "../sources";

let runDirectory: string;

beforeEach(async () => {
  runDirectory = await mkdtemp(join(tmpdir(), "legacy-inventory-"));
  await writeFile(join(runDirectory, "run.events.jsonl"), "{}\n", "utf8");
  await writeFile(join(runDirectory, "cost.jsonl"), "{}\n", "utf8");
});

afterEach(async () => {
  await rm(runDirectory, { recursive: true, force: true });
});

function inventory(overrides: Partial<LegacyRunInventoryInput>) {
  return inventoryLegacyRun({
    runDirectory,
    runId: "run-1",
    frozenSourceId: "import-7f3a",
    associations: [],
    ...overrides,
  });
}

describe("inventoryLegacyRun", () => {
  it("accounts for an ordinary step log and a nested raw log the old audit refused", async () => {
    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");
    await mkdir(join(runDirectory, "steps", "plan"), { recursive: true });
    await writeFile(
      join(runDirectory, "steps", "plan", "attempt-2.log"),
      "second attempt\n",
      "utf8",
    );

    const result = await inventory({});

    expect(result.complete).toBe(true);
    expect(result.blocks).toEqual([]);
    expect(
      result.lanes.runtime_objects.items.map((item) => item.sourceClass),
    ).toEqual(["step_log", "step_log"]);
    expect(result.lanes.runtime_objects.expectedItems).toBe(2);
  });

  it("keeps an empty log valid history", async () => {
    await writeFile(join(runDirectory, "empty.log"), "", "utf8");

    const result = await inventory({});

    expect(result.complete).toBe(true);
    expect(result.lanes.runtime_objects.items).toHaveLength(1);
    expect(result.lanes.runtime_objects.items[0].size).toBe(0);
  });

  it("never leaves the events lane an empty proof while its raw source exists", async () => {
    const result = await inventory({});
    const events = result.lanes.events;

    expect(events.expectedItems).toBeGreaterThan(0);
    expect(events.items.map((item) => item.disposition)).toEqual([
      "manager_authoritative",
    ]);
    expect(events.items[0].sourceClass).toBe("raw_transcript");
    expect(result.lanes.transcript.items[0].disposition).toBe("copy");
    expect(result.lanes.events.items[0].itemId).not.toBe(
      result.lanes.transcript.items[0].itemId,
    );
  });

  it("records a scratch upload under the scratch session lane", async () => {
    await mkdir(join(runDirectory, "uploads", "msg-42"), { recursive: true });
    await writeFile(
      join(runDirectory, "uploads", "msg-42", "report.pdf"),
      "a report\n",
      "utf8",
    );

    const result = await inventory({});

    expect(result.lanes.scratch_session.items).toHaveLength(1);
    expect(result.lanes.scratch_session.items[0].sourceClass).toBe("upload");
  });

  it("blocks an unclassified source instead of completing the run", async () => {
    await writeFile(join(runDirectory, "mystery.bin"), " ", "utf8");

    const result = await inventory({});

    expect(result.complete).toBe(false);
    expect(result.blocks).toEqual([
      {
        lane: null,
        reason: "unclassified_source",
        relativePathDigest: relativePathDigest("mystery.bin"),
      },
    ]);
  });

  it("blocks a source that is not a regular file", async () => {
    await symlink(join(runDirectory, "cost.jsonl"), join(runDirectory, "alias.log"));

    const result = await inventory({});

    expect(result.complete).toBe(false);
    expect(result.blocks).toEqual([
      {
        lane: null,
        reason: "non_regular_source",
        relativePathDigest: relativePathDigest("alias.log"),
      },
    ]);
  });

  it("keeps duplicate references to one file distinct while their bytes stay equal", async () => {
    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");
    const result = await inventory({
      associations: [
        {
          associationKind: "artifact",
          id: "art-1",
          relativePath: "plan.log",
          rowFingerprint: "row-1",
        },
        {
          associationKind: "artifact",
          id: "art-2",
          relativePath: "plan.log",
          rowFingerprint: "row-2",
        },
      ],
    });

    const associationItems = result.lanes.runtime_objects.items.filter(
      (item) => item.associationKey !== "source",
    );

    expect(associationItems.map((item) => item.associationKey)).toEqual([
      "artifact:art-1",
      "artifact:art-2",
    ]);
    expect(new Set(associationItems.map((item) => item.sha256)).size).toBe(1);
    expect(new Set(associationItems.map((item) => item.itemId)).size).toBe(2);
    expect(result.complete).toBe(true);
  });

  it("gives an association item the source class of the payload it references", async () => {
    await mkdir(join(runDirectory, "uploads", "msg-42"), { recursive: true });
    await writeFile(
      join(runDirectory, "uploads", "msg-42", "note.txt"),
      "attached\n",
      "utf8",
    );

    const result = await inventory({
      associations: [
        {
          associationKind: "attachment",
          id: "att-1",
          relativePath: "uploads/msg-42/note.txt",
          rowFingerprint: "row-1",
        },
      ],
    });
    const association = result.lanes.scratch_session.items.find(
      (item) => item.associationKey === "attachment:att-1",
    );

    expect(association?.sourceClass).toBe("upload");
  });

  it("blocks the lane when an association names a payload the scan never saw", async () => {
    const result = await inventory({
      associations: [
        {
          associationKind: "artifact",
          id: "art-1",
          relativePath: "evidence/report.log",
          rowFingerprint: "row-1",
        },
      ],
    });

    expect(result.complete).toBe(false);
    expect(result.blocks).toEqual([
      {
        lane: "runtime_objects",
        reason: "missing_association_payload",
        relativePathDigest: relativePathDigest("evidence/report.log"),
      },
    ]);
  });

  it("proves an absent lane against the inspected scope rather than a blanket zero", async () => {
    const withoutUploads = await inventory({});
    await mkdir(join(runDirectory, "uploads", "msg-42"), { recursive: true });
    await writeFile(
      join(runDirectory, "uploads", "msg-42", "report.pdf"),
      "a report\n",
      "utf8",
    );
    const withUploads = await inventory({});

    expect(withoutUploads.lanes.scratch_session.expectedItems).toBe(0);
    expect(withoutUploads.lanes.scratch_session.inspectedScope).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(withoutUploads.lanes.scratch_session.manifestDigest).not.toBe(
      withUploads.lanes.scratch_session.manifestDigest,
    );
  });

  it("poisons the lane digest when a source changes between two inventories", async () => {
    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");
    const before = await inventory({});
    await writeFile(join(runDirectory, "plan.log"), "planning again\n", "utf8");
    const after = await inventory({});

    expect(after.lanes.runtime_objects.manifestDigest).not.toBe(
      before.lanes.runtime_objects.manifestDigest,
    );
  });

  it("pages the scan instead of holding the whole run in one batch", async () => {
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(runDirectory, `step-${index}.log`), `${index}\n`, "utf8");
    }
    const pages: number[] = [];

    const result = await inventory({
      pageSize: 2,
      onPage: (page) => pages.push(page.entryCount),
    });

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((count) => count <= 2)).toBe(true);
    expect(pages.reduce((sum, count) => sum + count, 0)).toBe(result.scannedEntries);
  });

  it("never lets a raw path leave the manifest item identity", async () => {
    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");

    const result = await inventory({});
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("plan.log");
    expect(serialized).not.toContain(runDirectory);
  });

  it("hands the operator source map to its own sink, keyed by the path digest", async () => {
    await writeFile(join(runDirectory, "plan.log"), "planning\n", "utf8");
    const sources: Array<{ relativePathDigest: string; relativePath: string }> = [];

    await inventory({ onSource: (source) => sources.push(source) });

    expect(sources).toContainEqual({
      relativePathDigest: relativePathDigest("plan.log"),
      relativePath: "plan.log",
    });
    expect(sources.map((source) => source.relativePath).sort()).toEqual([
      "cost.jsonl",
      "plan.log",
      "run.events.jsonl",
    ]);
  });
});
