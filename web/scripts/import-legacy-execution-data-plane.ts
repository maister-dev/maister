import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import pino from "pino";
import { Client } from "pg";

import {
  assessLegacyImportWindow,
  classifyDataPlaneStage,
  type DataPlaneStage,
} from "@/lib/db/migration-stages";

import { redactRuntimeEventPayload } from "@/lib/execution-host/runtime-events";
import { CANONICAL_PROJECTION_CONSUMERS } from "@/lib/execution-host/events/projection-consumers";
// eslint-disable-next-line no-restricted-imports -- S4.3: the operator CLI is
// the one caller the maintenance-import fence exists for.
import {
  createImportMaintenanceClient,
  IMPORT_CHUNK_BYTES,
  readOperatorImportManifest,
  type ImportMaintenanceClient,
  type OperatorImportItem,
} from "@/lib/execution-host/import-maintenance";

import {
  inventoryLegacyRun,
  type LegacyAssociation,
} from "./legacy-import/inventory";
import {
  openImportManifestStore,
  readImportManifestRows,
  type ManifestProofItemRow,
} from "./legacy-import/manifest-store";
import {
  IMPORT_PROOF_VERSION,
  reduceRunProofs,
  type ItemOutcome,
  type ProofRefusal,
  type RunProof,
  type RunRefusal,
} from "./legacy-import/proof";

type ImportSourceKind = "events" | "transcript" | "cost" | "runtime_objects";
type LegacyLaneKind = ImportSourceKind | "scratch_session";
type LegacyRun = {
  id: string;
  ownerSlug: string | null;
  stableOccurredAt: string;
};
type LegacyEvent = Record<string, unknown> & { type: string };
type NodeAttempt = { id: string; acpSessionId: string | null };
type SourceLine = {
  raw: string;
  line: number;
  byteOffset: number;
  endByteOffset: number;
};

const log = pino({ name: "execution-data-plane:import-legacy" });
const MAX_LEGACY_LINE_BYTES = 1_048_576;
const DEFAULT_INVENTORY_BATCH = 100;
const LEGACY_EVENT_SCHEMAS: Readonly<Record<string, string>> = {
  "session.created": "maister.session.created.v1",
  "session.line": "maister.session.line.v1",
  "session.update": "maister.session.update.v1",
  "session.permission_request": "maister.session.permission-request.v1",
  "session.hook_trip": "maister.session.hook-trip.v1",
  "session.command": "maister.session.command.v1",
  "session.chat_turn": "maister.session.chat-turn.v1",
  "session.exited": "maister.session.exited.v1",
  "session.crashed": "maister.session.crashed.v1",
  "run.needs_input": "maister.manager.run-stream.v1",
  "run.runner_resolution_warning": "maister.manager.run-stream.v1",
};
const TRANSCRIPT_EVENT_TYPES = new Set([
  "session.line",
  "session.update",
  "session.chat_turn",
]);

class LegacyImportError extends Error {
  constructor(
    message: string,
    readonly sourceKind: ImportSourceKind,
    readonly reason: string,
    readonly sourcePosition: string | null = null,
    readonly fingerprint: string | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LegacyImportError";
  }
}

function requiredEnv(name: "DB_URL" | "MAISTER_LEGACY_RUNTIME_ROOT"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for legacy execution-data import`);

  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deterministicUuid(value: string): string {
  const namespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
  const bytes = Buffer.from(
    createHash("sha1")
      .update(new Uint8Array(namespace))
      .update(value, "utf8")
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("legacy record must be a JSON object");
  }

  return value as Record<string, unknown>;
}

function sourceLines(contents: string): readonly SourceLine[] {
  const lines: SourceLine[] = [];
  let characterOffset = 0;
  let byteOffset = 0;
  let lineNumber = 1;
  while (characterOffset < contents.length) {
    const newline = contents.indexOf("\n", characterOffset);
    const end = newline === -1 ? contents.length : newline + 1;
    const segment = contents.slice(characterOffset, end);
    const raw = segment.endsWith("\n") ? segment.slice(0, -1) : segment;
    const endByteOffset = byteOffset + Buffer.byteLength(segment, "utf8");
    if (raw.trim().length > 0) {
      lines.push({ raw, line: lineNumber, byteOffset, endByteOffset });
    }
    characterOffset = end;
    byteOffset = endByteOffset;
    lineNumber += 1;
  }

  return lines;
}

function parseJsonLine(
  input: SourceLine,
  sourceKind: "events" | "cost",
): Record<string, unknown> {
  const position = `line:${input.line}:byte:${input.byteOffset}`;
  if (Buffer.byteLength(input.raw, "utf8") > MAX_LEGACY_LINE_BYTES) {
    throw new LegacyImportError(
      `legacy ${sourceKind} record exceeds ${MAX_LEGACY_LINE_BYTES} bytes at ${position}`,
      sourceKind,
      "record_oversize",
      position,
    );
  }
  try {
    return asRecord(JSON.parse(input.raw) as unknown);
  } catch (error) {
    throw new LegacyImportError(
      `legacy ${sourceKind} record is malformed at ${position}`,
      sourceKind,
      "malformed_json",
      position,
      null,
      { cause: error },
    );
  }
}

function eventPayload(
  event: LegacyEvent,
  attemptIdBySession: ReadonlyMap<string, string>,
  source: SourceLine,
): Record<string, unknown> {
  const { type: _type, monotonicId, ts: _timestamp, ...legacyPayload } = event;
  const sessionId =
    typeof legacyPayload.sessionId === "string" ? legacyPayload.sessionId : null;
  const nodeAttemptId =
    typeof legacyPayload.nodeAttemptId === "string"
      ? legacyPayload.nodeAttemptId
      : sessionId
        ? attemptIdBySession.get(sessionId)
        : undefined;

  return redactRuntimeEventPayload({
    ...legacyPayload,
    ...(nodeAttemptId ? { nodeAttemptId } : {}),
    ...(Number.isSafeInteger(monotonicId)
      ? { sourceMonotonicId: monotonicId }
      : {}),
    legacySourcePosition: `line:${source.line}:byte:${source.byteOffset}`,
  });
}

function schemaForLegacyEvent(event: LegacyEvent, source: SourceLine): string {
  const schema = LEGACY_EVENT_SCHEMAS[event.type];
  if (!schema) {
    throw new LegacyImportError(
      `legacy event type is unsupported at line:${source.line}:byte:${source.byteOffset}`,
      "events",
      "unsupported_event_type",
      `line:${source.line}:byte:${source.byteOffset}`,
    );
  }

  return schema;
}

function eventOccurredAt(
  record: Record<string, unknown>,
  stableFallback: string,
): { value: string; approximate: boolean } {
  if (typeof record.ts === "string" && !Number.isNaN(Date.parse(record.ts))) {
    return { value: new Date(record.ts).toISOString(), approximate: false };
  }

  return { value: new Date(stableFallback).toISOString(), approximate: true };
}

function nonNegativeInteger(
  value: unknown,
  field: string,
  source: SourceLine,
  optional = false,
): number {
  if (optional && value === undefined) return 0;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new LegacyImportError(
      `legacy cost ${field} is invalid at line:${source.line}:byte:${source.byteOffset}`,
      "cost",
      "invalid_cost_record",
      `line:${source.line}:byte:${source.byteOffset}`,
    );
  }

  return Number(value);
}

function canonicalUsagePayload(
  record: Record<string, unknown>,
  source: SourceLine,
): Record<string, unknown> {
  if (typeof record.ts !== "string" || Number.isNaN(Date.parse(record.ts))) {
    throw new LegacyImportError(
      `legacy cost timestamp is invalid at line:${source.line}:byte:${source.byteOffset}`,
      "cost",
      "invalid_cost_timestamp",
      `line:${source.line}:byte:${source.byteOffset}`,
    );
  }

  return redactRuntimeEventPayload({
    inputTokens: nonNegativeInteger(record.input_tokens, "input_tokens", source),
    outputTokens: nonNegativeInteger(record.output_tokens, "output_tokens", source),
    cacheReadInputTokens: nonNegativeInteger(
      record.cache_read_input_tokens,
      "cache_read_input_tokens",
      source,
      true,
    ),
    cacheCreationInputTokens: nonNegativeInteger(
      record.cache_creation_input_tokens,
      "cache_creation_input_tokens",
      source,
      true,
    ),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(typeof record.sessionName === "string"
      ? { sessionName: record.sessionName }
      : {}),
    ...(typeof record.nodeAttemptId === "string"
      ? { nodeAttemptId: record.nodeAttemptId }
      : {}),
    ...(typeof record.resumed === "boolean" ? { resumed: record.resumed } : {}),
    legacySourcePosition: `line:${source.line}:byte:${source.byteOffset}`,
  });
}

function runtimeFilePath(input: {
  root: string;
  ownerSlug: string;
  runId: string;
  name: "run.events.jsonl" | "cost.jsonl";
}): string {
  const root = path.resolve(input.root);
  const target = path.resolve(
    root,
    ".maister",
    input.ownerSlug,
    "runs",
    input.runId,
    input.name,
  );
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new LegacyImportError(
      "legacy runtime source is outside the configured import root",
      input.name === "cost.jsonl" ? "cost" : "events",
      "source_outside_root",
    );
  }

  return target;
}

function runtimeRunDirectory(input: {
  root: string;
  ownerSlug: string;
  runId: string;
}): string {
  const root = path.resolve(input.root);
  const target = path.resolve(
    root,
    ".maister",
    input.ownerSlug,
    "runs",
    input.runId,
  );
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new LegacyImportError(
      "legacy runtime directory is outside the configured import root",
      "runtime_objects",
      "source_outside_root",
    );
  }

  return target;
}

function isManagerOwnedLegacyFile(relativePath: string): boolean {
  if (relativePath.includes(path.sep)) return false;
  return (
    relativePath === "run.events.jsonl" ||
    relativePath === "cost.jsonl" ||
    relativePath === "run.json" ||
    relativePath === "needs-input.json" ||
    relativePath === "flow-assistant-actions.jsonl" ||
    /^input-[A-Za-z0-9._-]+\.json$/.test(relativePath) ||
    /^node-start-[A-Za-z0-9._-]+\.json$/.test(relativePath) ||
    /^output-[A-Za-z0-9._-]+\.json$/.test(relativePath)
  );
}

async function auditLegacyRuntimeObjects(runDirectory: string): Promise<{
  fingerprint: string;
  checkedEntries: number;
}> {
  const pending = [runDirectory];
  const manifest: string[] = [];
  const unpreserved: string[] = [];

  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) throw new Error("legacy runtime audit directory disappeared");
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(runDirectory, absolute);
      if (entry.isDirectory()) {
        manifest.push(`directory:${relative}`);
        pending.push(absolute);
        continue;
      }
      const metadata = await lstat(absolute);
      const kind = metadata.isFile() ? "file" : metadata.isSymbolicLink() ? "symlink" : "other";
      manifest.push(`${kind}:${relative}:${metadata.size}`);
      if (!metadata.isFile() || !isManagerOwnedLegacyFile(relative)) {
        unpreserved.push(relative);
      }
    }
  }

  manifest.sort();
  unpreserved.sort();
  const fingerprint = sha256(`runtime-object-audit-v1\n${manifest.join("\n")}`);
  if (unpreserved.length > 0) {
    throw new LegacyImportError(
      `legacy run has ${unpreserved.length} unpreserved host runtime object(s)`,
      "runtime_objects",
      "runtime_object_unpreserved",
      `entries:${unpreserved.length}`,
      fingerprint,
    );
  }

  return { fingerprint, checkedEntries: manifest.length };
}

async function readRequiredFile(
  filePath: string,
  sourceKind: "events" | "cost",
): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new LegacyImportError(
      `legacy ${sourceKind} source is ${code === "ENOENT" ? "missing" : "unreadable"}`,
      sourceKind,
      code === "ENOENT" ? "required_source_missing" : "source_read_failed",
      null,
      null,
      { cause: error },
    );
  }
}

async function upsertImportState(input: {
  client: Client;
  runId: string;
  sourceKind: LegacyLaneKind;
  state: "pending" | "complete" | "missing" | "failed";
  fingerprint: string | null;
  lastSourcePosition: string | null;
  importedCount: number;
  error: Record<string, unknown> | null;
}): Promise<void> {
  await input.client.query(
    `INSERT INTO execution_data_plane_imports
      (run_id, source_kind, state, source_fingerprint, last_source_position,
       imported_count, last_error, started_at, completed_at, attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now(),
       CASE WHEN $3 = 'complete' THEN now() ELSE NULL END, 1)
     ON CONFLICT (run_id, source_kind) DO UPDATE SET
       state = EXCLUDED.state,
       source_fingerprint = EXCLUDED.source_fingerprint,
       last_source_position = EXCLUDED.last_source_position,
       imported_count = EXCLUDED.imported_count,
       last_error = EXCLUDED.last_error,
       started_at = EXCLUDED.started_at,
       completed_at = EXCLUDED.completed_at,
       attempts = execution_data_plane_imports.attempts + 1`,
    [
      input.runId,
      input.sourceKind,
      input.state,
      input.fingerprint,
      input.lastSourcePosition,
      input.importedCount,
      input.error ? JSON.stringify(input.error) : null,
    ],
  );
}

async function recordImportFailure(
  client: Client,
  runId: string,
  error: unknown,
): Promise<void> {
  const failure =
    error instanceof LegacyImportError
      ? error
      : new LegacyImportError(
          "legacy import failed before preservation completed",
          "events",
          "unexpected_import_failure",
          null,
          null,
          { cause: error },
        );
  await upsertImportState({
    client,
    runId,
    sourceKind: failure.sourceKind,
    state: failure.reason === "required_source_missing" ? "missing" : "failed",
    fingerprint: failure.fingerprint,
    lastSourcePosition: failure.sourcePosition,
    importedCount: 0,
    error: { reason: failure.reason, sourcePosition: failure.sourcePosition },
  });
}

function payloadDigest(payload: Record<string, unknown>): {
  json: string;
  sha256: string;
  bytes: number;
} {
  const json = JSON.stringify(payload);

  return { json, sha256: sha256(json), bytes: Buffer.byteLength(json, "utf8") };
}

async function insertLegacyEvent(input: {
  client: Client;
  runId: string;
  sourceKey: string;
  eventType: string;
  payloadSchema: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  hostSessionId: string | null;
  runSequence: bigint;
}): Promise<void> {
  const digest = payloadDigest(input.payload);
  const eventId = deterministicUuid(
    `urn:maister:legacy-event:${input.runId}:${input.sourceKey}`,
  );
  const inserted = await input.client.query(
    `INSERT INTO execution_events
      (id, source, source_key, run_id, host_session_id, event_type,
       payload_schema, payload, payload_sha256, payload_bytes, occurred_at,
       received_at, run_sequence, ingest_disposition)
     VALUES ($1, 'legacy_import', $2, $3, $4, $5, $6, $7::jsonb, $8, $9,
       $10, now(), $11, 'accepted')
     ON CONFLICT (source, run_id, source_key) WHERE source_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      eventId,
      input.sourceKey,
      input.runId,
      input.hostSessionId,
      input.eventType,
      input.payloadSchema,
      digest.json,
      digest.sha256,
      digest.bytes,
      input.occurredAt,
      input.runSequence.toString(),
    ],
  );
  if (inserted.rowCount === 1) {
    await input.client.query(
      `INSERT INTO execution_event_consumers (consumer_name, run_id)
       SELECT consumer_name, $1 FROM unnest($2::text[]) AS consumer_name
       ON CONFLICT DO NOTHING`,
      [input.runId, Object.values(CANONICAL_PROJECTION_CONSUMERS)],
    );

    return;
  }
  const existing = await input.client.query<{
    id: string;
    eventType: string;
    payloadSchema: string;
    payloadSha256: string | null;
    payloadBytes: number | null;
    occurredAt: Date;
    runSequence: string | null;
  }>(
    `SELECT id, event_type AS "eventType", payload_schema AS "payloadSchema",
       payload_sha256 AS "payloadSha256", payload_bytes AS "payloadBytes",
       occurred_at AS "occurredAt", run_sequence::text AS "runSequence"
     FROM execution_events
     WHERE source = 'legacy_import' AND run_id = $1 AND source_key = $2`,
    [input.runId, input.sourceKey],
  );
  const row = existing.rows[0];
  if (
    !row ||
    row.id !== eventId ||
    row.eventType !== input.eventType ||
    row.payloadSchema !== input.payloadSchema ||
    row.payloadSha256 !== digest.sha256 ||
    row.payloadBytes !== digest.bytes ||
    row.occurredAt.toISOString() !== input.occurredAt ||
    row.runSequence !== input.runSequence.toString()
  ) {
    throw new LegacyImportError(
      "legacy source identity conflicts with an existing canonical event",
      input.eventType === "usage.recorded" ? "cost" : "events",
      "event_identity_conflict",
      input.sourceKey,
    );
  }
}

async function importRun(input: {
  client: Client;
  run: LegacyRun;
  root: string;
}): Promise<{
  runId: string;
  eventCount: number;
  transcriptCount: number;
  costCount: number;
  alreadyComplete: boolean;
}> {
  if (!input.run.ownerSlug) {
    throw new LegacyImportError(
      "legacy run has no project or local-package owner",
      "runtime_objects",
      "owner_missing",
    );
  }
  const runDirectory = runtimeRunDirectory({
    root: input.root,
    ownerSlug: input.run.ownerSlug,
    runId: input.run.id,
  });
  const runtimeObjectAudit = await auditLegacyRuntimeObjects(runDirectory);
  const eventsContents = await readRequiredFile(
    runtimeFilePath({
      root: input.root,
      ownerSlug: input.run.ownerSlug,
      runId: input.run.id,
      name: "run.events.jsonl",
    }),
    "events",
  );
  const costContents = await readRequiredFile(
    runtimeFilePath({
      root: input.root,
      ownerSlug: input.run.ownerSlug,
      runId: input.run.id,
      name: "cost.jsonl",
    }),
    "cost",
  );
  const eventFingerprint = sha256(eventsContents);
  const costFingerprint = sha256(costContents);
  const events = sourceLines(eventsContents).map((source) => {
    const parsed = parseJsonLine(source, "events");
    if (typeof parsed.type !== "string" || parsed.type.length === 0) {
      throw new LegacyImportError(
        `legacy event has no type at line:${source.line}:byte:${source.byteOffset}`,
        "events",
        "event_type_missing",
        `line:${source.line}:byte:${source.byteOffset}`,
        eventFingerprint,
      );
    }

    return { source, event: parsed as LegacyEvent };
  });
  const costs = sourceLines(costContents).map((source) => ({
    source,
    record: parseJsonLine(source, "cost"),
  }));

  await input.client.query("BEGIN");
  try {
    const lockedRun = await input.client.query<{
      next_execution_event_sequence: string;
    }>(
      "SELECT next_execution_event_sequence FROM runs WHERE id = $1 FOR UPDATE",
      [input.run.id],
    );
    if (!lockedRun.rows[0]) throw new Error("legacy run disappeared during import");
    const fileArtifacts = await input.client.query<{ id: string }>(
      `SELECT id FROM artifact_instances
       WHERE run_id = $1 AND locator->>'kind' = 'file' LIMIT 1`,
      [input.run.id],
    );
    if (fileArtifacts.rows[0]) {
      throw new LegacyImportError(
        "legacy run still has a file-backed runtime artifact",
        "runtime_objects",
        "file_artifact_unpreserved",
      );
    }
    const priorImports = await input.client.query<{
      sourceKind: string;
      state: string;
      fingerprint: string | null;
    }>(
      `SELECT source_kind AS "sourceKind", state,
          source_fingerprint AS fingerprint
       FROM execution_data_plane_imports
       WHERE run_id = $1 FOR UPDATE`,
      [input.run.id],
    );
    const complete = new Set(
      priorImports.rows
        .filter((row) => row.state === "complete")
        .map((row) => row.sourceKind),
    );
    const requiredKinds: readonly ImportSourceKind[] = [
      "events",
      "transcript",
      "cost",
      "runtime_objects",
    ];
    if (requiredKinds.every((kind) => complete.has(kind))) {
      const priorEvents = priorImports.rows.find((row) => row.sourceKind === "events");
      const priorCost = priorImports.rows.find((row) => row.sourceKind === "cost");
      const priorRuntimeObjects = priorImports.rows.find(
        (row) => row.sourceKind === "runtime_objects",
      );
      const changedSource =
        priorEvents?.fingerprint !== eventFingerprint
          ? { kind: "events" as const, fingerprint: eventFingerprint }
          : priorCost?.fingerprint !== costFingerprint
            ? { kind: "cost" as const, fingerprint: costFingerprint }
            : priorRuntimeObjects?.fingerprint !== runtimeObjectAudit.fingerprint
              ? {
                  kind: "runtime_objects" as const,
                  fingerprint: runtimeObjectAudit.fingerprint,
                }
              : null;
      if (changedSource) {
        throw new LegacyImportError(
          "completed legacy import source fingerprint changed",
          changedSource.kind,
          "source_fingerprint_changed",
          null,
          changedSource.fingerprint,
        );
      }
      await input.client.query("COMMIT");

      return {
        runId: input.run.id,
        eventCount: events.length,
        transcriptCount: events.filter(({ event }) =>
          TRANSCRIPT_EVENT_TYPES.has(event.type),
        ).length,
        costCount: costs.length,
        alreadyComplete: true,
      };
    }
    const attempts = await input.client.query<NodeAttempt>(
      `SELECT id, acp_session_id AS "acpSessionId"
       FROM node_attempts WHERE run_id = $1`,
      [input.run.id],
    );
    const attemptIdBySession = new Map(
      attempts.rows
        .filter((attempt) => attempt.acpSessionId)
        .map((attempt) => [attempt.acpSessionId as string, attempt.id] as const),
    );
    let sequence = BigInt(lockedRun.rows[0].next_execution_event_sequence);
    const transcriptPayloads: Record<string, unknown>[] = [];
    for (const { source, event } of events) {
      const occurrence = eventOccurredAt(event, input.run.stableOccurredAt);
      const payload = eventPayload(event, attemptIdBySession, source);
      if (occurrence.approximate) payload.legacyOccurredAtApproximate = true;
      if (TRANSCRIPT_EVENT_TYPES.has(event.type)) transcriptPayloads.push(payload);
      await insertLegacyEvent({
        client: input.client,
        runId: input.run.id,
        sourceKey: `events:${source.byteOffset}:${sha256(source.raw)}`,
        eventType: event.type,
        payloadSchema: schemaForLegacyEvent(event, source),
        payload,
        occurredAt: occurrence.value,
        hostSessionId:
          typeof event.sessionId === "string" ? event.sessionId : null,
        runSequence: sequence,
      });
      sequence += 1n;
    }
    for (const { source, record } of costs) {
      const payload = canonicalUsagePayload(record, source);
      await insertLegacyEvent({
        client: input.client,
        runId: input.run.id,
        sourceKey: `cost:${source.byteOffset}:${sha256(source.raw)}`,
        eventType: "usage.recorded",
        payloadSchema: "maister.usage.recorded.v1",
        payload,
        occurredAt: new Date(String(record.ts)).toISOString(),
        hostSessionId:
          typeof record.sessionId === "string" ? record.sessionId : null,
        runSequence: sequence,
      });
      sequence += 1n;
    }
    await input.client.query(
      "UPDATE runs SET next_execution_event_sequence = $2 WHERE id = $1",
      [input.run.id, sequence.toString()],
    );
    const eventPosition = `byte:${Buffer.byteLength(eventsContents, "utf8")}`;
    const costPosition = `byte:${Buffer.byteLength(costContents, "utf8")}`;
    await upsertImportState({
      client: input.client,
      runId: input.run.id,
      sourceKind: "events",
      state: "complete",
      fingerprint: eventFingerprint,
      lastSourcePosition: eventPosition,
      importedCount: events.length,
      error: null,
    });
    await upsertImportState({
      client: input.client,
      runId: input.run.id,
      sourceKind: "transcript",
      state: "complete",
      fingerprint: sha256(JSON.stringify(transcriptPayloads)),
      lastSourcePosition: eventPosition,
      importedCount: transcriptPayloads.length,
      error: null,
    });
    await upsertImportState({
      client: input.client,
      runId: input.run.id,
      sourceKind: "cost",
      state: "complete",
      fingerprint: costFingerprint,
      lastSourcePosition: costPosition,
      importedCount: costs.length,
      error: null,
    });
    await upsertImportState({
      client: input.client,
      runId: input.run.id,
      sourceKind: "runtime_objects",
      state: "complete",
      fingerprint: runtimeObjectAudit.fingerprint,
      lastSourcePosition: `entries:${runtimeObjectAudit.checkedEntries}`,
      importedCount: 0,
      error: null,
    });
    await input.client.query("COMMIT");

    return {
      runId: input.run.id,
      eventCount: events.length,
      transcriptCount: transcriptPayloads.length,
      costCount: costs.length,
      alreadyComplete: false,
    };
  } catch (error) {
    await input.client.query("ROLLBACK");
    throw error;
  }
}

// D9 step 4/8: the importer runs on a half-staged database, where the migration
// ledger is least trustworthy. Read the stage from the schema the database
// actually carries — 0134 drops the scratch mirror column, 0135 drops the
// artifact projection cursors — so a partially applied ledger cannot admit an
// import into the wrong window.
async function readDataPlaneStage(client: Client): Promise<DataPlaneStage> {
  const tables = await client.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('execution_data_plane_imports', 'artifact_projection_cursors')`,
  );
  const mirror = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'scratch_runs'
       AND column_name = 'supervisor_session_id'`,
  );
  const names = tables.rows.map((row) => row.name);

  return classifyDataPlaneStage({
    importLanes: names.includes("execution_data_plane_imports"),
    artifactProjectionCursors: names.includes("artifact_projection_cursors"),
    scratchMirror: mirror.rows.length > 0,
  });
}

// The operator correlates one invocation's log lines and its resumable state by
// this opaque ID; a supplied one continues an earlier attempt's records.
function resolveImportId(argv: readonly string[]): string {
  const index = argv.findIndex(
    (arg) => arg === "--import-id" || arg.startsWith("--import-id="),
  );

  if (index < 0) return randomUUID();

  const arg = argv[index];
  const value = arg.startsWith("--import-id=")
    ? arg.slice("--import-id=".length)
    : (argv[index + 1] ?? "");

  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(value)) {
    throw new Error(
      "--import-id must be 1-64 characters of [A-Za-z0-9._:-]",
    );
  }

  return value;
}

const INVENTORY_FLAGS = new Set(["--import-id", "--manifest-dir", "--batch-size"]);
const COPY_FLAGS = new Set(["--import-id", "--manifest-dir", "--generation"]);
const ASSOCIATE_FLAGS = COPY_FLAGS;

function parseFlags(
  argv: readonly string[],
  allowed: ReadonlySet<string>,
  mode: string,
): Map<string, string> {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) continue;

    const equals = arg.indexOf("=");
    const name = equals < 0 ? arg : arg.slice(0, equals);
    const inline = equals < 0 ? null : arg.slice(equals + 1);

    if (!allowed.has(name)) {
      throw new Error(
        `unknown ${mode} flag ${name}; expected one of ${[...allowed].join(", ")}`,
      );
    }
    const next = argv[index + 1];
    const value = inline ?? (next && !next.startsWith("--") ? next : "");

    if (!value) throw new Error(`${name} requires a value`);
    values.set(name, value);
  }

  return values;
}

function requireManifestDir(values: ReadonlyMap<string, string>): string {
  const manifestDir = values.get("--manifest-dir") ?? "";

  if (!manifestDir) {
    throw new Error("--manifest-dir is required: the operator owns the manifest");
  }

  return path.resolve(manifestDir);
}

function parseInventoryArguments(argv: readonly string[]): {
  manifestDir: string;
  batchSize: number;
} {
  const values = parseFlags(argv, INVENTORY_FLAGS, "inventory");
  const rawBatchSize = values.get("--batch-size");
  const batchSize = rawBatchSize ? Number(rawBatchSize) : DEFAULT_INVENTORY_BATCH;

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("--batch-size must be a positive integer");
  }

  return { manifestDir: requireManifestDir(values), batchSize };
}

function parseCopyArguments(argv: readonly string[]): {
  manifestDir: string;
  generation: number;
} {
  const values = parseFlags(argv, COPY_FLAGS, "copy");
  const generation = Number(values.get("--generation"));

  // The supervisor mints this when it enables admission and logs it as
  // `import_admission_enabled`. Naming it here is what makes a stale invocation
  // left over from an earlier enablement refuse instead of write.
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error(
      "--generation is required: the generation the supervisor logged when it enabled this import",
    );
  }

  return { manifestDir: requireManifestDir(values), generation };
}

function rowFingerprint(row: Record<string, unknown>): string {
  return sha256(
    JSON.stringify(
      Object.keys(row)
        .sort()
        .map((key) => [key, row[key] ?? null]),
    ),
  );
}

// Locators recorded at Stage A are rooted under the legacy run directory. A
// payload that resolves outside it is never silently adopted: the scan will not
// have seen it, so the lane blocks with `missing_association_payload`.
function associationRelativePath(
  runDirectory: string,
  locatorPath: string,
): string {
  const absolute = path.isAbsolute(locatorPath)
    ? locatorPath
    : path.join(runDirectory, locatorPath);

  return path.relative(runDirectory, absolute).split(path.sep).join("/");
}

async function collectRunAssociations(input: {
  client: Client;
  runId: string;
  runDirectory: string;
}): Promise<{
  associations: LegacyAssociation[];
  locators: Map<string, string>;
}> {
  const artifacts = await input.client.query<Record<string, unknown>>(
    `SELECT id, kind, producer, validity, required_for AS "requiredFor",
        node_attempt_id AS "nodeAttemptId", locator
     FROM artifact_instances
     WHERE run_id = $1 AND locator->>'kind' = 'file' ORDER BY id`,
    [input.runId],
  );
  // `value` is in the projection because S4.4 OVERWRITES it: every column the
  // association phase rewrites must be inside the frozen fingerprint, or a
  // concurrent edit to it would be destroyed instead of refused.
  const attachments = await input.client.query<Record<string, unknown>>(
    `SELECT id, message_id AS "messageId", kind, value, file_name AS "fileName",
        mime_type AS "mimeType", byte_size AS "byteSize", sha256,
        storage_path AS "storagePath"
     FROM scratch_attachments
     WHERE run_id = $1 AND storage_path IS NOT NULL ORDER BY id`,
    [input.runId],
  );
  const associations: LegacyAssociation[] = [];
  const locators = new Map<string, string>();

  for (const row of artifacts.rows) {
    const locator = row.locator as { kind: string; path?: string };
    const locatorPath = locator.path ?? "";

    associations.push({
      associationKind: "artifact",
      id: String(row.id),
      relativePath: associationRelativePath(input.runDirectory, locatorPath),
      rowFingerprint: rowFingerprint(row),
    });
    locators.set(`artifact:${String(row.id)}`, JSON.stringify(locator));
  }

  for (const row of attachments.rows) {
    associations.push({
      associationKind: "attachment",
      id: String(row.id),
      relativePath: associationRelativePath(
        input.runDirectory,
        String(row.storagePath),
      ),
      rowFingerprint: rowFingerprint(row),
    });
    locators.set(`attachment:${String(row.id)}`, String(row.storagePath));
  }

  return { associations, locators };
}

// D9 step 4. One operation: account for every source and association, register
// the immutable manifest, and commit `pending` lanes carrying the manifest
// digest. It copies nothing and completes nothing.
async function inventoryLegacyRuns(input: {
  client: Client;
  root: string;
  importId: string;
  stage: DataPlaneStage;
  manifestDir: string;
  batchSize: number;
}): Promise<{ runCount: number; laneCount: number; unresolvedCount: number }> {
  await mkdir(input.manifestDir, { recursive: true, mode: 0o700 });
  const store = openImportManifestStore({
    file: path.join(input.manifestDir, `import-${input.importId}.sqlite`),
    importId: input.importId,
  });
  const runs = await input.client.query<LegacyRun>(
    `SELECT r.id, coalesce(p.slug, lp.slug) AS "ownerSlug",
        r.started_at::text AS "stableOccurredAt"
     FROM runs r
     LEFT JOIN projects p ON p.id = r.project_id
     LEFT JOIN local_packages lp ON lp.id = r.local_package_id
     WHERE r.execution_data_plane_mode = 'legacy_file_v1'
     ORDER BY r.id`,
  );
  let laneCount = 0;
  let unresolvedCount = 0;

  try {
    for (const run of runs.rows) {
      const refuse = (reason: string, detail: Record<string, unknown>): void => {
        unresolvedCount += 1;
        log.error(
          {
            event: "legacy_execution_data_inventory_refused",
            importId: input.importId,
            runId: run.id,
            reason,
            ...detail,
          },
          "legacy execution-data inventory refused",
        );
      };

      if (!run.ownerSlug) {
        refuse("owner_missing", {});
        continue;
      }

      const priorLanes = await input.client.query<{
        kind: LegacyLaneKind;
        state: string;
        fingerprint: string | null;
      }>(
        `SELECT source_kind AS kind, state, source_fingerprint AS fingerprint
         FROM execution_data_plane_imports WHERE run_id = $1`,
        [run.id],
      );
      const completed = priorLanes.rows.filter((lane) => lane.state === "complete");

      if (completed.length > 0) {
        refuse("lane_already_complete", {
          lanes: completed.map((lane) => lane.kind),
        });
        continue;
      }

      const runDirectory = runtimeRunDirectory({
        root: input.root,
        ownerSlug: run.ownerSlug,
        runId: run.id,
      });
      const { associations, locators } = await collectRunAssociations({
        client: input.client,
        runId: run.id,
        runDirectory,
      });
      const sourcePaths = new Map<string, string>();
      const inventory = await inventoryLegacyRun({
        runDirectory,
        runId: run.id,
        frozenSourceId: input.importId,
        associations,
        pageSize: input.batchSize,
        onSource: (source) =>
          sourcePaths.set(source.relativePathDigest, source.relativePath),
      });
      // Only this phase's own `pending` output is comparable: a failed attempt
      // recorded by the row importer carries a fingerprint with different
      // semantics, and 0131's backfill carries none.
      const drifted = priorLanes.rows.find(
        (lane) =>
          lane.state === "pending" &&
          lane.fingerprint !== null &&
          lane.fingerprint !== inventory.lanes[lane.kind]?.manifestDigest,
      );

      // D9: a changed source INVALIDATES the frozen manifest — it never
      // silently replaces it with the new bytes under the same key.
      if (drifted) {
        refuse("source_fingerprint_changed", {
          lane: drifted.kind,
          frozenDigest: drifted.fingerprint,
          scannedDigest: inventory.lanes[drifted.kind].manifestDigest,
        });
        continue;
      }

      store.recordRun({
        inventory,
        sourcePaths,
        associationLocators: locators,
      });

      for (const block of inventory.blocks) {
        log.error(
          {
            event: "legacy_execution_data_inventory_blocked",
            importId: input.importId,
            runId: run.id,
            lane: block.lane,
            reason: block.reason,
            sourceId: block.relativePathDigest,
          },
          "legacy execution-data inventory blocked",
        );
      }

      if (!inventory.complete) {
        unresolvedCount += 1;
        continue;
      }

      for (const lane of Object.values(inventory.lanes)) {
        await upsertImportState({
          client: input.client,
          runId: run.id,
          sourceKind: lane.lane,
          state: "pending",
          fingerprint: lane.manifestDigest,
          lastSourcePosition: `v1:phase=inventory:manifest=${lane.manifestDigest}:items=${lane.expectedItems}`,
          importedCount: 0,
          error: null,
        });
        laneCount += 1;
        log.info(
          {
            event: "legacy_execution_data_lane_inventoried",
            importId: input.importId,
            runId: run.id,
            lane: lane.lane,
            manifestDigest: lane.manifestDigest,
            inspectedScope: lane.inspectedScope,
            expectedItems: lane.expectedItems,
            totalBytes: lane.totalBytes,
          },
          "legacy execution-data lane inventoried",
        );
      }
    }
  } finally {
    store.close();
  }

  return { runCount: runs.rows.length, laneCount, unresolvedCount };
}

// The copy phase spans all five lanes, including `scratch_session`, which the
// row importer's four-kind `sourceKind` cannot name. Its refusals therefore
// carry the same `details.reason` shape the maintenance client raises, and one
// reader handles both.
class ImportCopyError extends Error {
  readonly details: { reason: string };

  constructor(message: string, reason: string) {
    super(message);
    this.name = "ImportCopyError";
    this.details = { reason };
  }
}

// The typed reason is what the operator's failure line reports, never the
// message text.
function typedRefusalReason(error: unknown): string | null {
  const details = asRecord(asRecord(error).details);

  return typeof details.reason === "string" ? details.reason : null;
}

// D9 step 5. The operator copies the frozen manifest's bytes to the host over
// its maintenance socket and seals each one into an ordinary runtime object.
// Nothing here completes a lane — that is D9 step 7's verification — and nothing
// here writes to, moves or removes a source: every source is opened read-only.
async function copyManifestItem(input: {
  client: ImportMaintenanceClient;
  item: OperatorImportItem;
  absolutePath: string;
  receivedBytes: number;
  importId: string;
}): Promise<{ objectId: string; resentBytes: number }> {
  const observed = await stat(input.absolutePath);

  // A source that moved since the inventory invalidates the frozen manifest. It
  // is refused BEFORE any byte is sent rather than discovered at seal, and the
  // manifest is left exactly as the inventory froze it.
  if (!observed.isFile() || observed.size !== input.item.sizeBytes) {
    throw new ImportCopyError(
      "legacy source no longer matches the frozen manifest",
      "source_fingerprint_changed",
    );
  }
  if (input.receivedBytes % IMPORT_CHUNK_BYTES !== 0) {
    throw new ImportCopyError(
      "host resume offset does not fall on this protocol's chunk boundary",
      "import_offset_mismatch",
    );
  }

  const handle = await open(input.absolutePath, "r");
  let offset = input.receivedBytes;
  let resentBytes = 0;

  try {
    while (offset < input.item.sizeBytes) {
      const length = Math.min(IMPORT_CHUNK_BYTES, input.item.sizeBytes - offset);
      const buffer = new Uint8Array(length);
      let filled = 0;

      // A short read is not an ended file: only a read that returns nothing is
      // end of source, and misreporting one as the other would blame the
      // operator's bytes for the reader's behaviour.
      while (filled < length) {
        const { bytesRead } = await handle.read(
          buffer,
          filled,
          length - filled,
          offset + filled,
        );

        if (bytesRead === 0) {
          throw new ImportCopyError(
            "legacy source ended before the frozen manifest's declared size",
            "source_fingerprint_changed",
          );
        }
        filled += bytesRead;
      }

      const ack = await input.client.putChunk({
        itemId: input.item.itemId,
        chunkIndex: offset / IMPORT_CHUNK_BYTES,
        offset,
        bytes: buffer,
      });

      if (ack.outcome === "duplicate") resentBytes += length;
      log.debug(
        {
          event: "legacy_execution_data_chunk_sent",
          importId: input.importId,
          itemId: input.item.itemId,
          chunkIndex: offset / IMPORT_CHUNK_BYTES,
          offset,
          bytes: length,
          outcome: ack.outcome,
          receivedBytes: ack.receivedBytes,
        },
        "legacy execution-data chunk sent",
      );
      offset += length;
    }
  } finally {
    await handle.close();
  }

  const receipt = await input.client.seal(input.item.itemId);

  return { objectId: receipt.objectId, resentBytes };
}

async function runCopyCommand(input: {
  client: Client;
  importId: string;
  root: string;
  argv: readonly string[];
}): Promise<void> {
  const { manifestDir, generation } = parseCopyArguments(input.argv);
  const stage = await assertImportWindow(input.client, input.importId);

  await assertNoActiveLegacyWork(input.client, input.importId, stage);

  const manifest = readOperatorImportManifest({
    directory: manifestDir,
    importId: input.importId,
  });
  const maintenance = createImportMaintenanceClient({
    // The listener owns this layout; the operator directory the supervisor was
    // given and the manifest directory are the same directory by construction.
    socketPath: path.join(manifestDir, "admission", "import.sock"),
    importId: input.importId,
    generation,
    manifestDigest: manifest.digest,
  });
  const progress = await maintenance.progress();
  const byItem = new Map(progress.items.map((item) => [item.itemId, item]));
  const owners = await runOwnerSlugs(
    input.client,
    [...new Set(manifest.items.map((item) => item.runId))],
  );

  log.info(
    {
      event: "legacy_execution_data_copy_started",
      importId: input.importId,
      stage,
      generation,
      items: manifest.items.length,
      alreadySealed: progress.totals.sealed,
      expectedBytes: progress.totals.expectedBytes,
    },
    "legacy execution-data copy started",
  );

  let sealed = 0;
  let skipped = 0;
  let resentBytes = 0;
  const failures: string[] = [];

  for (const item of manifest.items) {
    const hostItem = byItem.get(item.itemId);

    if (!hostItem) {
      failures.push(`${item.itemId}:import_item_unknown`);
      continue;
    }
    if (hostItem.state === "sealed") {
      skipped += 1;
      continue;
    }

    const ownerSlug = owners.get(item.runId);

    if (!ownerSlug) {
      failures.push(`${item.itemId}:owner_slug_missing`);
      continue;
    }

    try {
      const runDirectory = runtimeRunDirectory({
        root: input.root,
        ownerSlug,
        runId: item.runId,
      });
      const absolutePath = path.resolve(runDirectory, item.relativePath);

      if (!absolutePath.startsWith(`${runDirectory}${path.sep}`)) {
        throw new ImportCopyError(
          "manifest source resolves outside its own run directory",
          "source_outside_root",
        );
      }

      const outcome = await copyManifestItem({
        client: maintenance,
        item,
        absolutePath,
        receivedBytes: hostItem.receivedBytes,
        importId: input.importId,
      });

      sealed += 1;
      resentBytes += outcome.resentBytes;
      log.info(
        {
          event: "legacy_execution_data_item_sealed",
          importId: input.importId,
          itemId: item.itemId,
          runId: item.runId,
          lane: item.lane,
          objectId: outcome.objectId,
          bytes: item.sizeBytes,
          resentBytes: outcome.resentBytes,
        },
        "legacy execution-data item sealed",
      );
    } catch (error) {
      const reason = typedRefusalReason(error) ?? "unexpected_copy_failure";

      failures.push(`${item.itemId}:${reason}`);
      log.error(
        {
          event: "legacy_execution_data_item_failed",
          importId: input.importId,
          itemId: item.itemId,
          runId: item.runId,
          lane: item.lane,
          reason,
        },
        "legacy execution-data item failed",
      );
    }
  }

  log.info(
    {
      event: "legacy_execution_data_copy_finished",
      importId: input.importId,
      stage,
      generation,
      sealed,
      skipped,
      resentBytes,
      unresolvedCount: failures.length,
    },
    "legacy execution-data copy finished",
  );

  if (failures.length > 0) {
    throw new Error(`legacy data copy failed for ${failures.join(", ")}`);
  }
}

async function runOwnerSlugs(
  client: Client,
  runIds: readonly string[],
): Promise<Map<string, string>> {
  if (runIds.length === 0) return new Map();

  const rows = await client.query<{ id: string; ownerSlug: string | null }>(
    `SELECT r.id, coalesce(p.slug, lp.slug) AS "ownerSlug"
     FROM runs r
     LEFT JOIN projects p ON p.id = r.project_id
     LEFT JOIN local_packages lp ON lp.id = r.local_package_id
     WHERE r.id = ANY($1::text[])`,
    [runIds],
  );

  return new Map(
    rows.rows
      .filter((row): row is { id: string; ownerSlug: string } =>
        Boolean(row.ownerSlug),
      )
      .map((row) => [row.id, row.ownerSlug]),
  );
}

// D9 step 6. Bytes first, rows second: an association is repointed only after
// the host proves it holds that item's bytes, inside one bounded transaction per
// row, and only against the exact fingerprint the inventory froze. Nothing here
// completes a lane — that is D9 step 9's verification.
type AssociationTarget = {
  itemId: string;
  runId: string;
  kind: "artifact" | "attachment";
  rowId: string;
  rowFingerprint: string;
  objectId: string;
};

function parseAssociationKey(
  key: string,
): { kind: "artifact" | "attachment"; rowId: string } | null {
  const separator = key.indexOf(":");

  if (separator < 0) return null;

  const kind = key.slice(0, separator);
  const rowId = key.slice(separator + 1);

  if (kind !== "artifact" && kind !== "attachment") return null;
  if (!rowId) return null;

  return { kind, rowId };
}

async function readAssociationRow(
  client: Client,
  target: AssociationTarget,
): Promise<Record<string, unknown> | null> {
  // The same projection the inventory fingerprinted. Reading anything else
  // would compare a different row to a frozen digest.
  const query =
    target.kind === "artifact"
      ? `SELECT id, kind, producer, validity, required_for AS "requiredFor",
            node_attempt_id AS "nodeAttemptId", locator
         FROM artifact_instances WHERE id = $1 FOR UPDATE`
      : `SELECT id, message_id AS "messageId", kind, value,
            file_name AS "fileName", mime_type AS "mimeType",
            byte_size AS "byteSize", sha256, storage_path AS "storagePath"
         FROM scratch_attachments WHERE id = $1 FOR UPDATE`;
  const rows = await client.query<Record<string, unknown>>(query, [
    target.rowId,
  ]);

  return rows.rows[0] ?? null;
}

function alreadyAssociated(
  target: AssociationTarget,
  row: Record<string, unknown>,
): boolean {
  if (target.kind === "artifact") {
    const locator = asRecord(row.locator);

    return (
      locator.kind === "execution-object" && locator.objectId === target.objectId
    );
  }

  return row.storagePath === null && row.value === target.objectId;
}

async function repointAssociation(input: {
  client: Client;
  target: AssociationTarget;
  importId: string;
}): Promise<"repointed" | "already"> {
  const { client, target } = input;

  await client.query("BEGIN");
  try {
    const row = await readAssociationRow(client, target);

    if (!row) {
      throw new ImportCopyError(
        "association row is gone",
        "association_row_missing",
      );
    }
    if (alreadyAssociated(target, row)) {
      await client.query("COMMIT");

      return "already";
    }

    // Exact old-row CAS: the frozen fingerprint covers every field the
    // inventory read, so a concurrent edit to validity, kind, attempt or
    // message scope refuses here instead of being overwritten.
    if (rowFingerprint(row) !== target.rowFingerprint) {
      throw new ImportCopyError(
        "association row changed since the inventory froze it",
        "association_row_changed",
      );
    }

    if (target.kind === "artifact") {
      await client.query(
        `UPDATE artifact_instances
         SET locator = jsonb_build_object('kind', 'execution-object',
                                          'objectId', $2::text)
         WHERE id = $1`,
        [target.rowId, target.objectId],
      );
    } else {
      // A canonical uploaded file carries the opaque object id in `value` and
      // no storage path at all; every descriptive column stays as it was.
      await client.query(
        `UPDATE scratch_attachments
         SET value = $2::text, storage_path = NULL
         WHERE id = $1`,
        [target.rowId, target.objectId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  return "repointed";
}

// D9 step 7. `scratch_runs.supervisor_session_id` is an unconstrained legacy
// mirror. 0134 preserves it only when the run has EXACTLY one assignment; a real
// multi-assignment history makes it refuse outright. This resolves that case
// from evidence and never by guessing, then clears only the mirror it proved.
//
// `(execution_host_id, host_session_id)` is unique on `run_session_incarnations`,
// so a host session can never name two assignments — the ambiguity this refuses
// is the opposite one: several assignments and no surviving evidence at all.
type ScratchMirror = {
  runId: string;
  hostSessionId: string;
  assignmentCount: number;
};

async function readScratchMirrors(client: Client): Promise<ScratchMirror[]> {
  const rows = await client.query<{
    runId: string;
    hostSessionId: string;
    assignmentCount: string;
  }>(
    `SELECT sr.run_id AS "runId",
        sr.supervisor_session_id AS "hostSessionId",
        (SELECT count(*) FROM execution_assignments ea WHERE ea.run_id = sr.run_id)::text
          AS "assignmentCount"
     FROM scratch_runs sr
     JOIN runs r ON r.id = sr.run_id
     WHERE sr.supervisor_session_id IS NOT NULL
       AND r.execution_data_plane_mode = 'legacy_file_v1'
     ORDER BY sr.run_id`,
  );

  return rows.rows.map((row) => ({
    runId: row.runId,
    hostSessionId: row.hostSessionId,
    assignmentCount: Number(row.assignmentCount),
  }));
}

async function bindMirrorAssignment(
  client: Client,
  mirror: ScratchMirror,
): Promise<{ assignmentId: string; hostId: string; epoch: number }> {
  const rows = await client.query<{
    assignmentId: string;
    hostId: string;
    epoch: number;
  }>(
    `SELECT DISTINCT ea.id AS "assignmentId",
        ea.execution_host_id AS "hostId", ea.epoch
     FROM execution_assignments ea
     WHERE ea.run_id = $1
       AND (
         EXISTS (
           SELECT 1 FROM run_session_incarnations rsi
           WHERE rsi.run_id = $1
             AND rsi.execution_assignment_id = ea.id
             AND rsi.host_session_id = $2
         )
         OR EXISTS (
           SELECT 1 FROM execution_events ee
           WHERE ee.run_id = $1
             AND ee.execution_assignment_id = ea.id
             AND ee.host_session_id = $2
         )
       )`,
    [mirror.runId, mirror.hostSessionId],
  );

  if (rows.rows.length !== 1) {
    throw new ImportCopyError(
      "no unique assignment owns this legacy scratch session",
      "scratch_mirror_ambiguous",
    );
  }

  return rows.rows[0];
}

async function preserveScratchMirror(input: {
  client: Client;
  mirror: ScratchMirror;
  importId: string;
}): Promise<void> {
  const { client, mirror } = input;

  await client.query("BEGIN");
  try {
    // Bound inside the transaction: the evidence that picks the assignment and
    // the write that acts on it must see the same snapshot.
    const binding = await bindMirrorAssignment(client, mirror);
    // A different canonical host pointer is a data conflict, not a
    // last-write-wins update — the same rule 0134 applies.
    const conflict = await client.query(
      `SELECT 1 FROM run_sessions
       WHERE run_id = $1 AND session_name = 'default'
         AND host_session_id IS NOT NULL AND host_session_id <> $2`,
      [mirror.runId, mirror.hostSessionId],
    );

    if (conflict.rowCount) {
      throw new ImportCopyError(
        "canonical default session already names a different host session",
        "scratch_mirror_conflict",
      );
    }

    await client.query(
      `INSERT INTO run_sessions
        (id, run_id, session_name, execution_assignment_id, host_session_id,
         created_at, updated_at)
       VALUES ('legacy-scratch-session:' || $1, $1, 'default', $2, $3,
               now(), now())
       ON CONFLICT (run_id, session_name) DO UPDATE SET
         execution_assignment_id = excluded.execution_assignment_id,
         host_session_id = excluded.host_session_id,
         updated_at = now()`,
      [mirror.runId, binding.assignmentId, mirror.hostSessionId],
    );
    await client.query(
      `INSERT INTO run_session_incarnations
        (id, run_session_id, run_id, execution_assignment_id, assignment_epoch,
         execution_host_id, host_session_id, state, origin, created_at,
         activated_at, terminal_reason)
       SELECT 'legacy-scratch-incarnation:' || $1, rs.id, $1, $2, $5, $3, $4,
           'exited', 'legacy_backfill', now(), now(),
           jsonb_build_object('source', 'scratch_runs.supervisor_session_id')
       FROM run_sessions rs
       WHERE rs.run_id = $1 AND rs.session_name = 'default'
       ON CONFLICT (execution_host_id, host_session_id) DO NOTHING`,
      [
        mirror.runId,
        binding.assignmentId,
        binding.hostId,
        mirror.hostSessionId,
        binding.epoch,
      ],
    );

    // Round-trip proof BEFORE the clear: the canonical rows must read back as
    // exactly this run's session before the legacy value may leave the row.
    const verified = await client.query(
      `SELECT 1
       FROM run_sessions rs
       JOIN run_session_incarnations rsi
         ON rsi.execution_host_id = $3 AND rsi.host_session_id = $2
       WHERE rs.run_id = $1 AND rs.session_name = 'default'
         AND rs.host_session_id = $2
         AND rsi.run_id = $1`,
      [mirror.runId, mirror.hostSessionId, binding.hostId],
    );

    if (!verified.rowCount) {
      throw new ImportCopyError(
        "canonical scratch session did not read back",
        "scratch_mirror_unproven",
      );
    }

    // CAS on the exact legacy value: a mirror that changed under the operator
    // is left alone rather than cleared on stale evidence.
    const cleared = await client.query(
      `UPDATE scratch_runs SET supervisor_session_id = NULL
       WHERE run_id = $1 AND supervisor_session_id = $2`,
      [mirror.runId, mirror.hostSessionId],
    );

    if (!cleared.rowCount) {
      throw new ImportCopyError(
        "legacy scratch mirror changed under the import",
        "scratch_mirror_changed",
      );
    }
    await client.query("COMMIT");
    log.info(
      {
        event: "legacy_execution_data_mirror_preserved",
        importId: input.importId,
        runId: mirror.runId,
        assignmentId: binding.assignmentId,
        assignmentEpoch: binding.epoch,
        assignmentCount: mirror.assignmentCount,
        // The raw legacy session id never reaches the log.
        mirrorDigest: sha256(mirror.hostSessionId),
      },
      "legacy execution-data scratch mirror preserved",
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function preserveScratchMirrors(input: {
  client: Client;
  importId: string;
  stage: DataPlaneStage;
}): Promise<{ preserved: number; deferred: number; failures: string[] }> {
  // `additive` is the only stage that still carries the legacy column; 0134
  // drops it. Re-running this phase afterwards is an ordinary operator act, so
  // it skips the half that no longer has anything to preserve rather than
  // failing on a column that is gone.
  if (input.stage !== "additive") {
    return { preserved: 0, deferred: 0, failures: [] };
  }

  const mirrors = await readScratchMirrors(input.client);
  const failures: string[] = [];
  let preserved = 0;
  let deferred = 0;

  for (const mirror of mirrors) {
    // Exactly one assignment is 0134's own provable case; leave it there rather
    // than duplicating a destructive migration's work.
    if (mirror.assignmentCount === 1) {
      deferred += 1;
      continue;
    }
    try {
      await preserveScratchMirror({
        client: input.client,
        mirror,
        importId: input.importId,
      });
      preserved += 1;
    } catch (error) {
      const reason = typedRefusalReason(error) ?? "unexpected_mirror_failure";

      failures.push(`${mirror.runId}:${reason}`);
      log.error(
        {
          event: "legacy_execution_data_mirror_refused",
          importId: input.importId,
          runId: mirror.runId,
          assignmentCount: mirror.assignmentCount,
          reason,
        },
        "legacy execution-data scratch mirror refused",
      );
    }
  }

  return { preserved, deferred, failures };
}

async function runAssociateCommand(input: {
  client: Client;
  importId: string;
  argv: readonly string[];
}): Promise<void> {
  const values = parseFlags(input.argv, ASSOCIATE_FLAGS, "associate");
  const manifestDir = requireManifestDir(values);
  const generation = Number(values.get("--generation"));

  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error(
      "--generation is required: the generation the supervisor logged when it enabled this import",
    );
  }

  const stage = await assertImportWindow(input.client, input.importId);

  await assertNoActiveLegacyWork(input.client, input.importId, stage);

  const manifest = readOperatorImportManifest({
    directory: manifestDir,
    importId: input.importId,
  });
  const maintenance = createImportMaintenanceClient({
    socketPath: path.join(manifestDir, "admission", "import.sock"),
    importId: input.importId,
    generation,
    manifestDigest: manifest.digest,
  });
  const progress = await maintenance.progress();
  const sealed = new Map(
    progress.items
      .filter((item) => item.state === "sealed" && item.sealedObjectId)
      .map((item) => [item.itemId, item.sealedObjectId as string]),
  );
  const targets: AssociationTarget[] = [];
  const failures: string[] = [];

  for (const item of manifest.items) {
    const association = parseAssociationKey(item.associationKey);

    if (!association) continue;
    if (!item.rowFingerprint) {
      failures.push(`${item.itemId}:association_fingerprint_missing`);
      continue;
    }

    const objectId = sealed.get(item.itemId);

    // The row is repointed at bytes the host PROVED it holds, never at an
    // object id the operator hoped for.
    if (!objectId) {
      failures.push(`${item.itemId}:association_bytes_unverified`);
      continue;
    }
    targets.push({
      itemId: item.itemId,
      runId: item.runId,
      kind: association.kind,
      rowId: association.rowId,
      rowFingerprint: item.rowFingerprint,
      objectId,
    });
  }

  log.info(
    {
      event: "legacy_execution_data_associate_started",
      importId: input.importId,
      stage,
      generation,
      associations: targets.length,
      unverified: failures.length,
    },
    "legacy execution-data associate started",
  );

  let repointed = 0;
  let alreadyCount = 0;

  for (const target of targets) {
    try {
      const outcome = await repointAssociation({
        client: input.client,
        target,
        importId: input.importId,
      });

      if (outcome === "repointed") repointed += 1;
      else alreadyCount += 1;
      log.info(
        {
          event: "legacy_execution_data_association_repointed",
          importId: input.importId,
          itemId: target.itemId,
          runId: target.runId,
          associationKind: target.kind,
          objectId: target.objectId,
          outcome,
        },
        "legacy execution-data association repointed",
      );
    } catch (error) {
      const reason =
        typedRefusalReason(error) ?? "unexpected_association_failure";

      failures.push(`${target.itemId}:${reason}`);
      log.error(
        {
          event: "legacy_execution_data_association_failed",
          importId: input.importId,
          itemId: target.itemId,
          runId: target.runId,
          associationKind: target.kind,
          reason,
        },
        "legacy execution-data association failed",
      );
    }
  }

  const mirrors = await preserveScratchMirrors({
    client: input.client,
    importId: input.importId,
    stage,
  });

  failures.push(...mirrors.failures);
  log.info(
    {
      event: "legacy_execution_data_associate_finished",
      importId: input.importId,
      stage,
      generation,
      repointed,
      alreadyAssociated: alreadyCount,
      mirrorsPreserved: mirrors.preserved,
      mirrorsDeferredTo0134: mirrors.deferred,
      unresolvedCount: failures.length,
    },
    "legacy execution-data associate finished",
  );

  if (failures.length > 0) {
    throw new Error(`legacy data association failed for ${failures.join(", ")}`);
  }
}

async function runInventoryCommand(input: {
  client: Client;
  importId: string;
  root: string;
  argv: readonly string[];
}): Promise<void> {
  const { manifestDir, batchSize } = parseInventoryArguments(input.argv);
  const stage = await assertImportWindow(input.client, input.importId);

  await assertNoActiveLegacyWork(input.client, input.importId, stage);
  log.info(
    {
      event: "legacy_execution_data_inventory_started",
      importId: input.importId,
      stage,
      batchSize,
    },
    "legacy execution-data inventory started",
  );
  const summary = await inventoryLegacyRuns({
    client: input.client,
    root: input.root,
    importId: input.importId,
    stage,
    manifestDir,
    batchSize,
  });

  log.info(
    {
      event: "legacy_execution_data_inventory_finished",
      importId: input.importId,
      stage,
      ...summary,
    },
    "legacy execution-data inventory finished",
  );

  if (summary.unresolvedCount > 0) {
    throw new Error(
      `legacy inventory left ${summary.unresolvedCount} run(s) unresolved`,
    );
  }
}

async function assertImportWindow(
  client: Client,
  importId: string,
): Promise<DataPlaneStage> {
  const stage = await readDataPlaneStage(client);
  const importWindow = assessLegacyImportWindow(stage);

  if (!importWindow.admitted) {
    log.error(
      {
        event: "legacy_execution_data_import_refused",
        importId,
        stage,
        reason: importWindow.reason,
        remediation: importWindow.remediation,
      },
      "legacy execution-data import refused",
    );

    throw new Error(
      `legacy import refused (${importWindow.reason}): ${importWindow.remediation}`,
    );
  }

  return stage;
}

async function assertNoActiveLegacyWork(
  client: Client,
  importId: string,
  stage: DataPlaneStage,
): Promise<void> {
  const active = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM runs
     WHERE execution_data_plane_mode = 'legacy_file_v1'
       AND status NOT IN ('Done', 'Failed', 'Crashed', 'Abandoned')
     ORDER BY id LIMIT 1`,
  );

  if (!active.rows[0]) return;

  log.error(
    {
      event: "legacy_execution_data_import_refused",
      importId,
      stage,
      reason: "active_legacy_work",
      runId: active.rows[0].id,
    },
    "legacy execution-data import refused",
  );

  throw new Error(
    `legacy import requires every legacy run to be terminal; run ${active.rows[0].id} is ${active.rows[0].status}`,
  );
}

const VERIFY_FLAGS = COPY_FLAGS;

function requireProofArguments(
  argv: readonly string[],
  command: "verify" | "finalize-proof",
): { manifestDir: string; generation: number } {
  const values = parseFlags(argv, VERIFY_FLAGS, command);
  const manifestDir = requireManifestDir(values);
  const generation = Number(values.get("--generation"));

  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error(
      "--generation is required: the generation the supervisor logged when it enabled this import",
    );
  }

  return { manifestDir, generation };
}

async function digestFile(
  absolutePath: string,
): Promise<{ sizeBytes: number; sha256: string } | null> {
  const observed = await stat(absolutePath).catch(() => null);

  if (!observed?.isFile()) return null;

  const hash = createHash("sha256");
  let sizeBytes = 0;

  for await (const chunk of createReadStream(absolutePath, {
    highWaterMark: IMPORT_CHUNK_BYTES,
  }) as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    sizeBytes += chunk.byteLength;
  }

  return { sizeBytes, sha256: hash.digest("hex") };
}

// What the row points at TODAY, in the canonical shape S4.4 wrote. A row that
// was never repointed answers null here exactly like one that drifted, and both
// are refusals — the lane cannot be proved by a row that does not name the
// object whose bytes the lane is made of.
async function readAssociatedObjectId(
  client: Client,
  association: { kind: "artifact" | "attachment"; rowId: string },
): Promise<string | null> {
  const rows =
    association.kind === "artifact"
      ? await client.query<{ objectId: string | null }>(
          `SELECT CASE WHEN locator->>'kind' = 'execution-object'
                THEN locator->>'objectId' END AS "objectId"
           FROM artifact_instances WHERE id::text = $1`,
          [association.rowId],
        )
      : await client.query<{ objectId: string | null }>(
          `SELECT CASE WHEN storage_path IS NULL THEN value END AS "objectId"
           FROM scratch_attachments WHERE id::text = $1`,
          [association.rowId],
        );

  return rows.rows[0]?.objectId ?? null;
}

async function verifyManifestItem(input: {
  client: Client;
  maintenance: ImportMaintenanceClient;
  item: ManifestProofItemRow;
  objectId: string;
  ownerSlug: string | null;
  root: string;
}): Promise<ProofRefusal | null> {
  // The host streams the SEALED object back. A seal-time digest proves what
  // arrived; only a readback proves what the host can still hand over.
  const readback = await input.maintenance.readbackDigest(input.item.itemId);

  if (readback.sizeBytes !== input.item.sizeBytes) return "verify_bytes_missing";
  if (readback.sha256 !== input.item.sha256) return "verify_hash_mismatch";
  if (!input.ownerSlug) return "verify_source_changed";

  const runDirectory = runtimeRunDirectory({
    root: input.root,
    ownerSlug: input.ownerSlug,
    runId: input.item.runId,
  });
  const absolutePath = path.resolve(runDirectory, input.item.relativePath);

  if (!absolutePath.startsWith(`${runDirectory}${path.sep}`))
    return "verify_source_changed";

  // D9 step 9 re-checks the freeze: a proof is worth nothing if the source it
  // was compared against moved while the import was running.
  const source = await digestFile(absolutePath);

  if (
    !source ||
    source.sizeBytes !== input.item.sizeBytes ||
    source.sha256 !== input.item.sha256
  )
    return "verify_source_changed";

  const association = parseAssociationKey(input.item.associationKey);

  if (!association) return null;

  return (await readAssociatedObjectId(input.client, association)) ===
    input.objectId
    ? null
    : "verify_association_drifted";
}

async function verifyScratchShape(input: {
  client: Client;
  stage: DataPlaneStage;
  runIds: readonly string[];
  items: readonly ManifestProofItemRow[];
}): Promise<RunRefusal[]> {
  // `additive` still carries the mirror 0134 has not dropped, so there is no
  // post-migration shape to count yet. The check exists for the tree AFTER
  // 0134, where a scratch attachment that quietly kept its legacy path is a
  // hole the five-lane preflight would otherwise wave straight through.
  if (input.stage === "additive") return [];

  const refusals: RunRefusal[] = [];

  for (const runId of input.runIds) {
    const expected = input.items
      .filter(
        (item) =>
          item.runId === runId &&
          item.lane === "scratch_session" &&
          item.associationKey.startsWith("attachment:"),
      )
      .map((item) => item.associationKey.slice("attachment:".length));

    if (expected.length === 0) continue;

    const canonical = await input.client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM scratch_attachments
       WHERE run_id = $1 AND id::text = ANY($2::text[])
         AND storage_path IS NULL`,
      [runId, expected],
    );

    if ((canonical.rows[0]?.n ?? 0) !== expected.length)
      refusals.push({
        runId,
        lane: "scratch_session",
        refusal: "verify_scratch_count_mismatch",
      });
  }

  return refusals;
}

// D9 steps 8-9. Nothing before this proved preservation: `copy` proved a byte
// arrived and `associate` proved a row was rewritten, but neither proves the
// host can still hand back what the operator froze. Every sealed object is
// streamed back and folded into a digest, every source is re-hashed against the
// freeze, every rewritten row is read back — and one pure reducer decides.
async function computeImportProof(input: {
  client: Client;
  importId: string;
  root: string;
  manifestDir: string;
  generation: number;
  stage: DataPlaneStage;
}): Promise<RunProof[]> {
  const manifest = readOperatorImportManifest({
    directory: input.manifestDir,
    importId: input.importId,
  });
  const frozen = readImportManifestRows({
    file: path.join(input.manifestDir, `import-${input.importId}.sqlite`),
    importId: input.importId,
  });
  const maintenance = createImportMaintenanceClient({
    socketPath: path.join(input.manifestDir, "admission", "import.sock"),
    importId: input.importId,
    generation: input.generation,
    manifestDigest: manifest.digest,
  });
  const progress = await maintenance.progress();
  const sealed = new Map(
    progress.items
      .filter((item) => item.state === "sealed" && item.sealedObjectId)
      .map((item) => [item.itemId, item.sealedObjectId as string]),
  );
  const runIds = [...new Set(frozen.lanes.map((lane) => lane.runId))].sort();
  const owners = await runOwnerSlugs(input.client, runIds);
  const items: ItemOutcome[] = [];

  for (const item of frozen.items) {
    const outcome: ItemOutcome = {
      itemId: item.itemId,
      runId: item.runId,
      lane: item.lane,
      sizeBytes: item.sizeBytes,
      refusal: null,
    };
    // A manager-authoritative source never became an object: the manager owns
    // that state already, and the lane accounts for it where it lives.
    const objectId =
      item.disposition === "copy" ? (sealed.get(item.itemId) ?? null) : null;

    if (item.disposition !== "copy") {
      items.push(outcome);
      continue;
    }
    items.push(
      objectId
        ? {
            ...outcome,
            refusal: await verifyManifestItem({
              client: input.client,
              maintenance,
              item,
              objectId,
              ownerSlug: owners.get(item.runId) ?? null,
              root: input.root,
            }),
          }
        : { ...outcome, refusal: "verify_item_unsealed" },
    );
  }

  return reduceRunProofs({
    runIds,
    expectations: frozen.lanes,
    items,
    runRefusals: await verifyScratchShape({
      client: input.client,
      stage: input.stage,
      runIds,
      items: frozen.items,
    }),
  });
}

function logProof(input: {
  event: string;
  importId: string;
  stage: DataPlaneStage;
  proofs: readonly RunProof[];
}): void {
  log.info(
    {
      event: input.event,
      importId: input.importId,
      stage: input.stage,
      proofVersion: IMPORT_PROOF_VERSION,
      runCount: input.proofs.length,
      unresolvedCount: input.proofs.filter((proof) => !proof.holds).length,
      // Counts and bytes only. The proof is about preserved content and must
      // never carry any of it, nor an operator source path.
      lanes: input.proofs.flatMap((proof) =>
        proof.lanes.map((lane) => ({
          runId: proof.runId,
          lane: lane.lane,
          expectedItems: lane.expectedItems,
          verifiedItems: lane.verifiedItems,
          expectedBytes: lane.expectedBytes,
          verifiedBytes: lane.verifiedBytes,
        })),
      ),
    },
    "legacy execution-data proof evaluated",
  );
}

function refuseUnprovenRuns(proofs: readonly RunProof[]): void {
  const failing = proofs.filter((proof) => !proof.holds);

  if (failing.length === 0) return;

  log.error(
    {
      event: "legacy_execution_data_proof_refused",
      unresolvedCount: failing.length,
      refusals: failing.flatMap((proof) => proof.refusals),
    },
    "legacy execution-data proof refused",
  );

  throw new Error(
    `legacy import proof refused for ${failing
      .map((proof) => `${proof.runId}:${proof.refusals.join(",")}`)
      .join("; ")}`,
  );
}

async function runVerifyCommand(input: {
  client: Client;
  importId: string;
  root: string;
  argv: readonly string[];
}): Promise<void> {
  const { manifestDir, generation } = requireProofArguments(
    input.argv,
    "verify",
  );
  const stage = await assertImportWindow(input.client, input.importId);

  await assertNoActiveLegacyWork(input.client, input.importId, stage);

  const proofs = await computeImportProof({
    client: input.client,
    importId: input.importId,
    root: input.root,
    manifestDir,
    generation,
    stage,
  });

  logProof({
    event: "legacy_execution_data_verify_finished",
    importId: input.importId,
    stage,
    proofs,
  });
  refuseUnprovenRuns(proofs);
}

async function runFinalizeProofCommand(input: {
  client: Client;
  importId: string;
  root: string;
  argv: readonly string[];
}): Promise<void> {
  const { manifestDir, generation } = requireProofArguments(
    input.argv,
    "finalize-proof",
  );
  const stage = await assertImportWindow(input.client, input.importId);

  await assertNoActiveLegacyWork(input.client, input.importId, stage);

  const proofs = await computeImportProof({
    client: input.client,
    importId: input.importId,
    root: input.root,
    manifestDir,
    generation,
    stage,
  });

  logProof({
    event: "legacy_execution_data_finalize_evaluated",
    importId: input.importId,
    stage,
    proofs,
  });
  // Nothing is written until every lane of every run holds. A `complete` record
  // is the only thing unchanged 0135 reads, so writing one for a run whose
  // proof failed would hand the cutover the exact false proof it exists to
  // refuse.
  refuseUnprovenRuns(proofs);

  for (const proof of proofs) {
    await input.client.query("BEGIN");
    try {
      // One transaction per run: no lane reaches `complete` without the
      // verified count, byte position and lane fingerprint that justify it.
      for (const lane of proof.lanes) {
        await upsertImportState({
          client: input.client,
          runId: proof.runId,
          sourceKind: lane.lane,
          state: "complete",
          fingerprint: lane.fingerprint,
          lastSourcePosition: lane.position,
          importedCount: lane.verifiedItems,
          error: null,
        });
      }
      await input.client.query("COMMIT");
    } catch (error) {
      await input.client.query("ROLLBACK");
      throw error;
    }
  }
  log.info(
    {
      event: "legacy_execution_data_proof_finalized",
      importId: input.importId,
      stage,
      proofVersion: IMPORT_PROOF_VERSION,
      runCount: proofs.length,
    },
    "legacy execution-data proof finalized",
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;

  const SUBCOMMANDS = [
    "inventory",
    "copy",
    "associate",
    "verify",
    "finalize-proof",
  ] as const;

  if (command !== null && !SUBCOMMANDS.includes(command as never)) {
    throw new Error(
      `unknown command ${command}; expected one of ${SUBCOMMANDS.join(", ")}`,
    );
  }

  const importId = resolveImportId(argv);
  const client = new Client({ connectionString: requiredEnv("DB_URL") });
  const root = requiredEnv("MAISTER_LEGACY_RUNTIME_ROOT");
  await client.connect();
  try {
    if (command === "inventory") {
      await runInventoryCommand({ client, importId, root, argv });

      return;
    }
    if (command === "copy") {
      await runCopyCommand({ client, importId, root, argv });

      return;
    }
    if (command === "associate") {
      await runAssociateCommand({ client, importId, argv });

      return;
    }
    if (command === "verify") {
      await runVerifyCommand({ client, importId, root, argv });

      return;
    }
    if (command === "finalize-proof") {
      await runFinalizeProofCommand({ client, importId, root, argv });

      return;
    }

    const stage = await assertImportWindow(client, importId);

    await assertNoActiveLegacyWork(client, importId, stage);
    log.info(
      { event: "legacy_execution_data_import_started", importId, stage },
      "legacy execution-data import started",
    );
    const runs = await client.query<LegacyRun>(
      `SELECT r.id, coalesce(p.slug, lp.slug) AS "ownerSlug",
          r.started_at::text AS "stableOccurredAt"
       FROM runs r
       LEFT JOIN projects p ON p.id = r.project_id
       LEFT JOIN local_packages lp ON lp.id = r.local_package_id
       WHERE r.execution_data_plane_mode = 'legacy_file_v1'
       ORDER BY r.id`,
    );
    const failures: string[] = [];
    for (const run of runs.rows) {
      try {
        const summary = await importRun({ client, run, root });
        log.info({ event: "legacy_execution_data_imported", importId, ...summary });
      } catch (error) {
        await recordImportFailure(client, run.id, error);
        const failure = error instanceof LegacyImportError ? error : null;
        failures.push(`${run.id}:${failure?.reason ?? "unexpected_import_failure"}`);
        log.error(
          {
            event: "legacy_execution_data_import_failed",
            importId,
            runId: run.id,
            sourceKind: failure?.sourceKind ?? null,
            reason: failure?.reason ?? "unexpected_import_failure",
            sourcePosition: failure?.sourcePosition ?? null,
          },
          "legacy execution-data import failed",
        );
      }
    }
    log.info(
      {
        event: "legacy_execution_data_import_finished",
        importId,
        stage,
        runCount: runs.rows.length,
        unresolvedCount: failures.length,
      },
      "legacy execution-data import finished",
    );
    if (failures.length > 0) {
      throw new Error(`legacy data import failed for ${failures.join(", ")}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  log.fatal(
    { err: error instanceof Error ? error.message : String(error) },
    "legacy execution-data import terminated",
  );
  process.exitCode = 1;
});
