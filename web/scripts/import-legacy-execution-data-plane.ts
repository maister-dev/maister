import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
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

import {
  inventoryLegacyRun,
  type LegacyAssociation,
} from "./legacy-import/inventory";
import { openImportManifestStore } from "./legacy-import/manifest-store";

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

function parseInventoryArguments(argv: readonly string[]): {
  manifestDir: string;
  batchSize: number;
} {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) continue;

    const equals = arg.indexOf("=");
    const name = equals < 0 ? arg : arg.slice(0, equals);
    const inline = equals < 0 ? null : arg.slice(equals + 1);

    if (!INVENTORY_FLAGS.has(name)) {
      throw new Error(
        `unknown inventory flag ${name}; expected one of ${[...INVENTORY_FLAGS].join(", ")}`,
      );
    }
    const next = argv[index + 1];
    const value = inline ?? (next && !next.startsWith("--") ? next : "");

    if (!value) throw new Error(`${name} requires a value`);
    values.set(name, value);
  }

  const manifestDir = values.get("--manifest-dir") ?? "";

  if (!manifestDir) {
    throw new Error("--manifest-dir is required: the operator owns the manifest");
  }

  const rawBatchSize = values.get("--batch-size");
  const batchSize = rawBatchSize ? Number(rawBatchSize) : DEFAULT_INVENTORY_BATCH;

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("--batch-size must be a positive integer");
  }

  return { manifestDir: path.resolve(manifestDir), batchSize };
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
  const attachments = await input.client.query<Record<string, unknown>>(
    `SELECT id, message_id AS "messageId", kind, file_name AS "fileName",
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;

  if (command !== null && command !== "inventory") {
    throw new Error(`unknown command ${command}; expected "inventory"`);
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
