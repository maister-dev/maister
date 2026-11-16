import type { Pool } from "pg";
import type { TerminalCause } from "@/lib/domain-events/taxonomy";

import { register } from "node:module";
import { stripVTControlCharacters } from "node:util";

import { z } from "zod";

import {
  parseTerminalCause,
  terminalCauseReason,
} from "@/lib/domain-events/taxonomy";
import { isMaisterErrorCode } from "@/lib/errors-core";
import { isTokenScope, type TokenScope } from "@/types/token-scopes";

const OUTPUT_BYTES = 4096;
const ROW_LIMIT = 100;
const tree = `WITH RECURSIVE tree AS (
  SELECT id,0 AS depth FROM runs WHERE id=ANY($1::text[]) AND project_id=$2
  UNION ALL SELECT r.id,t.depth+1 FROM runs r JOIN tree t ON r.parent_run_id=t.id
    WHERE t.depth<3 AND r.project_id=$2
), owned_runs AS (SELECT DISTINCT id FROM tree)`;
const optionalText = z.string().nullable();
const optionalInteger = z.number().int().nullable();
const timestamp = z.string().datetime({ offset: true });
const actionSchema = z.object({
  commandId: optionalText,
  promptOrdinal: optionalInteger,
  ok: z.boolean().nullable(),
  errorCode: optionalText,
  exitCode: optionalInteger,
  reason: optionalText,
});
const attemptSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  nodeType: z.string(),
  attempt: z.number().int(),
  status: z.string(),
  startedAt: timestamp,
  endedAt: timestamp.nullable(),
  errorCode: optionalText,
  exitCode: optionalInteger,
  actionCompletion: actionSchema.nullable(),
  failedOutput: optionalText,
  total: z.number().int(),
});
const eventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  kind: z.string(),
  occurredAt: timestamp,
  cause: z.unknown(),
  total: z.number().int(),
});
const commandSchema = z.object({
  id: z.string(),
  runId: z.string(),
  kind: z.string(),
  state: z.string(),
  transportState: z.string(),
  applicationState: z.string(),
  applicationAttempts: z.number().int(),
  createdAt: timestamp,
  updatedAt: timestamp,
  acceptedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  completionAppliedAt: timestamp.nullable(),
  applicationNextRetryAt: timestamp.nullable(),
  code: optionalText,
  reason: optionalText,
  errorMessage: optionalText,
  terminationStage: z.enum(["process_exit", "terminal_output"]).nullable(),
  applicationReason: optionalText,
  applicationCauseCode: optionalText,
  applicationCauseReason: optionalText,
  applicationPhase: optionalText,
  applicationClassification: optionalText,
  total: z.number().int(),
});
const tokenSchema = z.object({
  tokenId: z.string(),
  tokenKind: z.enum(["project", "user", "agent", "librarian"]),
  originKind: z.enum(["orchestrator_run", "agent_run"]).nullable(),
  boundRunId: z.string(),
  nodeAttemptId: optionalText,
  issuedAt: timestamp,
  lastUsedAt: timestamp.nullable(),
  expiresAt: timestamp.nullable(),
  revokedAt: timestamp.nullable(),
  revocationReason: z.enum(["rotation", "revoked"]).nullable(),
  total: z.number().int(),
});
const tokenAuditSchema = z.object({
  id: z.string(),
  tokenId: z.string(),
  scopeUsed: z.string(),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  result: z.enum(["ok", "error"]),
  statusCode: z.number().int().min(100).max(599),
  createdAt: timestamp,
  total: z.number().int(),
});

type DiagnosticScope = Readonly<{
  projectId: string;
  repoPath: string;
  hostPaths: readonly string[];
  secretValues: readonly string[];
}>;

type SanitizedOutput = Readonly<{
  text: string;
  originalBytes: number;
  sanitizedBytes: number;
  capturedBytes: number;
  truncated: boolean;
  controlsRemoved: number;
  redactions: number;
  kinds: readonly string[];
}>;
export type NativeQualificationDiagnostics = Readonly<{
  schemaVersion: 1;
  classification: "owned_synthetic_qualification_only";
  capturedAt: string;
  rowLimit: number;
  treeDepthLimit: number;
  failedOutputMaxBytes: number;
  totals: Readonly<{
    attempts: number;
    events: number;
    commands: number;
    tokens: number;
    tokenAudit: number;
  }>;
  attempts: readonly (Omit<
    z.infer<typeof attemptSchema>,
    "failedOutput" | "total"
  > & {
    failedOutput: SanitizedOutput | null;
  })[];
  events: readonly (Omit<z.infer<typeof eventSchema>, "cause" | "total"> & {
    cause: TerminalCause | null;
  })[];
  commands: readonly (Omit<
    z.infer<typeof commandSchema>,
    "total" | "errorMessage"
  > & { errorMessage: SanitizedOutput | null })[];
  tokens: readonly Omit<z.infer<typeof tokenSchema>, "total">[];
  tokenAudit: readonly (Omit<
    z.infer<typeof tokenAuditSchema>,
    "scopeUsed" | "total"
  > & {
    scopeUsed: TokenScope | null;
  })[];
}>;

function maskLiteralSecrets(
  text: string,
  values: readonly string[],
): { text: string; redactions: number } {
  return [...new Set(values.map(stripVTControlCharacters))]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)
    .reduce(
      (current, value) => {
        const parts = current.text.split(value);

        return {
          text: parts.join("[REDACTED_SECRET]"),
          redactions: current.redactions + parts.length - 1,
        };
      },
      { text, redactions: 0 },
    );
}

function safeReason(
  value: string | null,
  secrets: readonly string[],
): string | null {
  return value === null
    ? null
    : (terminalCauseReason(maskLiteralSecrets(value, secrets).text) ?? null);
}

function normalizedCause(
  value: unknown,
  secrets: readonly string[],
): TerminalCause | null {
  const cause = parseTerminalCause(value);

  if (cause === null) return null;
  const reason = safeReason(cause.reason ?? null, secrets);

  return {
    code: cause.code,
    source: cause.source,
    ...(reason === null ? {} : { reason }),
  };
}

function safeCode(
  value: string | null,
  secrets: readonly string[],
): string | null {
  if (value === null) return null;
  const text = maskLiteralSecrets(value, secrets).text;

  return isMaisterErrorCode(text) || /^[A-Z][A-Z0-9_]{0,63}$/.test(text)
    ? text
    : safeReason(text, secrets);
}

async function sanitizedOutput(
  raw: string,
  scope: DiagnosticScope,
): Promise<SanitizedOutput> {
  register(
    new URL("../../scripts/_server-only-shim.mjs", import.meta.url),
    import.meta.url,
  );
  const { redactEvidenceText } =
    await import("@/lib/evaluations/evidence/capture");
  const controlsStripped = stripVTControlCharacters(raw);
  const literals = maskLiteralSecrets(controlsStripped, scope.secretValues);
  const redacted = redactEvidenceText(literals.text, {
    hostPaths: [...scope.hostPaths, scope.repoPath],
  });
  const bytes = Buffer.from(redacted.text, "utf8");
  let start = Math.max(0, bytes.length - OUTPUT_BYTES);

  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  const captured = bytes.subarray(start);

  return {
    text: captured.toString("utf8"),
    originalBytes: Buffer.byteLength(raw, "utf8"),
    sanitizedBytes: bytes.length,
    capturedBytes: captured.length,
    truncated: start > 0,
    controlsRemoved: raw.length - controlsStripped.length,
    redactions: literals.redactions + redacted.redactions,
    kinds: [
      ...new Set([
        ...redacted.kinds,
        ...(literals.redactions > 0 ? ["known_secret_value"] : []),
      ]),
    ].sort(),
  };
}

export function qualificationSecretValues(
  environment: NodeJS.ProcessEnv,
): string[] {
  return Object.entries(environment)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIAL|^DB_URL$|^DATABASE_URL$)/i.test(
          key,
        ),
    )
    .flatMap(([, value]) => (value === undefined ? [] : [value]));
}

/** Only the fresh, repository-scoped synthetic live lane may disclose a failed-node tail. */
export async function captureNativeQualificationDiagnostics(
  pool: Pool,
  runIds: readonly string[],
  scope: DiagnosticScope,
): Promise<NativeQualificationDiagnostics> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const identity = z
      .object({
        database: z.string(),
        repoPath: z.string(),
        capturedAt: timestamp,
      })
      .parse(
        (
          await client.query(
            `SELECT current_database() AS database,repo_path AS "repoPath",to_jsonb(clock_timestamp())#>>'{}' AS "capturedAt" FROM projects WHERE id=$1`,
            [scope.projectId],
          )
        ).rows[0],
      );

    if (
      identity.database !== "maister_e2e" ||
      identity.repoPath !== scope.repoPath
    )
      throw new Error(
        "Qualification diagnostic output requires the owned synthetic database and exact fixture repository",
      );
    const foreignRoots = await client.query(
      "SELECT id FROM runs WHERE id=ANY($1::text[]) AND project_id IS DISTINCT FROM $2 LIMIT 1",
      [runIds, scope.projectId],
    );

    if (foreignRoots.rows.length > 0)
      throw new Error("Qualification diagnostics cannot read a foreign root");
    const params = [runIds, scope.projectId];
    const attempts = z.array(attemptSchema).parse(
      (
        await client.query(
          `${tree}
      SELECT n.id,n.run_id AS "runId",n.node_id AS "nodeId",n.node_type AS "nodeType",n.attempt,n.status,
        to_jsonb(n.started_at)#>>'{}' AS "startedAt",to_jsonb(n.ended_at)#>>'{}' AS "endedAt",
        n.error_code AS "errorCode",n.exit_code AS "exitCode",
        CASE WHEN n.action_completion IS NULL THEN NULL ELSE jsonb_build_object(
          'commandId',n.action_completion->'commandId','promptOrdinal',n.action_completion->'promptOrdinal',
          'ok',n.action_completion->'result'->'ok','errorCode',n.action_completion->'result'->'errorCode',
          'exitCode',n.action_completion->'result'->'exitCode','reason',n.action_completion->'result'->'reason') END AS "actionCompletion",
        CASE WHEN n.status='Failed' THEN coalesce(nullif(n.stdout,''),n.action_completion->'result'->>'stdout') ELSE NULL END AS "failedOutput",
        count(*) OVER()::int AS total
      FROM node_attempts n JOIN owned_runs t ON t.id=n.run_id
      ORDER BY n.started_at,n.id LIMIT ${ROW_LIMIT}`,
          params,
        )
      ).rows,
    );
    const events = z.array(eventSchema).parse(
      (
        await client.query(
          `${tree}
      SELECT e.id::text,e.run_id AS "runId",e.kind,to_jsonb(e.occurred_at)#>>'{}' AS "occurredAt",
        e.payload->'cause' AS cause,count(*) OVER()::int AS total
      FROM domain_events e JOIN owned_runs t ON t.id=e.run_id
      WHERE e.kind IN ('run.failed','run.crashed','run.abandoned','run.needs_input')
      ORDER BY e.occurred_at DESC,e.id DESC LIMIT ${ROW_LIMIT}`,
          params,
        )
      ).rows,
    );
    const commands = z.array(commandSchema).parse(
      (
        await client.query(
          `${tree}
      SELECT c.id,c.run_id AS "runId",c.kind,c.state,c.transport_state AS "transportState",
        c.application_state AS "applicationState",c.application_attempts AS "applicationAttempts",
        to_jsonb(c.created_at)#>>'{}' AS "createdAt",to_jsonb(c.updated_at)#>>'{}' AS "updatedAt",
        to_jsonb(c.accepted_at)#>>'{}' AS "acceptedAt",to_jsonb(c.completed_at)#>>'{}' AS "completedAt",
        to_jsonb(c.completion_applied_at)#>>'{}' AS "completionAppliedAt",
        to_jsonb(c.application_next_retry_at)#>>'{}' AS "applicationNextRetryAt",
        c.last_error->>'code' AS code,coalesce(c.last_error->'details'->>'reason',c.last_error->>'reason') AS reason,
        c.last_error->>'message' AS "errorMessage",
        CASE WHEN c.kind='session.delete' AND c.last_error->'details'->>'stage' IN ('process_exit','terminal_output')
          THEN c.last_error->'details'->>'stage' ELSE NULL END AS "terminationStage",
        c.application_error->>'reason' AS "applicationReason",c.application_error->>'causeCode' AS "applicationCauseCode",
        c.application_error->>'causeReason' AS "applicationCauseReason",c.application_error->>'phase' AS "applicationPhase",
        c.application_error->>'classification' AS "applicationClassification",count(*) OVER()::int AS total
      FROM execution_commands c JOIN owned_runs t ON t.id=c.run_id
      ORDER BY c.created_at DESC,c.id DESC LIMIT ${ROW_LIMIT}`,
          params,
        )
      ).rows,
    );
    const tokens = z.array(tokenSchema).parse(
      (
        await client.query(
          `${tree}
      SELECT p.id AS "tokenId",p.token_kind AS "tokenKind",p.origin_kind AS "originKind",
        p.bound_run_id AS "boundRunId",p.knowledge_node_attempt_id AS "nodeAttemptId",
        to_jsonb(p.created_at)#>>'{}' AS "issuedAt",to_jsonb(p.last_used_at)#>>'{}' AS "lastUsedAt",
        to_jsonb(p.expires_at)#>>'{}' AS "expiresAt",to_jsonb(p.revoked_at)#>>'{}' AS "revokedAt",
        p.revocation_reason AS "revocationReason",count(*) OVER()::int AS total
      FROM project_tokens p JOIN owned_runs t ON t.id=p.bound_run_id WHERE p.project_id=$2
      ORDER BY p.created_at DESC,p.id DESC LIMIT ${ROW_LIMIT}`,
          params,
        )
      ).rows,
    );
    const tokenAudit = z.array(tokenAuditSchema).parse(
      (
        await client.query(
          `${tree}
      SELECT a.id,a.token_id AS "tokenId",a.scope_used AS "scopeUsed",a.method,a.result,
        a.status_code AS "statusCode",to_jsonb(a.created_at)#>>'{}' AS "createdAt",count(*) OVER()::int AS total
      FROM token_audit_log a JOIN project_tokens p ON p.id=a.token_id
        JOIN owned_runs t ON t.id=p.bound_run_id WHERE p.project_id=$2
      ORDER BY a.created_at DESC,a.id DESC LIMIT ${ROW_LIMIT}`,
          params,
        )
      ).rows,
    );

    await client.query("COMMIT");

    return {
      schemaVersion: 1,
      classification: "owned_synthetic_qualification_only",
      capturedAt: identity.capturedAt,
      rowLimit: ROW_LIMIT,
      treeDepthLimit: 3,
      failedOutputMaxBytes: OUTPUT_BYTES,
      totals: {
        attempts: attempts[0]?.total ?? 0,
        events: events[0]?.total ?? 0,
        commands: commands[0]?.total ?? 0,
        tokens: tokens[0]?.total ?? 0,
        tokenAudit: tokenAudit[0]?.total ?? 0,
      },
      attempts: await Promise.all(
        attempts.map(async ({ failedOutput, total: _total, ...attempt }) => ({
          ...attempt,
          errorCode: safeCode(attempt.errorCode, scope.secretValues),
          actionCompletion:
            attempt.actionCompletion === null
              ? null
              : {
                  ...attempt.actionCompletion,
                  errorCode: safeCode(
                    attempt.actionCompletion.errorCode,
                    scope.secretValues,
                  ),
                  reason: safeReason(
                    attempt.actionCompletion.reason,
                    scope.secretValues,
                  ),
                },
          failedOutput:
            failedOutput === null
              ? null
              : await sanitizedOutput(failedOutput, scope),
        })),
      ),
      events: events.map(({ total: _total, ...event }) => ({
        ...event,
        cause: normalizedCause(event.cause, scope.secretValues),
      })),
      commands: await Promise.all(
        commands.map(async ({ total: _total, errorMessage, ...command }) => ({
          ...command,
          errorMessage:
            errorMessage === null
              ? null
              : await sanitizedOutput(errorMessage, scope),
          code: safeCode(command.code, scope.secretValues),
          reason: safeReason(command.reason, scope.secretValues),
          applicationReason: safeReason(
            command.applicationReason,
            scope.secretValues,
          ),
          applicationCauseCode: safeCode(
            command.applicationCauseCode,
            scope.secretValues,
          ),
          applicationCauseReason: safeReason(
            command.applicationCauseReason,
            scope.secretValues,
          ),
          applicationPhase: safeReason(
            command.applicationPhase,
            scope.secretValues,
          ),
          applicationClassification: safeReason(
            command.applicationClassification,
            scope.secretValues,
          ),
        })),
      ),
      tokens: tokens.map(({ total: _total, ...token }) => token),
      tokenAudit: tokenAudit.map(({ total: _total, ...audit }) => ({
        ...audit,
        scopeUsed: isTokenScope(audit.scopeUsed) ? audit.scopeUsed : null,
      })),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
