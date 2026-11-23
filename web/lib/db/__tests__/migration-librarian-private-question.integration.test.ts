import { randomUUID } from "node:crypto";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { seedActiveUser } from "@/test-support/librarian-seed";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import {
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const previous = "0404_assigned_host_mcp_prepare";
let database: StartedPostgresTestDb;
const segment = randomUUID();
const conversation = randomUUID();
const turn = randomUUID();
const oldCard = randomUUID();
const otherTurn = randomUUID();
let old: unknown;

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "private_question_upgrade" },
    previous,
  );
  const owner = await seedActiveUser(database.db);
  const pool = database.pool;

  await pool.query(
    "INSERT INTO librarian_conversations(id,user_id) VALUES($1,$2)",
    [conversation, owner],
  );
  await pool.query(
    "INSERT INTO librarian_segments(id,conversation_id,ordinal,started_at) VALUES($1,$2,0,now())",
    [segment, conversation],
  );
  await pool.query(
    "INSERT INTO librarian_turns(id,conversation_id,segment_id,variant,status) VALUES($1,$2,$3,'owner_message','completed')",
    [turn, conversation, segment],
  );
  await pool.query(
    "INSERT INTO librarian_cards(id,conversation_id,segment_id,kind,status,target,payload,payload_digest,requires_owner,expires_at) VALUES($1,$2,$3,'confirmation','pending','{}','{}','old',true,now())",
    [oldCard, conversation, segment],
  );
  const otherOwner = await seedActiveUser(database.db);
  const otherConversation = randomUUID();
  const otherSegment = randomUUID();

  await pool.query(
    "INSERT INTO librarian_conversations(id,user_id) VALUES($1,$2)",
    [otherConversation, otherOwner],
  );
  await pool.query(
    "INSERT INTO librarian_segments(id,conversation_id,ordinal,started_at) VALUES($1,$2,0,now())",
    [otherSegment, otherConversation],
  );
  await pool.query(
    "INSERT INTO librarian_turns(id,conversation_id,segment_id,variant,status) VALUES($1,$2,$3,'owner_message','completed')",
    [otherTurn, otherConversation, otherSegment],
  );
  old = (
    await pool.query(
      "SELECT to_jsonb(c) AS value FROM librarian_cards c WHERE id=$1",
      [oldCard],
    )
  ).rows[0].value;
  await upgradeMainTestDb(database, previous);
}, 180000);

afterAll(async () => database?.stop());

it("IT-ASK-02 populated upgrade retains old cards and rejects incomplete/cross-owner questions", async () => {
  const pool = database.pool;

  await migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
  expect(
    (
      await pool.query(
        "SELECT to_jsonb(c)-ARRAY['question_turn_id','question_key','question_checkpoint_at','question_answer','question_delivered_at'] AS value FROM librarian_cards c WHERE id=$1",
        [oldCard],
      )
    ).rows[0].value,
  ).toEqual(old);
  const insert = (
    key: string | null,
    turnId: string | null,
    cardStatus: string,
  ) =>
    pool.query(
      "INSERT INTO librarian_cards(id,conversation_id,segment_id,question_turn_id,question_key,kind,status,target,payload,payload_digest,requires_owner,expires_at) VALUES($1,$2,$3,$4,$5,'question',$6,'{}','{}','new',true,now()) RETURNING id",
      [randomUUID(), conversation, segment, turnId, key, cardStatus],
    );

  await expect(insert(null, turn, "pending")).rejects.toMatchObject({
    constraint: "librarian_cards_question_shape_check",
  });
  await expect(insert("incomplete", turn, "accepted")).rejects.toMatchObject({
    constraint: "librarian_cards_question_shape_check",
  });
  await expect(insert("mixed", otherTurn, "pending")).rejects.toMatchObject({
    constraint: "librarian_cards_question_owner_fk",
  });
  await expect(insert("missing-owner", null, "pending")).rejects.toMatchObject({
    constraint: "librarian_cards_question_shape_check",
  });
  const pending = (await insert("right", turn, "pending")).rows[0].id;

  await expect(insert("second", turn, "pending")).rejects.toMatchObject({
    constraint: "librarian_cards_pending_question_uq",
  });
  await pool.query(
    "UPDATE librarian_cards SET status='cleared_by_reset',decided_at=now() WHERE id=$1",
    [pending],
  );
  await expect(insert("right", turn, "pending")).rejects.toMatchObject({
    constraint: "librarian_cards_question_key_uq",
  });
  const accepted = (await insert("valid-accept", turn, "pending")).rows[0].id;

  await expect(
    pool.query(
      "UPDATE librarian_cards SET status='accepted',decided_at=now(),question_answer='{}' WHERE id=$1",
      [accepted],
    ),
  ).rejects.toMatchObject({
    constraint: "librarian_cards_question_shape_check",
  });
  await pool.query(
    "UPDATE librarian_cards SET status='accepted',decided_at=now(),question_checkpoint_at=now(),question_answer='{}' WHERE id=$1",
    [accepted],
  );
  await pool.query(
    "UPDATE librarian_cards SET question_delivered_at=now() WHERE id=$1",
    [accepted],
  );
  await expect(
    pool.query(
      "UPDATE librarian_cards SET status='cleared_by_reset' WHERE id=$1",
      [accepted],
    ),
  ).rejects.toMatchObject({
    constraint: "librarian_cards_question_shape_check",
  });
});
