import "server-only";

import { and, eq, sql } from "drizzle-orm";
import pino from "pino";

import {
  readEvidenceBlob,
  writeEvidenceBlob,
  type BoundedReadResult,
} from "./store";

import { getDb } from "@/lib/db/client";
import * as schemaModule from "@/lib/db/schema";
import { contentDigest } from "@/lib/evaluations/digest";
import { MaisterError } from "@/lib/errors";

// FIXME(any): schema-module bridge (matches lib/evaluations/studies.ts).
const { evaluationEvidenceSnapshots, evaluationEvidenceItems } =
  schemaModule as unknown as Record<string, any>;

// FIXME(any): narrow this injected database seam to its operations.
type Db = any;

const log = pino({
  name: "evaluations-evidence",
  level: process.env.LOG_LEVEL ?? "info",
});

export interface EvidenceItemInput {
  participantId?: string | null;
  kind: string;
  // Opaque logical label (e.g. "diff:<participant>"), NOT a host path.
  locator: string;
  coverageClass: string;
  inclusionReason?: string | null;
  truncation?: Record<string, unknown> | null;
  redaction?: Record<string, unknown> | null;
  sourceWatermark?: string | null;
  retention?: string | null;
  // The immutable payload to content-address.
  bytes: Uint8Array;
}

export interface SealResult {
  snapshotId: string;
  manifestDigest: string;
  reused: boolean;
}

// Digest over the sorted item manifest + protocol — the content-integrity digest
// stored on the sealed snapshot (distinct from the reuse key, which is the
// participant watermark set + protocol digest, D5).
function computeManifestDigest(
  evidenceProtocolDigest: string,
  written: { input: EvidenceItemInput; digest: string }[],
): string {
  return contentDigest({
    protocol: evidenceProtocolDigest,
    items: written
      .map((w) => ({
        p: w.input.participantId ?? null,
        k: w.input.kind,
        l: w.input.locator,
        d: w.digest,
      }))
      .sort((a, b) => (a.l < b.l ? -1 : a.l > b.l ? 1 : a.d < b.d ? -1 : 1)),
  });
}

// A sealed snapshot with the SAME participant watermark set AND evidence-protocol
// digest represents identical evidence — reusable so a different compatible
// Method can compare over it (D5). Matched on jsonb equality of the canonical
// (participant-id-keyed) watermark object, which is order-insensitive.
export async function findReusableSnapshot(
  args: {
    studyId: string;
    evidenceProtocolDigest: string;
    participantWatermarks: Record<string, unknown>;
  },
  db?: Db,
): Promise<{ id: string; manifestDigest: string | null } | null> {
  const d = db ?? getDb();
  const rows = await d
    .select({
      id: evaluationEvidenceSnapshots.id,
      manifestDigest: evaluationEvidenceSnapshots.manifestDigest,
    })
    .from(evaluationEvidenceSnapshots)
    .where(
      and(
        eq(evaluationEvidenceSnapshots.studyId, args.studyId),
        eq(evaluationEvidenceSnapshots.status, "sealed"),
        eq(
          evaluationEvidenceSnapshots.evidenceProtocolDigest,
          args.evidenceProtocolDigest,
        ),
        sql`${evaluationEvidenceSnapshots.participantWatermarks} = ${JSON.stringify(
          args.participantWatermarks,
        )}::jsonb`,
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

// Seal a new immutable evidence snapshot (or attach an existing reusable one).
// Blobs are written to the content store BEFORE the DB seal transaction: a crash
// after a blob write but before the seal leaves an orphan blob (GC-eligible),
// and the DB never points at an absent blob.
export async function sealEvidenceSnapshot(
  args: {
    studyId: string;
    participantWatermarks: Record<string, unknown>;
    evidenceProtocolDigest: string;
    items: EvidenceItemInput[];
    preparedByUserId?: string | null;
  },
  db?: Db,
): Promise<SealResult> {
  const d = db ?? getDb();

  const reusable = await findReusableSnapshot(
    {
      studyId: args.studyId,
      evidenceProtocolDigest: args.evidenceProtocolDigest,
      participantWatermarks: args.participantWatermarks,
    },
    d,
  );

  if (reusable) {
    log.info(
      { studyId: args.studyId, snapshotId: reusable.id },
      "reused sealed evidence snapshot (digest match)",
    );

    return {
      snapshotId: reusable.id,
      manifestDigest: reusable.manifestDigest ?? "",
      reused: true,
    };
  }

  // Write all blobs first (outside the DB tx). Content-addressed → idempotent.
  const written = [] as {
    input: EvidenceItemInput;
    digest: string;
    blobKey: string;
    bytes: number;
  }[];

  for (const input of args.items) {
    const blob = await writeEvidenceBlob(input.bytes);

    written.push({ input, ...blob });
  }

  const manifestDigest = computeManifestDigest(
    args.evidenceProtocolDigest,
    written,
  );

  return d.transaction(async (tx: Db) => {
    const [snapshot] = await tx
      .insert(evaluationEvidenceSnapshots)
      .values({
        studyId: args.studyId,
        status: "preparing",
        participantWatermarks: args.participantWatermarks,
        evidenceProtocolDigest: args.evidenceProtocolDigest,
        storageGeneration: written[0]?.blobKey.split("/")[0] ?? null,
        preparedByUserId: args.preparedByUserId ?? null,
      })
      .returning();

    for (const w of written) {
      await tx.insert(evaluationEvidenceItems).values({
        snapshotId: snapshot.id,
        participantId: w.input.participantId ?? null,
        kind: w.input.kind,
        locator: w.input.locator,
        digest: w.digest,
        bytes: w.bytes,
        coverageClass: w.input.coverageClass,
        inclusionReason: w.input.inclusionReason ?? null,
        truncation: w.input.truncation ?? null,
        redaction: w.input.redaction ?? null,
        blobKey: w.blobKey,
        retention: w.input.retention ?? null,
        sourceWatermark: w.input.sourceWatermark ?? null,
      });
    }

    // Atomic seal: manifest digest + sealed status in one UPDATE (the sealed row
    // is immutable thereafter).
    await tx
      .update(evaluationEvidenceSnapshots)
      .set({ status: "sealed", manifestDigest, sealedAt: new Date() })
      .where(eq(evaluationEvidenceSnapshots.id, snapshot.id));

    log.info(
      {
        studyId: args.studyId,
        snapshotId: snapshot.id,
        items: written.length,
      },
      "sealed evidence snapshot",
    );

    return { snapshotId: snapshot.id, manifestDigest, reused: false };
  });
}

export interface EvidenceItemDto {
  id: string;
  participantId: string | null;
  kind: string;
  digest: string;
  bytes: number | null;
  coverageClass: string;
  truncation: Record<string, unknown> | null;
  redaction: Record<string, unknown> | null;
}

// Public metadata projection — opaque item id + logical facets only. NEVER the
// locator (a logical path) or blobKey (the host content-store key).
export async function listSnapshotItemDtos(
  snapshotId: string,
  db?: Db,
): Promise<EvidenceItemDto[]> {
  const d = db ?? getDb();
  const rows = await d
    .select({
      id: evaluationEvidenceItems.id,
      participantId: evaluationEvidenceItems.participantId,
      kind: evaluationEvidenceItems.kind,
      digest: evaluationEvidenceItems.digest,
      bytes: evaluationEvidenceItems.bytes,
      coverageClass: evaluationEvidenceItems.coverageClass,
      truncation: evaluationEvidenceItems.truncation,
      redaction: evaluationEvidenceItems.redaction,
    })
    .from(evaluationEvidenceItems)
    .where(eq(evaluationEvidenceItems.snapshotId, snapshotId));

  return rows as EvidenceItemDto[];
}

// Bounded read of one item's payload. The item is validated to belong to the
// bound snapshot (the caller supplies both from the attempt-bound context, D10);
// the read is server-capped by store.ts.
export async function readSnapshotItem(
  args: {
    snapshotId: string;
    itemId: string;
    offset?: number;
    length?: number;
  },
  db?: Db,
): Promise<BoundedReadResult> {
  const d = db ?? getDb();
  const [item] = await d
    .select({ blobKey: evaluationEvidenceItems.blobKey })
    .from(evaluationEvidenceItems)
    .where(
      and(
        eq(evaluationEvidenceItems.id, args.itemId),
        eq(evaluationEvidenceItems.snapshotId, args.snapshotId),
      ),
    );

  if (!item || !item.blobKey) {
    throw new MaisterError(
      "PRECONDITION",
      `evidence item not found in snapshot: ${args.itemId}`,
    );
  }

  return readEvidenceBlob(item.blobKey, {
    offset: args.offset,
    length: args.length,
  });
}
