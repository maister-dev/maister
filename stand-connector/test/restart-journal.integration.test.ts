import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { openRestartJournal, RestartJournalError } from "../src/restart-journal.ts";
import { createRestartService } from "../src/restart-service.ts";

const resourceKey = "a".repeat(64);
const targetIncarnation = randomUUID();
const first = {
  operationId: randomUUID(),
  targetIncarnation,
  resourceKey,
  requestDigest: "b".repeat(64),
  ownerEpoch: 1,
};
const before = { invocationId: "before", state: "active" } as const;

test("IT-CBO-03 refuses effects when the real journal is corrupt or full", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "maister-stand-capacity-"));
  const corruptPath = join(directory, "corrupt.sqlite");
  const path = join(directory, "full.sqlite");

  context.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(corruptPath, "invalid SQLite content");
  assert.throws(() => openRestartJournal(corruptPath, targetIncarnation, 16), {
    reason: "journal_corrupt",
  });

  const fresh = openRestartJournal(path, targetIncarnation, 16);
  fresh.close();
  const filler = new DatabaseSync(path);

  filler.exec("CREATE TABLE test_filler (padding BLOB)");
  filler.exec("PRAGMA max_page_count=16");
  const insert = filler.prepare(
    "INSERT INTO test_filler VALUES (zeroblob(4050))",
  );
  assert.throws(
    () => {
      for (let page = 0; page < 16; page++) insert.run();
    },
    { errcode: 13 },
  );
  filler.close();
  const journal = openRestartJournal(path, targetIncarnation, 16);
  context.after(() => journal.close());
  let effects = 0;
  const service = createRestartService(journal, {
    inspect: async () => before,
    authorize: async () => ({
      decision: "allowed",
      permit: {
        permitId: randomUUID(),
        expiresAt: new Date(Date.now() + 4900).toISOString(),
      },
    }),
    restart: async () => {
      effects++;
      return "received";
    },
  });
  let exhausted = false;

  for (let epoch = 1; epoch <= 128; epoch++) {
    const intent = { ...first, operationId: randomUUID(), ownerEpoch: epoch };

    try {
      journal.admit(intent, before);
      journal.refuse(intent, "authority_refused");
    } catch (error) {
      assert.ok(error instanceof RestartJournalError);
      assert.equal(error.reason, "journal_full");
      exhausted = true;
      break;
    }
  }
  assert.equal(exhausted, true);
  await assert.rejects(
    () =>
      service.execute(
        { ...first, operationId: randomUUID(), ownerEpoch: 129 },
        before,
      ),
    { reason: "journal_full" },
  );
  assert.equal(effects, 0);
});

test("IT-CBO-03 retains a permit and resource exclusion across journal connections and restart", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "maister-stand-journal-"));
  const path = join(directory, "state.sqlite");
  const one = openRestartJournal(path, targetIncarnation, 256);
  const two = openRestartJournal(path, targetIncarnation, 256);

  context.after(() => rmSync(directory, { recursive: true, force: true }));
  context.after(() => two.close());

  const permit = {
    permitId: randomUUID(),
    expiresAt: new Date(Date.now() + 5000).toISOString(),
  };
  const contender = { ...first, operationId: randomUUID(), ownerEpoch: 2 };

  assert.equal(one.admit(first, before).created, true);
  assert.equal(two.admit(first, before).created, false);
  assert.throws(
    () => two.admit({ ...first, requestDigest: "c".repeat(64) }, before),
    { reason: "operation_conflict" },
  );
  assert.throws(() => two.admit(contender, before), {
    reason: "resource_conflict",
  });
  const started = one.consumePermit(first, permit);
  assert.throws(() => two.consumePermit(first, permit), {
    reason: "operation_conflict",
  });
  one.close();

  const reopened = openRestartJournal(path, targetIncarnation, 256);

  context.after(() => reopened.close());
  assert.deepEqual(reopened.read(first.operationId), {
    ...first,
    revision: 2,
    sequence: 2,
    capturedAt: started.capturedAt,
    phase: "effect_started",
    before,
    permitId: permit.permitId,
    after: null,
    reason: null,
  });
  assert.equal(reopened.admit(first, before).created, false);
  assert.throws(() => reopened.admit(contender, before), {
    reason: "resource_conflict",
  });
  assert.throws(() => openRestartJournal(path, randomUUID(), 256), {
    reason: "target_identity_mismatch",
  });
});

test("IT-CBO-04 retains before-effect refusal and exact final receipt, allowing only a higher epoch on the resource", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "maister-stand-journal-"));
  const path = join(directory, "state.sqlite");
  const journal = openRestartJournal(path, targetIncarnation, 256);

  context.after(() => rmSync(directory, { recursive: true, force: true }));
  context.after(() => journal.close());

  const next = { ...first, operationId: randomUUID(), ownerEpoch: 2 };

  journal.admit(first, before);
  assert.throws(
    () =>
      journal.consumePermit(first, {
        permitId: randomUUID(),
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
    { reason: "authority_expired" },
  );
  assert.equal(
    journal.refuse(first, "authority_refused").phase,
    "confirmed_not_applied",
  );
  assert.throws(
    () => journal.admit({ ...first, operationId: randomUUID() }, before),
    { reason: "stale_owner" },
  );
  journal.admit(next, before);
  journal.consumePermit(next, {
    permitId: randomUUID(),
    expiresAt: new Date(Date.now() + 5000).toISOString(),
  });
  const settled = journal.finish(next, {
    acknowledgement: "received",
    after: { invocationId: "after", state: "active" },
  });

  assert.equal(settled.phase, "confirmed_applied");
  assert.equal(settled.revision, 3);
  assert.deepEqual(journal.admit(next, before), {
    created: false,
    entry: settled,
  });
  assert.throws(() => journal.refuse(next, "authority_refused"), {
    reason: "operation_conflict",
  });
  assert.equal(journal.read(first.operationId)?.phase, "confirmed_not_applied");
  const unknown = { ...next, operationId: randomUUID(), ownerEpoch: 3 };

  journal.admit(unknown, before);
  journal.consumePermit(unknown, {
    permitId: randomUUID(),
    expiresAt: new Date(Date.now() + 5000).toISOString(),
  });
  const uncertain = journal.finish(unknown, {
    acknowledgement: "uncertain",
    after: { invocationId: "another-invocation", state: "active" },
  });

  assert.equal(uncertain.phase, "unknown");
  assert.throws(
    () =>
      journal.admit(
        { ...unknown, operationId: randomUUID(), ownerEpoch: 4 },
        before,
      ),
    { reason: "resource_conflict" },
  );
});
