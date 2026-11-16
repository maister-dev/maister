import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ServiceObservation } from "../src/restart-journal.ts";
import { openRestartJournal } from "../src/restart-journal.ts";
import { createRestartService } from "../src/restart-service.ts";

test("IT-CBO-07 transfers a retained unknown effect only to an online-approved successor", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "maister-stand-successor-"));
  const path = join(directory, "state.sqlite");
  const targetIncarnation = randomUUID();
  const predecessor = {
    operationId: randomUUID(),
    targetIncarnation,
    resourceKey: "a".repeat(64),
    requestDigest: "b".repeat(64),
    ownerEpoch: 1,
  };
  const before = { invocationId: "a".repeat(32), state: "active" } as const;
  const original = openRestartJournal(path, targetIncarnation, 256);
  const freshPermit = () => ({
    permitId: randomUUID(),
    expiresAt: new Date(Date.now() + 5000).toISOString(),
  });

  original.admit(predecessor, before);
  const effectStarted = original.consumePermit(predecessor, freshPermit());
  original.close();
  const journal = openRestartJournal(path, targetIncarnation, 256);

  context.after(() => {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const successor = {
    ...predecessor,
    operationId: randomUUID(),
    ownerEpoch: 3,
    requestDigest: "c".repeat(64),
    predecessorId: predecessor.operationId,
  };
  let effects = 0;
  let allowedPredecessor: string | undefined;
  let pendingJob = false;
  const service = createRestartService(journal, {
    inspect: async () =>
      effects ? { ...before, invocationId: "b".repeat(32) } : before,
    requireQuiescent: async () => {
      if (pendingJob) throw new Error("fixture pending systemd job");
    },
    authorize: async () => ({
      decision: "allowed",
      permit: {
        ...freshPermit(),
        ...(allowedPredecessor ? { predecessorId: allowedPredecessor } : {}),
      },
    }),
    restart: async () => {
      effects++;
      assert.equal(
        journal.read(successor.operationId)?.phase,
        "effect_started",
      );
      return "received";
    },
  });

  await assert.rejects(() => service.execute(successor, before), {
    reason: "resource_conflict",
  });
  assert.equal(journal.read(successor.operationId), null);
  assert.equal(effects, 0);

  allowedPredecessor = predecessor.operationId;
  pendingJob = true;
  await assert.rejects(
    () => service.execute(successor, before),
    /fixture pending systemd job/,
  );
  pendingJob = false;
  const settled = await service.execute(successor, before);

  assert.equal(settled.phase, "confirmed_applied");
  assert.deepEqual(await service.execute(successor, before), settled);
  assert.equal(effects, 1);
  assert.deepEqual(journal.read(predecessor.operationId), effectStarted);
});

test("IT-CBO-02 checks the recorded before state and online authority before one effect", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "maister-stand-restart-"));
  const targetIncarnation = randomUUID();
  const journal = openRestartJournal(
    join(directory, "state.sqlite"),
    targetIncarnation,
    256,
  );

  context.after(() => {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const first = {
    operationId: randomUUID(),
    targetIncarnation,
    resourceKey: "a".repeat(64),
    requestDigest: "b".repeat(64),
    ownerEpoch: 1,
  };
  let current: ServiceObservation = { invocationId: "before", state: "active" };
  let effects = 0;
  let checks = 0;
  const service = createRestartService(journal, {
    inspect: async () => current,
    authorize: async (intent) => {
      checks++;
      assert.equal(journal.read(intent.operationId)?.phase, "intent_retained");
      if (intent.ownerEpoch === 2) return { decision: "refused" };

      return {
        decision: "allowed",
        permit: {
          permitId: randomUUID(),
          expiresAt: new Date(Date.now() + 5000).toISOString(),
        },
      };
    },
    restart: async () => {
      effects++;
      assert.equal(journal.read(first.operationId)?.phase, "effect_started");
      current = { invocationId: "after", state: "active" };

      return "received";
    },
  });
  const before = current;
  const replies = await Promise.all([
    service.execute(first, before),
    service.execute(first, before),
  ]);

  assert.ok(replies.some(({ phase }) => phase === "confirmed_applied"));
  assert.equal(effects, 1);
  assert.equal(checks, 1);
  assert.equal(
    (await service.execute(first, before)).phase,
    "confirmed_applied",
  );

  const denied = { ...first, operationId: randomUUID(), ownerEpoch: 2 };

  assert.equal(
    (await service.execute(denied, current)).phase,
    "confirmed_not_applied",
  );
  const changed = { ...denied, operationId: randomUUID(), ownerEpoch: 3 };
  const refused = await service.execute(changed, before);

  assert.equal(refused.reason, "before_state_changed");
  assert.equal(refused.permitId, null);
  assert.equal(checks, 2);
  assert.equal(effects, 1);
});
