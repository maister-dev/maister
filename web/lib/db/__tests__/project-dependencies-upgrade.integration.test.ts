import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { readExportSnapshot } from "@/lib/project-config-persistence/projection";
import { assertDependencySource } from "@/lib/project-dependencies/source";
import { pgErrorOf } from "@/lib/db/pg-error";
import { upgradeMainTestDb } from "@/test-support/migration-upgrade";
import {
  declareCurrentTestDatabaseWriter,
  startMainPostgresTestDbUpTo,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "dep-admin" } }),
}));
vi.mock("@/lib/db/client", async (original) => ({
  ...(await original<typeof import("@/lib/db/client")>()),
  getDb: () => database.db,
}));
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
    VALUES ('installed','https://[::ffff:192.0.2.1]/acme','tools','v1','abcdef','{"sourceSubpath":"packages/tools"}','digest','/tmp/tools','Installed');
    INSERT INTO project_package_attachments (id, project_id, package_install_id, package_name)
    VALUES ('bound','dep','installed','wrong-name');
    INSERT INTO projects (id,slug,name,repo_path,task_key,archived_at)
      VALUES ('archived','archived','Archived','/tmp/archived','ARC',now());
    INSERT INTO package_installs (id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status)
      VALUES ('cut','file:///tmp/cut','local','local-0123456789ab','0123456789ab','{}','digest','/tmp/cut','Installed');
    INSERT INTO project_package_attachments (id,project_id,package_install_id,package_name)
      VALUES ('cut-bound','archived','cut','local');
    INSERT INTO capability_imports (id,project_id,capability_ref_id,source,version_tag,resolved_revision,manifest_digest,manifest,installed_path,package_status,trust_status,setup_status)
      VALUES ('legacy-import','dep','legacy','https://example.invalid/bundle','v1','aa','hash','{}','/tmp/legacy','Installed','untrusted','pending');
    INSERT INTO capability_records (id,project_id,capability_ref_id,kind,label,source,agents,version,revision)
      VALUES ('legacy-record','dep','legacy','agent_definition','legacy','flow-package','[]','v1','aa');
    INSERT INTO capability_imports (id,project_id,capability_ref_id,source,version_tag,resolved_revision,manifest_digest,manifest,installed_path,package_status,trust_status,setup_status)
      VALUES ('cleared','dep','cleared','https://example.invalid/old','v1','bb','hash','{}','/tmp/no-longer-selected','Installed','trusted','done');
    INSERT INTO capability_records (id,project_id,capability_ref_id,kind,label,source,agents,version,revision,selectable,disabled_at)
      VALUES ('cleared-record','dep','cleared','agent_definition','cleared','flow-package','[]','v1','bb',false,now());
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
  const apply = () =>
    migrate(database.db, { migrationsFolder: "./lib/db/migrations" });

  await pool.query(
    "UPDATE package_installs SET source_url='https://user:synthetic-marker@example.invalid/acme' WHERE id='installed'",
  );
  const refusal = await apply().then(
    () => null,
    (error: unknown) => pgErrorOf(error),
  );

  expect(refusal?.message).toContain("bound");
  expect(refusal?.message).not.toContain("synthetic-marker");
  expect(
    (
      await pool.query(
        "SELECT to_regclass('project_dependency_declarations') AS relation",
      )
    ).rows[0].relation,
  ).toBeNull();
  await pool.query(
    "UPDATE package_installs SET source_url='https://[::ffff:192.0.2.1]/acme' WHERE id='installed'",
  );
  const receiptsBefore = (await historical()).rows;
  const before = (await revisions()).rows;

  await apply();
  await apply();
  expect((await revisions()).rows).toEqual(before);
  expect((await historical()).rows).toEqual(receiptsBefore);
  expect(
    (
      await pool.query(
        "SELECT package_status FROM capability_imports WHERE id='cleared'",
      )
    ).rows,
  ).toEqual([{ package_status: "Installed" }]);
  const { captureTaskLaunchCapabilityBundles } =
    await import("@/lib/tasks/launch-capabilities");

  expect(await captureTaskLaunchCapabilityBundles(database.db, "dep")).toEqual(
    [],
  );
  expect(
    (
      await pool.query(
        "SELECT selectable, disabled_at, material FROM capability_records WHERE id='legacy-record'",
      )
    ).rows,
  ).toEqual([
    {
      selectable: false,
      disabled_at: expect.any(Date),
      material: { origin: "dependency-import", importId: "legacy-import" },
    },
  ]);
  await pool.query(
    "INSERT INTO users(id,email,role,account_status) VALUES ('dep-admin','dep@example.invalid','admin','active')",
  );
  const { GET } = await import("@/app/api/projects/[slug]/packages/route");
  const response = await GET(
    new NextRequest("http://localhost/api/projects/dep/packages"),
    { params: Promise.resolve({ slug: "dep" }) },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    attachments: [
      { id: "bound", packageInstallId: "installed", flows: ["member"] },
    ],
    declarations: [
      {
        ref: "tools",
        effectiveAttachmentId: "bound",
        effectiveRevision: "abcdef",
        state: null,
        attempt: null,
      },
    ],
  });
  const { getProjectPackageAttachments } =
    await import("@/lib/queries/packages");

  expect(await getProjectPackageAttachments("dep")).toMatchObject([
    { id: "bound", flows: ["member"] },
  ]);
  const exported = async () =>
    (await readExportSnapshot(database.db, "dep")).projection.packages;

  expect(await exported()).toEqual(previousExport);
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
        source: "https://[::ffff:192.0.2.1]/acme",
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
  expect(await exported()).toEqual([{ ...previousExport[0], version: "v2" }]);
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

it("upgrades an existing 0369 head only after its unsafe coordinates are repaired", async () => {
  const previous = "0369_project_dependencies";
  const old = await startMainPostgresTestDbUpTo(
    { databaseName: "dependency_0369_repair" },
    previous,
  );

  try {
    await old.pool
      .query(`INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES ('p','p','Project','/tmp/p','PRE');
      INSERT INTO project_dependency_declarations(id,project_id,kind,logical_id,ordinal,desired)
      VALUES ('head','p','flow','legacy',0,'{"source":"https://host.test/a?synthetic-marker","version":"v1"}');`);
    const refusal = await upgradeMainTestDb(old, previous).then(
      () => null,
      (error: unknown) => pgErrorOf(error),
    );

    expect(refusal?.message).toContain("head");
    expect(refusal?.message).not.toContain("synthetic-marker");
    await old.pool.query(
      `UPDATE project_dependency_declarations SET desired=jsonb_set(desired,'{source}',to_jsonb('git@host.test:repo'::text)),generation=2 WHERE id='head'`,
    );
    await migrate(old.db, { migrationsFolder: "./lib/db/migrations" });
    await expect(
      old.pool.query(
        `UPDATE project_dependency_declarations SET desired=jsonb_set(desired,'{source}',to_jsonb('ssh://git:private@host.test/repo'::text)),generation=3 WHERE id='head'`,
      ),
    ).rejects.toMatchObject({
      code: "23514",
      message: "Invalid dependency source for project p",
    });
  } finally {
    await old.stop();
  }
}, 180000);

it("uses the same coordinate grammar before persistence and after a 0370 upgrade", async () => {
  const prior = "0370_dependency_source_guard";
  const old = await startMainPostgresTestDbUpTo(
    { databaseName: "dependency_source_ports" },
    prior,
  );

  try {
    await old.pool
      .query(`INSERT INTO projects(id,slug,name,repo_path,task_key) VALUES('port-project','port-project','Port','/tmp/port','PORT');
      INSERT INTO project_dependency_declarations(id,project_id,kind,logical_id,ordinal,desired)
      VALUES('port-head','port-project','package','tools',0,'{"source":"https://example.org:65536/private-marker","version":"v1"}')`);
    const refusal = await upgradeMainTestDb(old, prior).then(
      () => null,
      (error: unknown) => pgErrorOf(error),
    );

    expect(refusal?.message).toContain("port-head");
    expect(refusal?.message).not.toContain("private-marker");
    await old.pool.query(
      `UPDATE project_dependency_declarations SET generation=2,desired=jsonb_set(desired,'{source}','"https://example.org:65535/my%20repo"') WHERE id='port-head'`,
    );
    await migrate(old.db, { migrationsFolder: "./lib/db/migrations" });
    const samples: [string, boolean][] = [
      ["https://example.org/my repo", false],
      ["https://example.org/my%20repo", true],
      ["https://example.org:65536/example", false],
      ["https://example.org:65535/example", true],
      ["ssh://git@127.0.0.1:00022/repo", true],
      ["ssh://git@[::1]:65536/repo", false],
      ["ssh://git@[::1]:22/repo", true],
      ["ssh://git@[1::2::3]/repo", false],
      ["https://example.org:/r", false],
      ["git@host:my dir", false],
      ["git@host:team/repo", true],
      ["ssh://git+deploy@host/repo", false],
      ["file:///tmp/local%20repo", true],
      ["file:///tmp/a%2Fb", false],
      ["file:///tmp/%FF", false],
      ["file:///tmp/%00", false],
      ["/tmp/Путь с пробелами", true],
      ["https://example.org/a\\b", false],
      ["https://example.org/a\u00a0b", false],
    ];

    for (const [source, expected] of samples) {
      const safe = () => assertDependencySource(source);

      if (expected) expect(safe, source).not.toThrow();
      else expect(safe, source).toThrow();
      const result = await old.pool.query<{ accepted: boolean }>(
        "SELECT project_dependency_safe_source($1) AS accepted",
        [source],
      );

      expect(result.rows[0].accepted, source).toBe(expected);
    }
  } finally {
    await old.stop();
  }
}, 180_000);

it("upgrades flat package skill inventories using the readiness of each project's candidate providers", async () => {
  const prior = "0374_flow_link_publication";
  const old = await startMainPostgresTestDbUpTo(
    { databaseName: "package_skill_upgrade" },
    prior,
  );
  try {
    await old.pool.query(`
      INSERT INTO projects(id,slug,name,repo_path,task_key)
        SELECT id,id,id,'/tmp/'||id,upper(id) FROM (VALUES ('mixed'),('ready')) s(id);
      INSERT INTO package_installs(id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status,trust_status)
        VALUES ('pkg','https://example.invalid/pkg','pkg','v1','abc','{"spec":{"capabilities":[{"id":"first"},{"id":"second"}]},"inventory":{"skills":["s"]}}','digest','/tmp/pkg','Installed','trusted');
      INSERT INTO project_package_attachments(id,project_id,package_install_id,package_name)
        SELECT id,id,'pkg','pkg' FROM projects;
      INSERT INTO capability_imports(id,project_id,capability_ref_id,source,version_tag,resolved_revision,manifest_digest,manifest,installed_path,package_status,trust_status,setup_status,package_install_id)
        SELECT p.id||c.id,p.id,c.id,'local','v1','abc','digest','{}','/tmp/pkg/'||c.id,'Installed','trusted',
          CASE WHEN p.id='mixed' AND c.id='second' THEN 'pending' ELSE 'done' END,'pkg'
        FROM projects p CROSS JOIN (VALUES ('first'),('second')) c(id);
      INSERT INTO capability_records(id,project_id,capability_ref_id,kind,label,source,agents,version,revision,selectable,selected_by_default,material)
        SELECT 'skill-'||id,id,'s','skill','s','flow-package','[]','v1','abc',true,false,
          '{"origin":"package-attachment","packageInstallId":"pkg"}' FROM projects;
    `);
    await upgradeMainTestDb(old, prior);
    const result = await old.pool
      .query(`SELECT id,selectable,(disabled_at IS NULL) AS available,selected_by_default
      FROM capability_records WHERE id IN ('skill-mixed','skill-ready') ORDER BY id`);
    expect(result.rows).toEqual([
      {
        id: "skill-mixed",
        selectable: false,
        available: false,
        selected_by_default: false,
      },
      {
        id: "skill-ready",
        selectable: true,
        available: true,
        selected_by_default: false,
      },
    ]);
  } finally {
    await old.stop();
  }
}, 180_000);
