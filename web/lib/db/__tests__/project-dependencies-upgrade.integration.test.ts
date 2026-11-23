import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, expect, it } from "vitest";

import { pgErrorOf } from "@/lib/db/pg-error";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import {
  declareCurrentTestDatabaseWriter,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const predecessor = "0368_run_sync_attempt_peek_hint";
let database: StartedPostgresTestDb;

beforeAll(async () => {
  database = await startMainPostgresTestDbUpTo(
    { databaseName: "dependency_upgrade" },
    predecessor,
  );
  await declareCurrentTestDatabaseWriter(database);
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

it("AC02 aborts an inconsistent upgrade, preserves real attachment provenance and fences future requests", async () => {
  const pool = database.pool;
  await pool.query(`
    INSERT INTO projects (id, slug, name, repo_path, task_key)
    VALUES ('dep','dep','Legacy','/tmp/dep','DEP'), ('other','other','Empty','/tmp/other','OTH');
    INSERT INTO package_installs (id, source_url, name, version_label, resolved_revision, manifest, manifest_digest, installed_path, package_status)
    VALUES ('installed','https://example.invalid/acme','tools','v1','abcdef','{"sourceSubpath":"packages/tools"}','digest','/tmp/tools','Installed');
    INSERT INTO project_package_attachments (id, project_id, package_install_id, package_name)
    VALUES ('bound','dep','installed','wrong-name');
    INSERT INTO projects (id,slug,name,repo_path,task_key,archived_at)
      VALUES ('archived','archived','Archived','/tmp/archived','ARC',now());
    INSERT INTO package_installs (id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status)
      VALUES ('cut','file:///tmp/cut','local','local-0123456789ab','0123456789ab','{}','digest','/tmp/cut','Installed');
    INSERT INTO project_package_attachments (id,project_id,package_install_id,package_name)
      VALUES ('cut-bound','archived','cut','local');
    INSERT INTO flow_revisions (id,flow_ref_id,source,version_label,resolved_revision,manifest_digest,manifest,schema_version,installed_path)
      VALUES ('revision','member','local','v1','abcdef','digest','{}',1,'/tmp/member');
    INSERT INTO flows (id,project_id,flow_ref_id,source,version,revision,installed_path,manifest,schema_version,package_install_id,enabled_revision_id)
      VALUES ('member','dep','member','local','v1','abcdef','/tmp/member','{}',1,'installed','revision'),
             ('standalone','dep','native','local','v1','native-rev','/tmp/native','{}',1,NULL,NULL);
    INSERT INTO runs (id,project_id,flow_id,flow_revision_id,status,flow_version,flow_revision)
      VALUES ('historical','dep','member','revision','Running','v1','abcdef');
  `);
  const revisions = () =>
    pool.query("SELECT id,config_export_revision FROM projects ORDER BY id");
  await expect(
    upgradeMainTestDb(database, predecessor).catch((error: unknown) => {
      throw pgErrorOf(error) ?? error;
    }),
  ).rejects.toMatchObject({ message: expect.stringContaining("bound") });
  expect(
    (
      await pool.query(
        "SELECT to_regclass('project_dependency_declarations') AS table",
      )
    ).rows[0].table,
  ).toBeNull();
  await pool.query(
    "UPDATE project_package_attachments SET package_name='tools' WHERE id='bound'",
  );
  const historical = () =>
    pool.query(`SELECT to_jsonb(r) AS run, to_jsonb(f) AS flow, to_jsonb(fr) AS revision,
      to_jsonb(a) AS attachment, to_jsonb(i) AS install
      FROM runs r JOIN flows f ON f.id=r.flow_id JOIN flow_revisions fr ON fr.id=r.flow_revision_id
      JOIN package_installs i ON i.id=f.package_install_id JOIN project_package_attachments a ON a.package_install_id=i.id
      WHERE r.id='historical'`);
  const previousExport = (
    await pool.query(`SELECT i.name AS id, i.source_url AS source,i.version_label AS version,
      i.manifest->>'sourceSubpath' AS path, i.resolved_revision AS "resolvedRevision"
      FROM project_package_attachments a JOIN package_installs i ON i.id=a.package_install_id WHERE a.project_id='dep'`)
  ).rows;
  const before = (await revisions()).rows;
  const receiptsBefore = (await historical()).rows;
  const apply = () =>
    migrate(database.db, { migrationsFolder: "./lib/db/migrations" });
  await apply();
  await apply();
  expect((await revisions()).rows).toEqual(before);
  expect((await historical()).rows).toEqual(receiptsBefore);
  const exported = () =>
    pool.query(`SELECT logical_id AS id, desired->>'source' AS source, desired->>'version' AS version,
      desired->>'path' AS path, effective_revision AS "resolvedRevision"
      FROM project_dependency_declarations WHERE project_id='dep' AND kind='package'`);
  expect((await exported()).rows).toEqual(previousExport);
  expect(
    (
      await pool.query(
        "SELECT project_id,logical_id,desired,effective_attachment_id,effective_revision,effective_generation FROM project_dependency_declarations ORDER BY project_id",
      )
    ).rows,
  ).toEqual([
    {
      project_id: "archived",
      logical_id: "local",
      desired: { source: "file:///tmp/cut", version: "local-0123456789ab" },
      effective_attachment_id: "cut-bound",
      effective_revision: "0123456789ab",
      effective_generation: 1,
    },
    {
      project_id: "dep",
      logical_id: "tools",
      desired: {
        source: "https://example.invalid/acme",
        version: "v1",
        path: "packages/tools",
      },
      effective_attachment_id: "bound",
      effective_revision: "abcdef",
      effective_generation: 1,
    },
  ]);
  expect(
    (await pool.query("SELECT id FROM project_dependency_attempts")).rows,
  ).toEqual([]);
  await pool.query(
    "UPDATE project_dependency_declarations SET desired=jsonb_set(desired, '{version}', to_jsonb($1::text)),generation=2,effective_generation=2 WHERE logical_id='tools'",
    ["v2"],
  );
  expect((await exported()).rows).toEqual([
    { ...previousExport[0], version: "v2" },
  ]);
  const insert = (id: string, kind: string, logicalId: string) =>
    pool.query(
      "INSERT INTO project_dependency_declarations (id,project_id,kind,logical_id,ordinal,desired) VALUES ($1,'other',$2,$3,0,$4)",
      [
        id,
        kind,
        logicalId,
        { source: "https://example.invalid/acme", version: "v2" },
      ],
    );
  await insert("flow", "flow", "shared");
  await insert("import", "capability_import", "shared");
  await expect(insert("bad", "package", "shared")).rejects.toMatchObject({
    code: "23505",
  });
  await insert("pin", "package", "alias");
  await pool.query(
    "UPDATE project_dependency_declarations SET effective_attachment_id=NULL WHERE logical_id='tools'",
  );
  await expect(
    pool.query(
      "UPDATE project_dependency_declarations SET effective_attachment_id='bound',effective_generation=1,effective_revision='abcdef' WHERE id='pin'",
    ),
  ).rejects.toMatchObject({ code: "23503" });
  await expect(
    pool.query(
      "UPDATE project_dependency_declarations SET desired=desired || '{\"version\":\"v3\"}' WHERE id='pin'",
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await pool.query(
    "INSERT INTO users(id,email) VALUES ('installer','install@example.invalid')",
  );
  const claim = (id: string, n: number) =>
    pool.query(
      `INSERT INTO project_dependency_attempts
    (id,project_id,declaration_id,generation,attempt_no,desired,actor_user_id,status,claim_token,lease_expires_at)
    SELECT $1,project_id,id,generation,$2,desired,'installer','running',$1,now()+interval '1 minute'
    FROM project_dependency_declarations WHERE id='pin'`,
      [id, n],
    );
  await claim("a1", 1);
  await expect(claim("a2", 2)).rejects.toMatchObject({ code: "23505" });
});
