import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  LEGACY_LANES,
  LEGACY_MANIFEST_VERSION,
  classifyLegacySource,
  laneManifestDigest,
  manifestItemId,
  relativePathDigest,
  type LegacyLane,
  type LegacySourceClass,
} from "./sources";

// D9 step 4: page the whole run directory, account for every entry and every
// owner association, and bind each lane's proof to the scope that was inspected.
// The result carries opaque identities only — raw paths stay in the operator's
// host-private manifest.

const DEFAULT_PAGE_SIZE = 100;
const EVENT_ROWS_ASSOCIATION = "event_rows";

export type LegacyAssociationKind = "artifact" | "attachment";

export type LegacyAssociation = {
  associationKind: LegacyAssociationKind;
  id: string;
  relativePath: string;
  rowFingerprint: string;
};

export type LegacyManifestItem = {
  itemId: string;
  lane: LegacyLane;
  sourceClass: LegacySourceClass;
  disposition: "copy" | "manager_authoritative";
  associationKey: string;
  rowFingerprint: string | null;
  relativePathDigest: string;
  size: number;
  sha256: string;
};

export type LegacyInventoryBlockReason =
  | "unclassified_source"
  | "non_regular_source"
  | "missing_association_payload";

export type LegacyInventoryBlock = {
  lane: LegacyLane | null;
  reason: LegacyInventoryBlockReason;
  relativePathDigest: string;
};

export type LegacyLaneManifest = {
  lane: LegacyLane;
  manifestDigest: string;
  inspectedScope: string;
  expectedItems: number;
  totalBytes: number;
  items: readonly LegacyManifestItem[];
};

export type LegacyRunInventory = {
  runId: string;
  frozenSourceId: string;
  scannedEntries: number;
  totalBytes: number;
  complete: boolean;
  blocks: readonly LegacyInventoryBlock[];
  lanes: Record<LegacyLane, LegacyLaneManifest>;
};

export type LegacyRunInventoryInput = {
  runDirectory: string;
  runId: string;
  frozenSourceId: string;
  associations: readonly LegacyAssociation[];
  pageSize?: number;
  onPage?: (page: { pageIndex: number; entryCount: number }) => void;
  // D9: "raw paths remain only in the host-private manifest/operator source
  // map". The inventory result carries opaque identities; the operator's own
  // source map is fed through this sink instead.
  onSource?: (source: {
    relativePathDigest: string;
    relativePath: string;
  }) => void;
};

type ScannedEntry = {
  relativePath: string;
  kind: "file" | "directory" | "other";
  size: number;
};

const LANE_FOR_ASSOCIATION: Record<LegacyAssociationKind, LegacyLane> = {
  artifact: "runtime_objects",
  attachment: "scratch_session",
};

async function hashFile(absolutePath: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(absolutePath)) {
    hash.update(new Uint8Array(chunk as Buffer));
  }

  return hash.digest("hex");
}

// Sorted at every level so two inventories of unchanged bytes walk in the same
// order, and no-follow so a symlink is reported as what it is rather than as
// whatever it points at.
async function* walkRunDirectory(
  root: string,
  prefix = "",
): AsyncGenerator<ScannedEntry> {
  const entries = await readdir(prefix ? join(root, prefix) : root, {
    withFileTypes: true,
  });

  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const metadata = await lstat(join(root, relativePath));

    if (metadata.isDirectory()) {
      yield { relativePath, kind: "directory", size: 0 };
      yield* walkRunDirectory(root, relativePath);
      continue;
    }

    yield {
      relativePath,
      kind: metadata.isFile() ? "file" : "other",
      size: metadata.isFile() ? metadata.size : 0,
    };
  }
}

export async function inventoryLegacyRun(
  input: LegacyRunInventoryInput,
): Promise<LegacyRunInventory> {
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  const items: LegacyManifestItem[] = [];
  const blocks: LegacyInventoryBlock[] = [];
  const scopeLines: string[] = [];
  const bytesByPath = new Map<
    string,
    { size: number; sha256: string; sourceClass: LegacySourceClass }
  >();
  let page: ScannedEntry[] = [];
  let pageIndex = 0;
  let scannedEntries = 0;
  let totalBytes = 0;

  const flushPage = async (): Promise<void> => {
    if (page.length === 0) return;

    for (const entry of page) {
      const pathDigest = relativePathDigest(entry.relativePath);
      scopeLines.push(`${entry.kind}:${pathDigest}:${entry.size}`);

      if (entry.kind === "directory") continue;
      if (entry.kind === "other") {
        blocks.push({
          lane: null,
          reason: "non_regular_source",
          relativePathDigest: pathDigest,
        });
        continue;
      }

      const classification = classifyLegacySource(entry.relativePath);

      if (classification.disposition === "blocked") {
        blocks.push({
          lane: null,
          reason: classification.reason,
          relativePathDigest: pathDigest,
        });
        continue;
      }

      const sha256 = await hashFile(join(input.runDirectory, entry.relativePath));
      bytesByPath.set(entry.relativePath, {
        size: entry.size,
        sha256,
        sourceClass: classification.sourceClass,
      });
      totalBytes += entry.size;
      input.onSource?.({
        relativePathDigest: pathDigest,
        relativePath: entry.relativePath,
      });
      items.push({
        itemId: manifestItemId({
          manifestVersion: LEGACY_MANIFEST_VERSION,
          frozenSourceId: input.frozenSourceId,
          runId: input.runId,
          associationKey: "source",
          relativePathDigest: pathDigest,
          size: entry.size,
          sha256,
        }),
        lane: classification.lane,
        sourceClass: classification.sourceClass,
        disposition: classification.disposition,
        associationKey: "source",
        rowFingerprint: null,
        relativePathDigest: pathDigest,
        size: entry.size,
        sha256,
      });

      // D9 maps this one source to two lanes: its bytes are preserved as the
      // raw-transcript object, and the manager reconstructs the canonical event
      // rows from the same file. Without the second item the events lane of a
      // run that carries no control JSON would report an inspected-empty proof
      // while its real source sits right there.
      if (classification.sourceClass === "raw_transcript") {
        items.push({
          itemId: manifestItemId({
            manifestVersion: LEGACY_MANIFEST_VERSION,
            frozenSourceId: input.frozenSourceId,
            runId: input.runId,
            associationKey: EVENT_ROWS_ASSOCIATION,
            relativePathDigest: pathDigest,
            size: entry.size,
            sha256,
          }),
          lane: "events",
          sourceClass: "raw_transcript",
          disposition: "manager_authoritative",
          associationKey: EVENT_ROWS_ASSOCIATION,
          rowFingerprint: null,
          relativePathDigest: pathDigest,
          size: entry.size,
          sha256,
        });
      }
    }

    input.onPage?.({ pageIndex, entryCount: page.length });
    pageIndex += 1;
    page = [];
  };

  for await (const entry of walkRunDirectory(input.runDirectory)) {
    scannedEntries += 1;
    page.push(entry);
    if (page.length >= pageSize) await flushPage();
  }
  await flushPage();

  for (const association of input.associations) {
    const pathDigest = relativePathDigest(association.relativePath);
    const bytes = bytesByPath.get(association.relativePath);
    const lane = LANE_FOR_ASSOCIATION[association.associationKind];

    if (!bytes) {
      blocks.push({
        lane,
        reason: "missing_association_payload",
        relativePathDigest: pathDigest,
      });
      continue;
    }

    const associationKey = `${association.associationKind}:${association.id}`;
    items.push({
      itemId: manifestItemId({
        manifestVersion: LEGACY_MANIFEST_VERSION,
        frozenSourceId: input.frozenSourceId,
        runId: input.runId,
        associationKey,
        relativePathDigest: pathDigest,
        size: bytes.size,
        sha256: bytes.sha256,
      }),
      lane,
      sourceClass: bytes.sourceClass,
      disposition: "copy",
      associationKey,
      rowFingerprint: association.rowFingerprint,
      relativePathDigest: pathDigest,
      size: bytes.size,
      sha256: bytes.sha256,
    });
  }

  const inspectedScope = createHash("sha256")
    .update(
      [LEGACY_MANIFEST_VERSION, "scope", ...[...scopeLines].sort()].join("\n"),
      "utf8",
    )
    .digest("hex");
  const lanes = {} as Record<LegacyLane, LegacyLaneManifest>;

  for (const lane of LEGACY_LANES) {
    const laneItems = items.filter((item) => item.lane === lane);

    lanes[lane] = {
      lane,
      manifestDigest: laneManifestDigest({ lane, inspectedScope, items: laneItems }),
      inspectedScope,
      expectedItems: laneItems.length,
      totalBytes: laneItems.reduce((sum, item) => sum + item.size, 0),
      items: laneItems,
    };
  }

  return {
    runId: input.runId,
    frozenSourceId: input.frozenSourceId,
    scannedEntries,
    totalBytes,
    complete: blocks.length === 0,
    blocks,
    lanes,
  };
}
