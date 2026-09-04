import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "pg";

type LegacyRun = {
  id: string;
  ownerSlug: string | null;
};

type LegacyEvent = Record<string, unknown> & { type: string };

type LegacyCostRecord = Record<string, unknown>;

type NodeAttempt = {
  id: string;
  acpSessionId: string | null;
};

const ALLOW_EMPTY_FLAG = "--allow-missing-runtime-data";
const MAX_LEGACY_LINE_BYTES = 1_048_576;
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
};

function requiredEnv(name: "DB_URL" | "MAISTER_LEGACY_RUNTIME_ROOT"): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required for legacy execution-data import`);
  }

  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }

  return value as Record<string, unknown>;
}

function parseJsonLine(raw: string, label: string): Record<string, unknown> {
  if (Buffer.byteLength(raw, "utf8") > MAX_LEGACY_LINE_BYTES) {
    throw new Error(`${label} exceeds ${MAX_LEGACY_LINE_BYTES} bytes`);
  }

  try {
    return asRecord(JSON.parse(raw) as unknown, label);
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function eventPayload(
  event: LegacyEvent,
  attemptIdBySession: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const { type: _type, monotonicId: _monotonicId, ...payload } = event;
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
  const nodeAttemptId =
    typeof payload.nodeAttemptId === "string"
      ? payload.nodeAttemptId
      : sessionId
        ? attemptIdBySession.get(sessionId)
        : undefined;

  return nodeAttemptId ? { ...payload, nodeAttemptId } : payload;
}

function schemaForLegacyEvent(event: LegacyEvent, label: string): string {
  const schema = LEGACY_EVENT_SCHEMAS[event.type];

  if (!schema) {
    throw new Error(`${label} has unsupported event type ${JSON.stringify(event.type)}`);
  }

  return schema;
}

function occurredAt(record: Record<string, unknown>): string {
  const candidate = record.ts;

  if (typeof candidate === "string" && !Number.isNaN(Date.parse(candidate))) {
    return new Date(candidate).toISOString();
  }

  return new Date().toISOString();
}

function canonicalUsagePayload(record: LegacyCostRecord): Record<string, unknown> {
  return {
    inputTokens: record.input_tokens,
    outputTokens: record.output_tokens,
    cacheReadInputTokens: record.cache_read_input_tokens,
    cacheCreationInputTokens: record.cache_creation_input_tokens,
    model: record.model,
    sessionName: record.sessionName,
    nodeAttemptId: record.nodeAttemptId,
    resumed: record.resumed,
  };
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
  const expectedPrefix = `${root}${path.sep}`;

  if (!target.startsWith(expectedPrefix)) {
    throw new Error(`legacy runtime path escapes configured root for run ${input.runId}`);
  }

  return target;
}

async function readOptionalFile(
  filePath: string,
): Promise<{ found: boolean; contents: string }> {
  try {
    return { found: true, contents: await readFile(filePath, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") return { found: false, contents: "" };
    throw error;
  }
}

function nonEmptyLines(contents: string): readonly string[] {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function upsertImportState(input: {
  client: Client;
  runId: string;
  sourceKind: "events" | "transcript" | "cost" | "runtime_objects" | "scratch_session";
  state: "complete" | "missing" | "failed";
  fingerprint: string | null;
  importedCount: number;
  error: Record<string, unknown> | null;
}): Promise<void> {
  await input.client.query(
    `INSERT INTO execution_data_plane_imports
      (run_id, source_kind, state, source_fingerprint, imported_count, last_error, started_at, completed_at, attempts)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now(), CASE WHEN $3 = 'complete' THEN now() ELSE NULL END, 1)
     ON CONFLICT (run_id, source_kind) DO UPDATE SET
       state = EXCLUDED.state,
       source_fingerprint = EXCLUDED.source_fingerprint,
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
      input.importedCount,
      input.error ? JSON.stringify(input.error) : null,
    ],
  );
}

async function importRun(input: {
  client: Client;
  run: LegacyRun;
  root: string;
  allowMissing: boolean;
}): Promise<{ runId: string; eventCount: number; costCount: number; alreadyComplete: boolean }> {
  if (!input.run.ownerSlug) {
    throw new Error(`run ${input.run.id} has no project or local-package owner slug`);
  }

  const eventsPath = runtimeFilePath({
    root: input.root,
    ownerSlug: input.run.ownerSlug,
    runId: input.run.id,
    name: "run.events.jsonl",
  });
  const costPath = runtimeFilePath({
    root: input.root,
    ownerSlug: input.run.ownerSlug,
    runId: input.run.id,
    name: "cost.jsonl",
  });
  const [eventsFile, costFile] = await Promise.all([
    readOptionalFile(eventsPath),
    readOptionalFile(costPath),
  ]);

  if (!eventsFile.found && !input.allowMissing) {
    throw new Error(
      `run ${input.run.id} has no legacy event file at ${eventsPath}; rerun with ${ALLOW_EMPTY_FLAG} only after independently proving that this run produced no runtime data`,
    );
  }

  const events = eventsFile.found
    ? nonEmptyLines(eventsFile.contents).map((line, index) => {
        const parsed = parseJsonLine(
          line,
          `run ${input.run.id} event line ${index + 1}`,
        );
        if (typeof parsed.type !== "string" || parsed.type.length === 0) {
          throw new Error(`run ${input.run.id} event line ${index + 1} has no type`);
        }
        return parsed as LegacyEvent;
      })
    : [];
  const costs = costFile.found
    ? nonEmptyLines(costFile.contents).map((line, index) =>
        parseJsonLine(line, `run ${input.run.id} cost line ${index + 1}`),
      )
    : [];

  await input.client.query("BEGIN");
  try {
    const lockedRun = await input.client.query<{ next_execution_event_sequence: string }>(
      "SELECT next_execution_event_sequence FROM runs WHERE id = $1 FOR UPDATE",
      [input.run.id],
    );
    if (!lockedRun.rows[0]) throw new Error(`run ${input.run.id} disappeared during import`);

    const fileArtifacts = await input.client.query<{ id: string }>(
      `SELECT id FROM artifact_instances
       WHERE run_id = $1 AND locator->>'kind' = 'file'
       LIMIT 1`,
      [input.run.id],
    );
    if (fileArtifacts.rows[0]) {
      throw new Error(
        `run ${input.run.id} has file-backed artifact ${fileArtifacts.rows[0].id}; migrate its payload to an execution object before the Stage B cutover`,
      );
    }

    const attempts = await input.client.query<NodeAttempt>(
      "SELECT id, acp_session_id AS \"acpSessionId\" FROM node_attempts WHERE run_id = $1",
      [input.run.id],
    );
    const attemptIdBySession = new Map(
      attempts.rows
        .filter((attempt) => attempt.acpSessionId)
        .map((attempt) => [attempt.acpSessionId as string, attempt.id] as const),
    );
    let sequence = BigInt(lockedRun.rows[0].next_execution_event_sequence);
    const eventFingerprint = eventsFile.found
      ? sha256(eventsFile.contents)
      : "explicitly-acknowledged-empty";
    const costFingerprint = costFile.found ? sha256(costFile.contents) : "missing-cost-file";

    const priorImports = await input.client.query<{
      sourceKind: string;
      state: string;
      fingerprint: string | null;
    }>(
      `SELECT source_kind AS "sourceKind", state, source_fingerprint AS fingerprint
       FROM execution_data_plane_imports
       WHERE run_id = $1
       FOR UPDATE`,
      [input.run.id],
    );
    const completeKinds = new Set(
      priorImports.rows
        .filter((row) => row.state === "complete")
        .map((row) => row.sourceKind),
    );
    if (completeKinds.size === 5) {
      const priorEvents = priorImports.rows.find((row) => row.sourceKind === "events");
      const priorCost = priorImports.rows.find((row) => row.sourceKind === "cost");
      if (
        priorEvents?.fingerprint !== eventFingerprint ||
        priorCost?.fingerprint !== costFingerprint
      ) {
        throw new Error(
          `run ${input.run.id} was already preserved with a different legacy data fingerprint; investigate the runtime mount before retrying`,
        );
      }
      await input.client.query("COMMIT");
      return {
        runId: input.run.id,
        eventCount: events.length,
        costCount: costs.length,
        alreadyComplete: true,
      };
    }

    for (const [index, event] of events.entries()) {
      const payload = eventPayload(event, attemptIdBySession);
      await input.client.query(
        `INSERT INTO execution_events
          (id, source, source_key, run_id, event_type, payload_schema, payload, occurred_at, received_at, run_sequence, ingest_disposition)
         VALUES ($1, 'legacy_import', $2, $3, $4, $5, $6::jsonb, $7, now(), $8, 'accepted')
         ON CONFLICT DO NOTHING`,
        [
          randomUUID(),
          `legacy-events:${eventFingerprint}:${index}`,
          input.run.id,
          event.type,
          schemaForLegacyEvent(event, `run ${input.run.id} event line ${index + 1}`),
          JSON.stringify(payload),
          occurredAt(event),
          sequence.toString(),
        ],
      );
      sequence += 1n;
    }

    for (const [index, cost] of costs.entries()) {
      await input.client.query(
        `INSERT INTO execution_events
          (id, source, source_key, run_id, event_type, payload_schema, payload, occurred_at, received_at, run_sequence, ingest_disposition)
         VALUES ($1, 'legacy_import', $2, $3, 'usage.recorded', 'maister.usage.recorded.v1', $4::jsonb, $5, now(), $6, 'accepted')
         ON CONFLICT DO NOTHING`,
        [
          randomUUID(),
          `legacy-cost:${costFingerprint}:${index}`,
          input.run.id,
          JSON.stringify(canonicalUsagePayload(cost)),
          occurredAt(cost),
          sequence.toString(),
        ],
      );
      sequence += 1n;
    }

    await input.client.query(
      "UPDATE runs SET next_execution_event_sequence = $2 WHERE id = $1",
      [input.run.id, sequence.toString()],
    );
    await upsertImportState({
      client: input.client,
      runId: input.run.id,
      sourceKind: "events",
      state: "complete",
      fingerprint: eventFingerprint,
      importedCount: events.length,
      error: null,
    });
    await upsertImportState({
      client: input.client,
      runId: input.run.id,
      sourceKind: "transcript",
      state: "complete",
      fingerprint: eventFingerprint,
      importedCount: events.length,
      error: null,
    });
    await upsertImportState({
      client: input.client,
      runId: input.run.id,
      sourceKind: "cost",
      state: "complete",
      fingerprint: costFingerprint,
      importedCount: costs.length,
      error: null,
    });
    await upsertImportState({
      client: input.client,
      runId: input.run.id,
      sourceKind: "runtime_objects",
      state: "complete",
      fingerprint: "no-file-artifacts",
      importedCount: 0,
      error: null,
    });
    await upsertImportState({
      client: input.client,
      runId: input.run.id,
      sourceKind: "scratch_session",
      state: "complete",
      fingerprint: "run_sessions-canonical",
      importedCount: 0,
      error: null,
    });
    await input.client.query("COMMIT");
    return {
      runId: input.run.id,
      eventCount: events.length,
      costCount: costs.length,
      alreadyComplete: false,
    };
  } catch (error) {
    await input.client.query("ROLLBACK");
    throw error;
  }
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: requiredEnv("DB_URL") });
  const root = requiredEnv("MAISTER_LEGACY_RUNTIME_ROOT");
  const allowMissing = process.argv.includes(ALLOW_EMPTY_FLAG);

  await client.connect();
  try {
    const runs = await client.query<LegacyRun>(
      `SELECT r.id, coalesce(p.slug, lp.slug) AS "ownerSlug"
       FROM runs r
       LEFT JOIN projects p ON p.id = r.project_id
       LEFT JOIN local_packages lp ON lp.id = r.local_package_id
       WHERE r.execution_data_plane_mode = 'legacy_file_v1'
       ORDER BY r.id ASC`,
    );
    const failures: string[] = [];

    for (const run of runs.rows) {
      try {
        const summary = await importRun({
          client,
          run,
          root,
          allowMissing,
        });
        console.info(
          JSON.stringify({
            event: "legacy_execution_data_imported",
            ...summary,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${run.id}: ${message}`);
        console.error(
          JSON.stringify({
            event: "legacy_execution_data_import_failed",
            runId: run.id,
            error: message,
          }),
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(`legacy data import failed:\n${failures.join("\n")}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
