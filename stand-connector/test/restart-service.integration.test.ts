import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ServiceObservation } from "../src/restart-journal.ts";
import { openRestartJournal } from "../src/restart-journal.ts";
import { createRestartService } from "../src/restart-service.ts";

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
