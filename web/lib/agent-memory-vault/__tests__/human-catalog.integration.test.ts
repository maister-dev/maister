import { expect, it, vi } from "vitest";

import {
  getHumanVaultLocation,
  listHumanVaultLocations,
} from "../human-catalog";

import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  addProjectMember,
  removeProjectMember,
  seedActiveUser,
} from "@/test-support/librarian-seed";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

it("K08 pages authorized attachments, resolves the 51st directly and leaves unmaterialized vaults untouched", async () => {
  const fixture = await startMainPostgresTestDb({
    databaseName: "human_vault_catalog",
  });

  vi.stubEnv("AUTH_SECRET", "human-vault-catalog-fixture");

  try {
    const project = await seedProjectRow(fixture.db);
    const otherProject = await seedProjectRow(fixture.db);
    const userId = await seedActiveUser(fixture.db);

    await addProjectMember(fixture.db, {
      projectId: project.id,
      userId,
      role: "admin",
    });
    await fixture.pool.query(`
      INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path)
      SELECT 'fixture:catalog-' || i,'fixture','v1','git','Catalog agent','Fixture','none','session','[]','read_only','/unused/catalog.md'
      FROM generate_series(1,51) i
    `);
    await fixture.pool.query(
      `
      INSERT INTO agent_project_links(id,project_id,agent_id,enabled,memory_enabled)
      SELECT 'catalog-' || lpad(i::text,2,'0'),$1,'fixture:catalog-' || i,i<>50,i<>49
      FROM generate_series(1,51) i
    `,
      [project.id],
    );
    await fixture.pool.query(
      `
      INSERT INTO agent_project_links(id,project_id,agent_id,memory_enabled)
      VALUES ('other-project',$1,'fixture:catalog-51',true)
    `,
      [otherProject.id],
    );
    const first = await listHumanVaultLocations(fixture.db, userId, {
      limit: 50,
    });

    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.items.map((item) => item.locationId)).not.toContain(
      "project:catalog-51",
    );
    expect(
      (
        await listHumanVaultLocations(fixture.db, userId, {
          limit: 50,
          cursor: first.nextCursor!,
        })
      ).items,
    ).toMatchObject([{ locationId: "project:catalog-51", state: "legacy" }]);
    const exact = (id: string) =>
      getHumanVaultLocation(fixture.db, userId, `project:${id}`);

    expect(await exact("catalog-51")).toMatchObject({
      ownerKind: "project",
      owner: { id: project.id },
      state: "legacy",
    });
    expect(await exact("catalog-49")).toMatchObject({
      state: "disabled_memory",
    });
    expect(await exact("catalog-50")).toMatchObject({
      state: "disabled_attachment",
    });
    await expect(exact("other-project")).rejects.toMatchObject({
      details: { reason: "agent_memory_unavailable" },
    });
    await fixture.pool.query(
      `INSERT INTO package_installs(id,source_url,name,version_label,resolved_revision,manifest,manifest_digest,installed_path,package_status,trust_status)
      VALUES ('catalog-package','github.com/fixture/catalog','catalog','v1','pinned','{}','digest','/unused/catalog','Installed','trusted')`,
    );
    const company = await fixture.pool.query<{ id: string }>(
      "SELECT id FROM companies",
    );
    const companyId = company.rows[0]!.id;

    await fixture.pool.query(
      `WITH bindings AS (
      INSERT INTO company_specialist_bindings(id,company_id,agent_id,package_install_id,enabled,created_by,creation_key,creation_digest)
      SELECT 'catalog-install-'||lpad(i::text,2,'0'),$1,'fixture:catalog-'||i,
        'catalog-package',true,$2,'catalog-install-'||i,repeat('a',64)
      FROM generate_series(1,51) i RETURNING id, agent_id, creation_key, creation_digest
      )
      INSERT INTO company_specialist_binding_revisions(binding_id,revision,snapshot,authority_snapshot,actor,
          request_actor_id,operation,request_key,request_digest,snapshot_digest)
      SELECT b.id,1,
        '{"schemaVersion":1,"name":"Catalog agent","definition":{},"configuration":{},"effectiveConfiguration":{},
        "grantActions":[],"executionPolicy":{},"installationGrant":{"reach":"active_projects","memoryEnabled":true}}'::jsonb
          || jsonb_build_object('agentId',b.agent_id,'enabled',true,'packageInstallId','catalog-package'),
        jsonb_build_object('schemaVersion',1,'actor',a.actor,'witness',
          jsonb_build_object('owner',jsonb_build_object('companyId',$1::text),'action','specialists:manage')),
        a.actor,$2,'created',b.creation_key,b.creation_digest,repeat('b',64)
      FROM bindings b CROSS JOIN LATERAL
      (SELECT jsonb_build_object('kind','user','id',$2::text,'runId',NULL,'attemptId',NULL) AS actor) a`,
      [companyId, userId],
    );
    const installation = () =>
      getHumanVaultLocation(
        fixture.db,
        userId,
        "installation:catalog-install-51",
      );

    await expect(installation()).rejects.toMatchObject({
      details: { reason: "agent_memory_unavailable" },
    });
    await fixture.pool.query(
      `INSERT INTO company_grants(company_id,principal_type,principal_id,action,created_by)
      VALUES ($1,'user',$2,'specialists:read',$2)`,
      [companyId, userId],
    );
    await addProjectMember(fixture.db, {
      projectId: otherProject.id,
      userId,
      role: "member",
    });
    expect(await installation()).toMatchObject({
      ownerKind: "installation",
      owner: { id: companyId },
      state: "awaiting_cutover",
    });
    expect(
      (
        await listHumanVaultLocations(fixture.db, userId, {
          limit: 20,
          agentId: "fixture:catalog-51",
        })
      ).items.map(({ locationId }) => locationId),
    ).toEqual([
      "installation:catalog-install-51",
      "project:catalog-51",
      "project:other-project",
    ]);
    await fixture.pool.query(
      "INSERT INTO agent_memory_cutover(generation) VALUES (1)",
    );
    expect(await exact("catalog-51")).toMatchObject({
      state: "empty",
      allowedActions: expect.arrayContaining(["view"]),
    });
    expect(await installation()).toMatchObject({
      state: "empty",
      allowedActions: ["view", "settings"],
    });
    expect(
      (await fixture.pool.query("SELECT id FROM agent_memory_vaults")).rows,
    ).toEqual([]);
    await removeProjectMember(fixture.db, { projectId: project.id, userId });
    await expect(exact("catalog-51")).rejects.toMatchObject({
      details: { reason: "agent_memory_unavailable" },
    });
  } finally {
    vi.unstubAllEnvs();
    await fixture.stop();
  }
}, 180_000);
