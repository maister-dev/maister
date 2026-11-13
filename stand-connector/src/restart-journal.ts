import { DatabaseSync } from "node:sqlite";

type ServiceState = "active" | "inactive" | "failed" | "unknown";
type RestartPhase =
  | "intent_retained"
  | "effect_started"
  | "confirmed_applied"
  | "confirmed_not_applied"
  | "unknown";
type JournalFailure =
  | "authority_expired"
  | "journal_corrupt"
  | "operation_conflict"
  | "resource_conflict"
  | "stale_owner"
  | "target_identity_mismatch";
type ReceiptReason =
  "authority_refused" | "before_state_changed" | "effect_unknown";

export type RestartIntent = Readonly<{
  operationId: string;
  targetIncarnation: string;
  resourceKey: string;
  requestDigest: string;
  ownerEpoch: number;
}>;
export type ServiceObservation = Readonly<{
  invocationId: string | null;
  state: ServiceState;
}>;
export type RestartPermit = Readonly<{ permitId: string; expiresAt: string }>;
export type RestartResult =
  | Readonly<{ acknowledgement: "received"; after: ServiceObservation }>
  | Readonly<{
      acknowledgement: "uncertain";
      after: ServiceObservation | null;
    }>;
export type RestartEntry = RestartIntent &
  Readonly<{
    revision: number;
    sequence: number;
    capturedAt: string;
    phase: RestartPhase;
    before: ServiceObservation;
    permitId: string | null;
    after: ServiceObservation | null;
    reason: ReceiptReason | null;
  }>;

export type RestartJournal = Readonly<{
  read(operationId: string): RestartEntry | null;
  admit(
    intent: RestartIntent,
    before: ServiceObservation,
  ): {
    created: boolean;
    entry: RestartEntry;
  };
  consumePermit(intent: RestartIntent, permit: RestartPermit): RestartEntry;
  refuse(
    intent: RestartIntent,
    reason: Exclude<ReceiptReason, "effect_unknown">,
  ): RestartEntry;
  finish(intent: RestartIntent, result: RestartResult): RestartEntry;
  beginVerification(operationId: string, nonce: string): number;
  close(): void;
}>;

export class RestartJournalError extends Error {
  readonly reason: JournalFailure;

  constructor(reason: JournalFailure) {
    super(reason);
    this.reason = reason;
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS journal_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton=1),
    target_incarnation TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence BETWEEN 0 AND 9007199254740991)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS restart_operations (
    id TEXT PRIMARY KEY,
    resource_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    owner_epoch INTEGER NOT NULL CHECK (owner_epoch BETWEEN 1 AND 9007199254740991),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 3),
    sequence INTEGER NOT NULL UNIQUE CHECK (sequence BETWEEN 1 AND 9007199254740991),
    captured_at TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (
      phase IN ('intent_retained','effect_started','confirmed_applied','confirmed_not_applied','unknown')
    ),
    before_invocation TEXT,
    before_state TEXT NOT NULL CHECK (before_state IN ('active','inactive','failed','unknown')),
    permit_id TEXT UNIQUE,
    after_invocation TEXT,
    after_state TEXT CHECK (after_state IN ('active','inactive','failed','unknown')),
    reason TEXT CHECK (reason IN ('authority_refused','before_state_changed','effect_unknown')),
    UNIQUE(resource_key,owner_epoch),
    CHECK (
      (phase='intent_retained' AND revision=1 AND permit_id IS NULL AND reason IS NULL)
      OR (phase='effect_started' AND revision=2 AND permit_id IS NOT NULL AND reason IS NULL)
      OR (phase='confirmed_not_applied' AND revision=2 AND permit_id IS NULL AND reason IS NOT NULL)
      OR (phase='confirmed_applied' AND revision=3 AND permit_id IS NOT NULL AND after_state='active' AND after_invocation IS NOT NULL AND reason IS NULL)
      OR (phase='unknown' AND revision=3 AND permit_id IS NOT NULL AND reason='effect_unknown')
    )
  ) STRICT;
`;
const VERIFICATION_SCHEMA = `
  CREATE TABLE verification_nonces (
    operation_id TEXT NOT NULL REFERENCES restart_operations(id) ON DELETE RESTRICT,
    nonce TEXT NOT NULL,
    sequence INTEGER NOT NULL UNIQUE,
    PRIMARY KEY(operation_id,nonce)
  ) STRICT;
`;

function inTransaction<T>(db: DatabaseSync, write: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = write();

    db.exec("COMMIT");

    return value;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

type JournalRow = Readonly<{
  id: string;
  resource_key: string;
  request_digest: string;
  owner_epoch: number;
  revision: number;
  sequence: number;
  captured_at: string;
  phase: RestartPhase;
  before_invocation: string | null;
  before_state: ServiceState;
  permit_id: string | null;
  after_invocation: string | null;
  after_state: ServiceState | null;
  reason: ReceiptReason | null;
}>;

function entryFromRow(
  row: JournalRow,
  targetIncarnation: string,
): RestartEntry {
  return {
    operationId: row.id,
    targetIncarnation,
    resourceKey: row.resource_key,
    requestDigest: row.request_digest,
    ownerEpoch: row.owner_epoch,
    revision: row.revision,
    sequence: row.sequence,
    capturedAt: row.captured_at,
    phase: row.phase,
    before: { invocationId: row.before_invocation, state: row.before_state },
    permitId: row.permit_id,
    after:
      row.after_state === null
        ? null
        : { invocationId: row.after_invocation, state: row.after_state },
    reason: row.reason,
  };
}

function assertSameIntent(current: RestartEntry, intent: RestartIntent): void {
  if (
    current.requestDigest !== intent.requestDigest ||
    current.resourceKey !== intent.resourceKey ||
    current.ownerEpoch !== intent.ownerEpoch
  )
    throw new RestartJournalError("operation_conflict");
}

function initialize(
  db: DatabaseSync,
  targetIncarnation: string,
  pageLimit: number,
): void {
  const mode = db.prepare("PRAGMA journal_mode=DELETE").get();

  if (mode?.journal_mode !== "delete")
    throw new RestartJournalError("journal_corrupt");
  db.exec("PRAGMA synchronous=FULL");
  db.exec("PRAGMA foreign_keys=ON");
  const pageSize = db.prepare("PRAGMA page_size").get()?.page_size;
  const limit = db.prepare(`PRAGMA max_page_count=${pageLimit}`).get();
  const integrity = db.prepare("PRAGMA quick_check(1)").get();

  if (
    pageSize !== 4096 ||
    limit?.max_page_count !== pageLimit ||
    integrity?.quick_check !== "ok"
  )
    throw new RestartJournalError("journal_corrupt");

  inTransaction(db, () => {
    const version = db.prepare("PRAGMA user_version").get()?.user_version;

    if (version === 0) {
      const tables = db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
        .all();

      if (tables.length !== 0) throw new RestartJournalError("journal_corrupt");
      db.exec(SCHEMA);
      db.prepare("INSERT INTO journal_identity VALUES (1,?,0)").run(
        targetIncarnation,
      );
      db.exec("PRAGMA user_version=1");
    } else if (version !== 1 && version !== 2) {
      throw new RestartJournalError("journal_corrupt");
    }
    const identity = db
      .prepare(
        "SELECT target_incarnation FROM journal_identity WHERE singleton=1",
      )
      .get();

    if (identity?.target_incarnation !== targetIncarnation)
      throw new RestartJournalError("target_identity_mismatch");
    if (version !== 2) {
      db.exec(VERIFICATION_SCHEMA);
      db.exec("PRAGMA user_version=2");
    }
  });
}

/** Full synchronous SQLite commits provide atomic cross-process admission on a single local journal. */
export function openRestartJournal(
  path: string,
  targetIncarnation: string,
  pageLimit: number,
): RestartJournal {
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 16 || pageLimit > 65_536)
    throw new RangeError(
      "Stand journal page limit is outside the supported range",
    );

  const db = new DatabaseSync(path, { timeout: 1000 });

  try {
    initialize(db, targetIncarnation, pageLimit);
  } catch (error) {
    db.close();
    throw error;
  }

  const readStatement = db.prepare(
    "SELECT * FROM restart_operations WHERE id=?",
  );
  const latestStatement = db.prepare(
    "SELECT * FROM restart_operations WHERE resource_key=? ORDER BY owner_epoch DESC LIMIT 1",
  );
  const advanceSequence = db.prepare(
    "UPDATE journal_identity SET sequence=sequence+1 WHERE singleton=1 RETURNING sequence",
  );
  const insert = db.prepare(`
    INSERT INTO restart_operations
      (id,resource_key,request_digest,owner_epoch,revision,sequence,captured_at,phase,before_invocation,before_state)
    VALUES (?,?,?,?,1,?,?,'intent_retained',?,?)
  `);
  const consume = db.prepare(`
    UPDATE restart_operations SET phase='effect_started',permit_id=?,revision=2,sequence=?,captured_at=?
    WHERE id=?
  `);
  const refuse = db.prepare(`
    UPDATE restart_operations SET phase='confirmed_not_applied',reason=?,revision=2,sequence=?,captured_at=?
    WHERE id=?
  `);
  const finish = db.prepare(`
    UPDATE restart_operations SET phase=?,after_invocation=?,after_state=?,reason=?,revision=3,sequence=?,captured_at=?
    WHERE id=?
  `);
  const findVerification = db.prepare(
    "SELECT 1 FROM verification_nonces WHERE operation_id=? AND nonce=?",
  );
  const retainVerification = db.prepare(
    "INSERT INTO verification_nonces VALUES (?,?,?)",
  );

  function read(operationId: string): RestartEntry | null {
    const row = readStatement.get(operationId) as JournalRow | undefined;

    return row ? entryFromRow(row, targetIncarnation) : null;
  }

  function retained(operationId: string): RestartEntry {
    const current = read(operationId);

    if (!current) throw new RestartJournalError("operation_conflict");

    return current;
  }

  function assertTarget(intent: RestartIntent): void {
    if (intent.targetIncarnation !== targetIncarnation)
      throw new RestartJournalError("target_identity_mismatch");
  }

  function atPhase(intent: RestartIntent, phase: RestartPhase): RestartEntry {
    assertTarget(intent);
    const current = retained(intent.operationId);

    assertSameIntent(current, intent);
    if (current.phase !== phase)
      throw new RestartJournalError("operation_conflict");

    return current;
  }

  function sequence(): number {
    const value = advanceSequence.get()?.sequence;

    if (typeof value !== "number" || !Number.isSafeInteger(value))
      throw new RestartJournalError("journal_corrupt");

    return value;
  }

  return {
    read,
    close: (): void => db.close(),
    beginVerification(operationId: string, nonce: string): number {
      return inTransaction(db, () => {
        const current = retained(operationId);

        if (
          current.phase !== "confirmed_applied" ||
          findVerification.get(operationId, nonce)
        )
          throw new RestartJournalError("operation_conflict");
        const value = sequence();

        retainVerification.run(operationId, nonce, value);

        return value;
      });
    },
    admit(
      intent: RestartIntent,
      before: ServiceObservation,
    ): { created: boolean; entry: RestartEntry } {
      assertTarget(intent);

      return inTransaction(db, () => {
        const existing = read(intent.operationId);

        if (existing) {
          assertSameIntent(existing, intent);
          if (
            existing.before.invocationId !== before.invocationId ||
            existing.before.state !== before.state
          )
            throw new RestartJournalError("operation_conflict");

          return { created: false, entry: existing };
        }
        const latest = latestStatement.get(intent.resourceKey) as
          JournalRow | undefined;

        if (latest && latest.owner_epoch >= intent.ownerEpoch)
          throw new RestartJournalError("stale_owner");
        if (
          latest &&
          latest.phase !== "confirmed_not_applied" &&
          latest.phase !== "confirmed_applied"
        )
          throw new RestartJournalError("resource_conflict");

        insert.run(
          intent.operationId,
          intent.resourceKey,
          intent.requestDigest,
          intent.ownerEpoch,
          sequence(),
          new Date().toISOString(),
          before.invocationId,
          before.state,
        );

        return { created: true, entry: retained(intent.operationId) };
      });
    },
    consumePermit(intent: RestartIntent, permit: RestartPermit): RestartEntry {
      return inTransaction(db, () => {
        atPhase(intent, "intent_retained");
        const now = new Date();

        if (!(Date.parse(permit.expiresAt) > now.getTime()))
          throw new RestartJournalError("authority_expired");
        consume.run(
          permit.permitId,
          sequence(),
          now.toISOString(),
          intent.operationId,
        );

        return retained(intent.operationId);
      });
    },
    refuse(
      intent: RestartIntent,
      reason: Exclude<ReceiptReason, "effect_unknown">,
    ): RestartEntry {
      return inTransaction(db, () => {
        atPhase(intent, "intent_retained");
        refuse.run(
          reason,
          sequence(),
          new Date().toISOString(),
          intent.operationId,
        );

        return retained(intent.operationId);
      });
    },
    finish(intent: RestartIntent, result: RestartResult): RestartEntry {
      return inTransaction(db, () => {
        const current = atPhase(intent, "effect_started");
        const { after } = result;
        const applied =
          result.acknowledgement === "received" &&
          after?.state === "active" &&
          after.invocationId !== null &&
          after.invocationId !== current.before.invocationId;

        finish.run(
          applied ? "confirmed_applied" : "unknown",
          after?.invocationId ?? null,
          after?.state ?? null,
          applied ? null : "effect_unknown",
          sequence(),
          new Date().toISOString(),
          intent.operationId,
        );

        return retained(intent.operationId);
      });
    },
  };
}
