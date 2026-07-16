import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as fullSchema from "@/lib/db/schema";
import { readEvidenceBlob } from "@/lib/evaluations/evidence/store";
import {
  listSnapshotItemDtos,
  readSnapshotItem,
  sealEvidenceSnapshot,
  type EvidenceItemInput,
} from "@/lib/evaluations/evidence/snapshots";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase;
let studyId: string;

function item(
  overrides: Partial<EvidenceItemInput> & { bytes: Uint8Array },
): EvidenceItemInput {
  return {
    kind: "diff",
    locator: "diff:a",
    coverageClass: "captured",
    ...overrides,
  };
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "maister-eval-evidence-"));

  process.env.MAISTER_EVALUATION_EVIDENCE_ROOT = root;

  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_eval_evidence_test",
  });
  db = testDatabase.db;

  const projectId = randomUUID();
  const taskId = randomUUID();
  const flowId = randomUUID();

  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug: `proj-${projectId.slice(0, 8)}`,
    name: "Test",
    repoPath: `/tmp/proj-${projectId.slice(0, 8)}`,
    maisterYamlPath: "/tmp/m.yaml",
  });
  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
  });
  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "T",
    prompt: "p",
    flowId,
  });
  studyId = randomUUID();
  await db.insert(schema.evaluationStudies).values({
    id: studyId,
    projectId,
    taskId,
    title: "S",
    status: "open",
  });
}, 180_000);

afterAll(async () => {
  delete process.env.MAISTER_EVALUATION_EVIDENCE_ROOT;
  await testDatabase?.stop();
});

describe("evidence snapshot seal + reuse", () => {
  it("seals a snapshot, content-addresses blobs, and exposes redacted DTOs", async () => {
    const sealed = await sealEvidenceSnapshot(
      {
        studyId,
        participantWatermarks: { p1: { tip: "aaa" } },
        evidenceProtocolDigest: "proto-1",
        items: [
          item({
            locator: "diff:p1",
            bytes: new TextEncoder().encode("hello world"),
          }),
          item({
            kind: "task",
            locator: "task:shared",
            participantId: null,
            bytes: new TextEncoder().encode("the task"),
          }),
        ],
      },
      db,
    );

    expect(sealed.reused).toBe(false);
    expect(sealed.manifestDigest).toMatch(/^[0-9a-f]{64}$/);

    const dtos = await listSnapshotItemDtos(sealed.snapshotId, db);

    expect(dtos).toHaveLength(2);
    // Public DTO exposes opaque facets only — never the locator or blobKey.
    for (const dto of dtos) {
      expect(dto).not.toHaveProperty("locator");
      expect(dto).not.toHaveProperty("blobKey");
      expect(dto.digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("reuses a sealed snapshot on identical watermarks + protocol digest", async () => {
    const first = await sealEvidenceSnapshot(
      {
        studyId,
        participantWatermarks: { p1: { tip: "bbb" } },
        evidenceProtocolDigest: "proto-reuse",
        items: [item({ bytes: new TextEncoder().encode("x") })],
      },
      db,
    );
    const second = await sealEvidenceSnapshot(
      {
        studyId,
        participantWatermarks: { p1: { tip: "bbb" } },
        evidenceProtocolDigest: "proto-reuse",
        items: [item({ bytes: new TextEncoder().encode("x") })],
      },
      db,
    );

    expect(second.reused).toBe(true);
    expect(second.snapshotId).toBe(first.snapshotId);

    // A different protocol digest is NOT reused (side-by-side comparison).
    const third = await sealEvidenceSnapshot(
      {
        studyId,
        participantWatermarks: { p1: { tip: "bbb" } },
        evidenceProtocolDigest: "proto-other",
        items: [item({ bytes: new TextEncoder().encode("x") })],
      },
      db,
    );

    expect(third.reused).toBe(false);
    expect(third.snapshotId).not.toBe(first.snapshotId);
  });

  it("reads a bounded window of an item and flags truncation", async () => {
    const payload = new TextEncoder().encode("0123456789abcdef");
    const sealed = await sealEvidenceSnapshot(
      {
        studyId,
        participantWatermarks: { p1: { tip: "ccc" } },
        evidenceProtocolDigest: "proto-read",
        items: [item({ locator: "diff:read", bytes: payload })],
      },
      db,
    );
    const [dto] = await listSnapshotItemDtos(sealed.snapshotId, db);

    const window = await readSnapshotItem(
      { snapshotId: sealed.snapshotId, itemId: dto.id, offset: 4, length: 4 },
      db,
    );

    expect(window.bytes.toString()).toBe("4567");
    expect(window.truncated).toBe(true);

    const tail = await readSnapshotItem(
      {
        snapshotId: sealed.snapshotId,
        itemId: dto.id,
        offset: 12,
        length: 100,
      },
      db,
    );

    expect(tail.bytes.toString()).toBe("cdef");
    expect(tail.truncated).toBe(false);
  });

  it("refuses a blob key that escapes the evidence root", async () => {
    await expect(readEvidenceBlob("../../etc/passwd")).rejects.toThrow(
      /'\.\.' segment|escapes the evidence root/,
    );
  });
});
