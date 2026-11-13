import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { readRunEvidence } from "@/lib/queries/evidence-graph";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "run_evidence_projection",
  });
}, 180_000);

afterAll(async () => database?.stop());

it("E1 keeps recorded outcomes, retained output, policy and provenance separate", async () => {
  const [
    projectId,
    runId,
    oldAttempt,
    latestAttempt,
    current,
    previous,
    required,
    oldGate,
    external,
  ] = Array.from({ length: 9 }, () => randomUUID());
  const pool = database.pool;

  await pool.query(
    "INSERT INTO projects(id,slug,name,task_key,repo_path) VALUES($1,$1,'Evidence','EV','/tmp/fixture')",
    [projectId],
  );
  await pool.query(
    "INSERT INTO runs(id,project_id,run_kind,status,flow_version) VALUES($1,$2,'flow','Failed','v1')",
    [runId, projectId],
  );
  await pool.query(
    "INSERT INTO node_attempts(id,run_id,node_id,node_type,attempt,status,started_at) VALUES ($1,$3,'verify','check',1,'Succeeded',now() - interval '1 minute'),($2,$3,'verify','check',2,'Failed',now())",
    [oldAttempt, latestAttempt, runId],
  );
  await pool.query(
    `INSERT INTO artifact_instances(id,run_id,node_attempt_id,artifact_def_id,kind,producer,locator,validity)
    VALUES ($1,$3,$4,'proof','plan','runner','{"kind":"inline","text":"private","partial":true}','current'),
           ($2,$3,$4,'proof','plan','runner','{"kind":"file","path":"/private/path"}','superseded')`,
    [current, previous, runId, oldAttempt],
  );
  await pool.query(
    `INSERT INTO gate_results(id,run_id,node_attempt_id,gate_id,kind,mode,status,input_artifact_refs,verdict)
    VALUES ($1,$4,$5,'evidence','artifact_required','blocking','failed','["proof"]',NULL),
           ($2,$4,$6,'external','external_check','blocking','passed',NULL,NULL),
           ($3,$4,$5,'external','external_check','blocking','stale',NULL,'{"commitSha":"0123456789012345678901234567890123456789","summary":"private"}')`,
    [required, oldGate, external, runId, latestAttempt, oldAttempt],
  );

  const result = await readRunEvidence(runId, database.db);

  expect(result).toMatchObject({
    results: {
      current: expect.arrayContaining([
        expect.objectContaining({
          id: `art:${current}`,
          state: "current",
          partial: true,
        }),
      ]),
      checks: expect.arrayContaining([
        expect.objectContaining({
          id: `gate:${required}`,
          state: "failed",
          blocking: false,
        }),
        expect.objectContaining({
          id: `gate:${external}`,
          state: "stale",
          source: "external",
          blocking: true,
        }),
      ]),
      previous: expect.arrayContaining([
        expect.objectContaining({ id: `art:${previous}`, state: "superseded" }),
        expect.objectContaining({ id: `gate:${oldGate}`, state: "passed" }),
        expect.objectContaining({ id: `na:${oldAttempt}`, state: "Succeeded" }),
      ]),
    },
  });
  expect(JSON.stringify(result)).not.toContain("private");
});
