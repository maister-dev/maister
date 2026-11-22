import { expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import { parseAgentMemoryMutation } from "../commands";
import {
  getHumanVaultLocation,
  listHumanVaultLocations,
} from "../human-catalog";
import { prepareHumanInstallationVault } from "../installation-access";
import { agentMemoryVaultLimits } from "../limits";
import { readVaultReviewHistory } from "../review";
import { applyVaultMutation } from "../store";
import { viewAgentMemory } from "../view";

import {
  decideProposalReview,
  getProposalReviewDetail,
} from "@/lib/queries/inbox-review-actions";
import { listProposalReviews } from "@/lib/queries/knowledge-memory-reviews";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  addProjectMember,
  removeProjectMember,
  seedActiveUser,
} from "@/test-support/librarian-seed";
import { startMainPostgresTestDb } from "@/test-support/pg-container";
import { withQueryCount } from "@/test-support/query-count";

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

    const admin = await seedActiveUser(fixture.db, { role: "admin" });
    const agentId = "fixture:catalog-51";
    const bindingId = "catalog-install-51";
    const prepare = prepareHumanInstallationVault({
      userId: admin,
      agentId,
      bindingId,
      action: "read",
    });
    const limits = agentMemoryVaultLimits();
    const prepareWithSource = async (tx: Parameters<typeof prepare>[0]) => ({
      ...(await prepare(tx)),
      sourceProjectIds: [otherProject.id],
      sourceRestrictions: [
        { kind: "project_context" as const, projectId: otherProject.id },
      ],
    });
    const reviewedMove = async (directory: string, noteCount: number) => {
      const key = directory.slice("/memories/".length);

      for (let index = 0; index < noteCount; index++) {
        const path = `${directory}/note-${index}.md`;

        await applyVaultMutation(
          fixture.db,
          {
            command: "create",
            path,
            file_text: "Retained source note",
            ifRevisionId: null,
            ifHash: null,
            requestKey: `create-${key}-${index}`,
          },
          prepareWithSource,
          limits,
        );
      }
      const source = await viewAgentMemory(
        fixture.db,
        { command: "view", path: directory, limit: 20 },
        prepare,
      );

      if (source.kind !== "directory") throw new Error("Expected a directory");
      const move = await applyVaultMutation(
        fixture.db,
        {
          command: "rename",
          old_path: directory,
          new_path: `${directory}-moved`,
          ifGeneration: source.generation,
          heads: source.entries.map(({ path, revisionId, hash }) => ({
            path,
            ifRevisionId: revisionId!,
            ifHash: hash!,
          })),
          requestKey: `move-${key}`,
        },
        async (tx) => ({
          ...(await prepareWithSource(tx)),
          writeAdmission: "review_required",
        }),
        limits,
      );

      if (move.status !== "pending")
        throw new Error("Expected a retained proposal");
      await decideProposalReview(fixture.db, admin, {
        kind: "vault",
        id: move.proposalId,
        expectedVersion: "1",
        decision: "accept",
        requestKey: `accept-${key}`,
      });

      return move.proposalId;
    };
    const small = await reviewedMove("/memories/small", 1);
    const large = await reviewedMove("/memories/large", 12);
    const inspectHistory = (proposalId: string) =>
      fixture.db.transaction(async (tx) => {
        const measured = withQueryCount(tx);
        const history = await readVaultReviewHistory(
          measured.db,
          proposalId,
          userId,
        );

        return { history, queries: measured.count() };
      });
    const narrow = await inspectHistory(small);
    const wide = await inspectHistory(large);

    expect(wide.history.applied).toHaveLength(12);
    expect(wide.queries).toBe(narrow.queries);
    await fixture.db.transaction(async (tx) => {
      const { proposal } = await readVaultReviewHistory(tx, large, userId);

      await expect(
        fixture.pool.query(
          "SELECT id FROM agent_memory_vaults WHERE id=$1 FOR UPDATE NOWAIT",
          [proposal.vaultId],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    });
    await removeProjectMember(fixture.db, {
      projectId: otherProject.id,
      userId,
    });
    await expect(inspectHistory(large)).rejects.toMatchObject({
      details: { reason: "agent_memory_unavailable" },
    });
    const pending = await applyVaultMutation(
      fixture.db,
      parseAgentMemoryMutation({
        command: "create",
        path: "/memories/pending.md",
        file_text: "Pending edit",
        ifRevisionId: null,
        ifHash: null,
        requestKey: "pending-disabled-binding",
      }),
      async (tx) => ({
        ...(await prepare(tx)),
        writeAdmission: "review_required",
      }),
      agentMemoryVaultLimits(),
    );

    if (pending.status !== "pending")
      throw new Error("Expected an installation review proposal");
    const selection = { kind: "vault", id: pending.proposalId } as const;
    const detail = () => getProposalReviewDetail(fixture.db, admin, selection);

    expect(await detail()).toMatchObject({ allowed: ["accept", "reject"] });
    await fixture.db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE company_specialist_bindings
        SET enabled=false, revision=2
        WHERE id=${bindingId}
      `);
      await tx.execute(sql`
        INSERT INTO company_specialist_binding_revisions(
          binding_id,revision,snapshot,authority_snapshot,actor,request_actor_id,
          operation,request_key,request_digest,snapshot_digest
        )
        SELECT binding_id,2,snapshot||'{"enabled":false}'::jsonb,authority_snapshot,
          actor,request_actor_id,'updated','disable-test-binding',repeat('c',64),repeat('d',64)
        FROM company_specialist_binding_revisions WHERE binding_id=${bindingId} AND revision=1
      `);
    });

    expect(await installation()).toMatchObject({
      state: "disabled_attachment",
      allowedActions: ["settings"],
    });
    expect(await detail()).toMatchObject({ allowed: ["reject"] });
    expect(
      await listProposalReviews(fixture.db, admin, {
        kind: "vault",
        companyId,
        limit: 20,
      }),
    ).toMatchObject({
      items: [{ id: pending.proposalId, allowed: ["reject"] }],
    });
    await expect(fixture.db.transaction(prepare)).rejects.toMatchObject({
      code: "PRECONDITION",
      details: { reason: "agent_memory_attachment_disabled" },
    });
    const decision = {
      ...selection,
      requestKey: "settle-disabled-binding",
      expectedVersion: "1",
      reason: "The installation binding is disabled",
    };

    await expect(
      decideProposalReview(fixture.db, admin, {
        ...decision,
        decision: "accept",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      decideProposalReview(fixture.db, admin, {
        ...decision,
        decision: "reject",
      }),
    ).resolves.toMatchObject({ domainState: "rejected" });
    expect(await detail()).toMatchObject({
      domainState: "rejected",
      allowed: [],
      decision: { reason: decision.reason },
    });
  } finally {
    vi.unstubAllEnvs();
    await fixture.stop();
  }
}, 180_000);
