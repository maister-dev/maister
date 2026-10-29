import type { ConfigPersistSnapshot } from "@/lib/project-config-persistence/types";

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import {
  findConfigOperation,
  insertConfigReview,
  transitionConfigOperation,
} from "@/lib/project-config-persistence/store";
import {
  startMainPostgresTestDb,
  startMainPostgresTestDbUpTo,
  applyMainMigration,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "project_config_persistence",
  });
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("CT-CPC-12: upgrading the pre-feature lineage preserves null and existing manifest locators and starts revisions at zero", async () => {
  const legacy = await startMainPostgresTestDbUpTo(
    { databaseName: "config_upgrade" },
    "0193_numerous_spectrum",
  );

  try {
    for (const [index, locator] of [
      null,
      "/tmp/existing/maister.yaml",
    ].entries()) {
      await legacy.pool.query(
        "INSERT INTO projects (id,slug,name,repo_path,task_key,maister_yaml_path) VALUES ($1,$1,'Legacy',$2,$3,$4)",
        [`legacy-${index}`, `/tmp/legacy-${index}`, `LEG${index}`, locator],
      );
    }
    const before = await legacy.pool.query<{ row: Record<string, unknown> }>(
      "SELECT to_jsonb(projects) AS row FROM projects ORDER BY id",
    );

    await legacy.pool.query(
      `INSERT INTO package_installs (id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status)
       VALUES ('legacy-install','https://example.invalid/package','legacy-package','v1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','{}','digest','/tmp/legacy-cache','Installed')`,
    );
    await legacy.pool.query(
      "INSERT INTO project_package_attachments (id,project_id,package_install_id,package_name) VALUES ('legacy-attachment','legacy-0','legacy-install','legacy-package')",
    );
    const pinsBefore = await legacy.pool.query(
      "SELECT to_jsonb(project_package_attachments) AS row FROM project_package_attachments",
    );

    await applyMainMigration(legacy.db, "0194_project_config_persistence");
    await applyMainMigration(
      legacy.db,
      "0195_project_config_publication_guard",
    );
    const after = await legacy.pool.query<{ row: Record<string, unknown> }>(
      "SELECT to_jsonb(projects) AS row FROM projects ORDER BY id",
    );

    expect(after.rows).toEqual(
      before.rows.map(({ row }) => ({
        row: { ...row, config_export_revision: 0 },
      })),
    );
    expect(
      (
        await legacy.pool.query(
          "SELECT to_jsonb(project_package_attachments) AS row FROM project_package_attachments",
        )
      ).rows,
    ).toEqual(pinsBefore.rows);
    expect(
      (
        await legacy.pool.query(
          "SELECT * FROM project_config_persist_operations",
        )
      ).rows,
    ).toEqual([]);
  } finally {
    await legacy.stop();
  }
});

it("CT-CPC-12: immutable reviews, active uniqueness, owner fencing and terminal receipts are enforced", async () => {
  const projectId = randomUUID();
  const actorUserId = randomUUID();
  const repo = `/tmp/config-review-${projectId}`;

  await database.pool.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
    actorUserId,
    `${actorUserId}@example.invalid`,
  ]);
  await database.pool.query(
    "INSERT INTO projects (id, slug, name, repo_path, task_key) VALUES ($1, $2, 'Review', $3, $4)",
    [
      projectId,
      `review-${projectId}`,
      repo,
      `RV${projectId.slice(0, 8).toUpperCase()}`,
    ],
  );

  const snapshot: ConfigPersistSnapshot = {
    version: 1,
    projectId,
    actorUserId,
    exportRevision: "0",
    projection: {
      name: "Review",
      mainBranch: "main",
      branchPrefix: "maister/",
      publicBranchTemplate: "feature/{task_key}-{slug}",
      defaultRunnerId: null,
      promotionMode: null,
      packages: [],
    },
    repository: {
      repoPath: repo,
      commonDirectory: `${repo}/.git`,
      branch: "main",
      head: null,
      manifestDigest: null,
      manifestMode: null,
      indexEntries: "",
      status: "",
      authorName: "Test",
      authorEmail: "test@example.invalid",
      usedDefaultAuthor: false,
    },
    proposedDigest: "a".repeat(64),
    diffDigest: "b".repeat(64),
    contentDirectory: `${repo}/private-review`,
    message: "chore(maister): persist project config",
  };
  const firstIdentity = { id: randomUUID(), projectId, actorUserId };
  const secondIdentity = { id: randomUUID(), projectId, actorUserId };

  await insertConfigReview(database.db, firstIdentity, snapshot);
  await insertConfigReview(database.db, secondIdentity, snapshot);

  expect(
    await findConfigOperation(database.db, {
      ...firstIdentity,
      actorUserId: randomUUID(),
    }),
  ).toBeNull();
  await expect(
    database.pool.query(
      "UPDATE project_config_persist_operations SET snapshot = '{}'::jsonb WHERE id = $1",
      [firstIdentity.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });

  const ownerToken = randomUUID();
  const acceptedAt = new Date();

  await transitionConfigOperation(
    database.db,
    firstIdentity,
    { state: "previewed", ownerToken: null },
    { state: "preparing", acceptedAt, ownerToken },
  );
  await expect(
    database.pool.query(
      "UPDATE projects SET name='Concurrent change' WHERE id=$1",
      [projectId],
    ),
  ).rejects.toMatchObject({ code: "55P03" });
  await expect(
    transitionConfigOperation(
      database.db,
      secondIdentity,
      { state: "previewed", ownerToken: null },
      { state: "preparing", acceptedAt, ownerToken: randomUUID() },
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    transitionConfigOperation(
      database.db,
      firstIdentity,
      { state: "preparing", ownerToken: randomUUID() },
      {
        state: "failed",
        completedAt: new Date(),
        errorReason: "commit_failed",
      },
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(
    database.pool.query(
      "UPDATE project_config_persist_operations SET state = 'committed' WHERE id = $1",
      [firstIdentity.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });

  await transitionConfigOperation(
    database.db,
    firstIdentity,
    { state: "preparing", ownerToken },
    { state: "failed", completedAt: new Date(), errorReason: "commit_failed" },
  );
  const pushSnapshot = JSON.stringify({
    version: 1,
    operationId: firstIdentity.id,
    commitSha: "a".repeat(40),
    destination: "refs/heads/main",
    destinationFingerprint: "destination",
    remoteBase: null,
    outgoingShas: ["a".repeat(40)],
  });
  const pushId = randomUUID();

  await database.pool.query(
    `INSERT INTO project_config_push_intents
     (id, operation_id, project_id, actor_user_id, snapshot, snapshot_digest, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,now() + interval '10 minutes')`,
    [
      pushId,
      firstIdentity.id,
      projectId,
      actorUserId,
      pushSnapshot,
      "c".repeat(64),
    ],
  );
  await expect(
    database.pool.query(
      "UPDATE project_config_push_intents SET actor_user_id = $1 WHERE id = $2",
      [randomUUID(), pushId],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    database.pool.query(
      "UPDATE project_config_push_intents SET state = 'succeeded' WHERE id = $1",
      [pushId],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    database.pool.query(
      "UPDATE project_config_persist_operations SET state = 'preparing' WHERE id = $1",
      [firstIdentity.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await transitionConfigOperation(
    database.db,
    secondIdentity,
    { state: "previewed", ownerToken: null },
    { state: "preparing", acceptedAt, ownerToken: randomUUID() },
  );
  await expect(
    database.pool.query("DELETE FROM projects WHERE id = $1", [projectId]),
  ).rejects.toMatchObject({ code: "23503" });
});

it("CT-CPC-12: export revisions follow semantic project changes and transaction rollback", async () => {
  const id = randomUUID();

  await database.pool.query(
    `INSERT INTO projects (id, slug, name, repo_path, task_key)
     VALUES ($1, $2, 'Before', $3, $4)`,
    [
      id,
      `config-${id}`,
      `/tmp/config-${id}`,
      `PC${id.slice(0, 8).toUpperCase()}`,
    ],
  );
  await database.pool.query(
    "UPDATE projects SET name = 'After' WHERE id = $1",
    [id],
  );

  const changed = await database.pool.query<{ revision: string | null }>(
    `SELECT to_jsonb(projects)->>'config_export_revision' AS revision
     FROM projects WHERE id = $1`,
    [id],
  );

  expect(changed.rows[0]?.revision).toBe("1");

  await database.pool.query(
    "UPDATE projects SET name = 'After', brain_enabled = NOT brain_enabled WHERE id = $1",
    [id],
  );

  const connection = await database.pool.connect();

  try {
    await connection.query("BEGIN");
    await connection.query(
      "UPDATE projects SET name = 'Rolled back' WHERE id = $1",
      [id],
    );
    await connection.query("ROLLBACK");
  } finally {
    connection.release();
  }

  const unchanged = await database.pool.query<{
    revision: string;
    name: string;
  }>(
    `SELECT config_export_revision::text AS revision, name FROM projects WHERE id = $1`,
    [id],
  );

  expect(unchanged.rows).toEqual([{ revision: "1", name: "After" }]);

  const installIds = [randomUUID(), randomUUID()];

  for (const [index, installId] of installIds.entries()) {
    await database.pool.query(
      `INSERT INTO package_installs (id, source_url, name, version_label, resolved_revision,
       manifest, manifest_digest, installed_path) VALUES ($1,'https://example.invalid/pkg','pkg',$2,$2,'{}','digest','/tmp/pkg')`,
      [installId, String(index)],
    );
  }
  const attachmentId = randomUUID();

  await database.pool.query(
    "INSERT INTO project_package_attachments (id,project_id,package_install_id,package_name) VALUES ($1,$2,$3,'pkg')",
    [attachmentId, id, installIds[0]],
  );
  await database.pool.query(
    "UPDATE project_package_attachments SET package_install_id=$1 WHERE id=$2",
    [installIds[1], attachmentId],
  );
  await database.pool.query(
    "UPDATE project_package_attachments SET package_install_id=$1 WHERE id=$2",
    [installIds[0], attachmentId],
  );
  await database.pool.query(
    "UPDATE project_package_attachments SET attached_at=now() WHERE id=$1",
    [attachmentId],
  );
  await database.pool.query(
    "DELETE FROM project_package_attachments WHERE id=$1",
    [attachmentId],
  );
  const attachmentRevision = await database.pool.query<{ revision: string }>(
    "SELECT config_export_revision::text AS revision FROM projects WHERE id=$1",
    [id],
  );

  expect(attachmentRevision.rows[0]?.revision).toBe("5");
  const triggers = await database.pool.query<{ trigger_name: string }>(
    "SELECT trigger_name FROM information_schema.triggers WHERE trigger_name LIKE 'project_config_%'",
  );

  expect(new Set(triggers.rows.map((row) => row.trigger_name)).size).toBe(5);
});
