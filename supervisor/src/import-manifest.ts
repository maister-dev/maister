import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// S4.3 / D9: the supervisor loads the operator-selected frozen manifest locally
// and enables its exact identity. It opens the operator's inventory database
// READ-ONLY and takes only what a receiving host needs — item identity, owning
// run, lane and the declared bytes. Raw source paths stay in that file; they are
// never read into the host, its protocol or its logs.

export type OperatorManifestItem = {
  itemId: string;
  runId: string;
  lane: string;
  sizeBytes: number;
  sha256: string;
};

export type OperatorManifest = {
  digest: string;
  items: OperatorManifestItem[];
};

function integer(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

export function loadOperatorManifest(input: {
  directory: string;
  importId: string;
}): OperatorManifest {
  const file = join(input.directory, `import-${input.importId}.sqlite`);

  if (!existsSync(file)) {
    throw new Error(
      `operator import manifest is missing for ${input.importId}`,
    );
  }

  const db = new DatabaseSync(file, { readOnly: true });

  try {
    const lanes = db
      .prepare(
        `SELECT run_id AS runId, lane, manifest_digest AS manifestDigest
         FROM import_lanes WHERE import_id = ?`,
      )
      .all(input.importId)
      .map(
        (row) =>
          `${String(row.runId)}|${String(row.lane)}|${String(row.manifestDigest)}`,
      )
      .sort();

    if (lanes.length === 0) {
      throw new Error(
        `operator import manifest for ${input.importId} covers no lane`,
      );
    }

    const digest = createHash("sha256")
      .update([input.importId, ...lanes].join("\n"), "utf8")
      .digest("hex");
    const items = db
      .prepare(
        `SELECT item_id AS itemId, run_id AS runId, lane,
            size_bytes AS sizeBytes, sha256
         FROM import_items
         WHERE import_id = ? AND disposition = 'copy'
         ORDER BY item_id`,
      )
      .all(input.importId)
      .map((row) => ({
        itemId: String(row.itemId),
        runId: String(row.runId),
        lane: String(row.lane),
        sizeBytes: integer(row.sizeBytes),
        sha256: String(row.sha256),
      }));

    return { digest, items };
  } finally {
    db.close();
  }
}
