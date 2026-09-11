// S4.3 / D9: "the supervisor loads an operator-selected frozen manifest locally,
// enables its exact import ID/generation/digest". It reads the operator's
// inventory database read-only, derives the digest both sides compute the same
// way, and never learns a raw source path from it.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadOperatorManifest } from "../import-manifest";

let directory: string;

function writeManifest(rows: {
  lanes: Array<{ runId: string; lane: string; digest: string }>;
  items: Array<{
    itemId: string;
    runId: string;
    lane: string;
    size: number;
    sha256: string;
    disposition?: string;
    relativePath?: string;
  }>;
}): void {
  const db = new DatabaseSync(join(directory, "import-inv-1.sqlite"));

  db.exec(`
    CREATE TABLE import_lanes (
      import_id TEXT, run_id TEXT, lane TEXT, manifest_digest TEXT,
      inspected_scope TEXT, expected_items INTEGER, total_bytes INTEGER
    );
    CREATE TABLE import_items (
      import_id TEXT, item_id TEXT, run_id TEXT, lane TEXT, source_class TEXT,
      disposition TEXT, association_key TEXT, row_fingerprint TEXT,
      association_locator TEXT, relative_path TEXT, relative_path_digest TEXT,
      size_bytes INTEGER, sha256 TEXT
    );
  `);
  for (const lane of rows.lanes) {
    db.prepare(
      `INSERT INTO import_lanes
        (import_id, run_id, lane, manifest_digest, inspected_scope,
         expected_items, total_bytes)
       VALUES ('inv-1', ?, ?, ?, 'scope', 0, 0)`,
    ).run(lane.runId, lane.lane, lane.digest);
  }
  for (const item of rows.items) {
    db.prepare(
      `INSERT INTO import_items
        (import_id, item_id, run_id, lane, source_class, disposition,
         association_key, row_fingerprint, association_locator, relative_path,
         relative_path_digest, size_bytes, sha256)
       VALUES ('inv-1', ?, ?, ?, 'step_log', ?, 'source', NULL, NULL, ?, 'pd', ?, ?)`,
    ).run(
      item.itemId,
      item.runId,
      item.lane,
      item.disposition ?? "copy",
      item.relativePath ?? "plan.log",
      item.size,
      item.sha256,
    );
  }
  db.close();
}

const LANES = [
  { runId: "run-1", lane: "runtime_objects", digest: "1".repeat(64) },
  { runId: "run-1", lane: "transcript", digest: "2".repeat(64) },
];
const ITEMS = [
  {
    itemId: "a".repeat(64),
    runId: "run-1",
    lane: "runtime_objects",
    size: 10,
    sha256: "b".repeat(64),
  },
];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "import-manifest-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("loadOperatorManifest", () => {
  // The operator's CLI derives this digest from the same file in the web
  // package and sends it as proof; the two derivations cannot be one function
  // across the package boundary, so this vector is asserted verbatim on both
  // sides. Changing it here without changing it there is a live
  // `import_manifest_mismatch` on every request, so the vector is the contract.
  it("derives the digest both sides agree on (shared vector)", () => {
    writeManifest({ lanes: LANES, items: ITEMS });

    expect(loadOperatorManifest({ directory, importId: "inv-1" }).digest).toBe(
      "d8630ca9acbdc0b3c0c23fd310a0811f10e6a98470a191fea6b5a497b3689f53",
    );
  });

  it("derives a digest that depends on every lane it covers", () => {
    writeManifest({ lanes: LANES, items: ITEMS });
    const first = loadOperatorManifest({ directory, importId: "inv-1" });

    rmManifest();
    writeManifest({
      lanes: [LANES[0], { ...LANES[1], digest: "3".repeat(64) }],
      items: ITEMS,
    });

    expect(
      loadOperatorManifest({ directory, importId: "inv-1" }).digest,
    ).not.toBe(first.digest);
  });

  it("is independent of the order the lanes were written in", () => {
    writeManifest({ lanes: LANES, items: ITEMS });
    const forward = loadOperatorManifest({
      directory,
      importId: "inv-1",
    }).digest;

    rmManifest();
    writeManifest({ lanes: [...LANES].reverse(), items: ITEMS });

    expect(loadOperatorManifest({ directory, importId: "inv-1" }).digest).toBe(
      forward,
    );
  });

  it("returns only the items the host must actually receive", () => {
    writeManifest({
      lanes: LANES,
      items: [
        ...ITEMS,
        {
          itemId: "c".repeat(64),
          runId: "run-1",
          lane: "events",
          size: 4,
          sha256: "d".repeat(64),
          disposition: "manager_authoritative",
        },
      ],
    });

    const manifest = loadOperatorManifest({ directory, importId: "inv-1" });

    expect(manifest.items).toEqual([
      {
        itemId: "a".repeat(64),
        runId: "run-1",
        lane: "runtime_objects",
        sizeBytes: 10,
        sha256: "b".repeat(64),
      },
    ]);
  });

  it("never hands the supervisor a raw source path", () => {
    writeManifest({
      lanes: LANES,
      items: [{ ...ITEMS[0], relativePath: "secret-step.log" }],
    });

    expect(
      JSON.stringify(loadOperatorManifest({ directory, importId: "inv-1" })),
    ).not.toContain("secret-step.log");
  });

  it("refuses a manifest that is not there", () => {
    expect(() =>
      loadOperatorManifest({ directory, importId: "inv-1" }),
    ).toThrow(/manifest/i);
  });
});

function rmManifest(): void {
  const db = new DatabaseSync(join(directory, "import-inv-1.sqlite"));

  db.exec("DROP TABLE import_lanes; DROP TABLE import_items;");
  db.close();
}
