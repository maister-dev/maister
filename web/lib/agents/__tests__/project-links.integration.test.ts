// M34 (ADR-089 D11) — the attach-panel service: attach (conflict-safe),
// one-transaction link PATCH with full schedule replacement (cron validated,
// event kinds taxonomy-checked), detach with token revocation (the ADR-089
// rotation guarantee).

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { renderAgentDefinition } from "@/lib/agents/definition";
import {
  attachAgent,
  detachAgent,
  getProjectAgentsView,
  updateAgentLink,
} from "@/lib/agents/project-links";
import { issueAgentRunToken } from "@/lib/agents/tokens";
import * as schemaModule from "@/lib/db/schema";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const fx = { projectId: "", agentId: "test-pkg:platform-helper" };

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("agent_links_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);

  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  fx.projectId = randomUUID();

  await db.insert(schema.projects).values({
    id: fx.projectId,
    slug: "agent-links",
    name: "Agent Links",
    repoPath: "/tmp/agent-links",
    maisterYamlPath: "/tmp/agent-links/maister.yaml",
    taskKey: "ALK",
  });
  await db.insert(schema.agents).values({
    id: fx.agentId,
    packageName: "test-pkg",
    versionLabel: "v1.0.0",
    origin: "git",
    name: fx.agentId,
    description: "d",
    workspace: "none",
    mode: "session",
    triggers: ["manual", "cron", "domain_event"],
    riskTier: "read_only",
    sourcePath: `/tmp/agents/platform-helper.md`,
    // The GLOBAL catalog projection. F1: per-instance config writes validate
    // against the project-PINNED definition (.md written below), NOT this row —
    // so this catalog schema deliberately carries an EXTRA `catalog_only_key`
    // absent from the pinned .md (and OMITS the pinned-only `intake_mode`). The
    // version-skew test asserts the pinned definition is the source of truth.
    configSchema: [
      {
        key: "auto_enqueue",
        type: "enum",
        values: ["off", "when_confident", "always"],
        default: "off",
      },
      { key: "detect_duplicates", type: "boolean", default: true },
      { key: "catalog_only_key", type: "boolean", default: false },
    ],
  });

  // RD4 attach gate: the providing package must be enabled in the project.
  const revisionId = randomUUID();

  await pool.query(
    `INSERT INTO "flow_revisions"
       ("id", "flow_ref_id", "source", "version_label", "resolved_revision",
        "manifest_digest", "manifest", "schema_version", "installed_path", "package_status")
     VALUES ($1, 'test-pkg', 'github.com/acme/test-pkg', 'v1.0.0', 'rev-1',
             'digest', '{}'::jsonb, 1, '/tmp/test-pkg', 'Installed')`,
    [revisionId],
  );
  await pool.query(
    `INSERT INTO "flows"
       ("id", "project_id", "flow_ref_id", "source", "version", "installed_path",
        "manifest", "schema_version", "enabled_revision_id", "enablement_state",
        "trust_status", "version_binding")
     VALUES ($1, $2, 'test-pkg', 'github.com/acme/test-pkg', 'v1.0.0', '/tmp/test-pkg',
             '{}'::jsonb, 1, $3, 'Enabled', 'trusted', 'pinned')`,
    [randomUUID(), fx.projectId, revisionId],
  );

  // (ADR-106) Attach the package to the project — attachment IS the enable, so
  // it is what assertAgentPackageAttachable + listEnabledPackageRefs read now.
  const packageInstallId = randomUUID();

  // F1: updateAgentLink now validates per-instance config against the PINNED
  // definition resolveEffectiveAgentDefinition reads from
  // <installedPath>/maister-agents/<stem>.md — write a real pinned definition so
  // config writes validate against it, not the global catalog row. Its schema
  // carries the pinned-only `intake_mode` and OMITS the catalog-only key.
  const pkgRoot = await mkdtemp(path.join(os.tmpdir(), "maister-agentcfg-"));

  await mkdir(path.join(pkgRoot, "maister-agents"), { recursive: true });
  await writeFile(
    path.join(pkgRoot, "maister-agents", "platform-helper.md"),
    renderAgentDefinition({
      id: fx.agentId,
      name: "Platform Helper",
      description: "Routes simple-intent tasks.",
      workspace: "none",
      mode: "session",
      triggers: ["manual", "cron", "domain_event"],
      riskTier: "read_only",
      config: [
        {
          key: "auto_enqueue",
          type: "enum",
          values: ["off", "when_confident", "always"],
          default: "off",
        },
        { key: "detect_duplicates", type: "boolean", default: true },
        {
          key: "intake_mode",
          type: "enum",
          values: ["triage_only", "clarify"],
          default: "clarify",
        },
      ],
      prompt: "You are the platform helper.",
    }),
    "utf8",
  );

  await pool.query(
    `INSERT INTO "package_installs"
       ("id", "source_url", "name", "version_label", "resolved_revision",
        "manifest", "manifest_digest", "installed_path", "package_status", "trust_status")
     VALUES ($1, 'github.com/acme/test-pkg', 'test-pkg', 'v1.0.0', 'rev-pkg-1',
             '{}'::jsonb, 'digest', $2, 'Installed', 'trusted')`,
    [packageInstallId, pkgRoot],
  );
  await pool.query(
    `INSERT INTO "project_package_attachments"
       ("id", "project_id", "package_install_id", "package_name")
     VALUES ($1, $2, $3, 'test-pkg')`,
    [randomUUID(), fx.projectId, packageInstallId],
  );
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("project agent links (attach panel service)", () => {
  it("attaches once, then refuses the duplicate with CONFLICT", async () => {
    const { linkId } = await attachAgent(
      { projectId: fx.projectId, agentId: fx.agentId },
      db,
    );

    expect(linkId).toBeTruthy();

    await expect(
      attachAgent({ projectId: fx.projectId, agentId: fx.agentId }, db),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses attach when the providing package is not enabled in the project (RD4)", async () => {
    // A catalog agent from a package that has NO pin in fx.projectId.
    await db.insert(schema.agents).values({
      id: "orphan-pkg:helper",
      packageName: "orphan-pkg",
      versionLabel: "v1.0.0",
      origin: "git",
      name: "helper",
      description: "d",
      workspace: "none",
      mode: "session",
      triggers: ["manual"],
      riskTier: "read_only",
      sourcePath: "/tmp/orphan/helper.md",
    });

    await expect(
      attachAgent(
        { projectId: fx.projectId, agentId: "orphan-pkg:helper" },
        db,
      ),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    // The available-list filter hides it for the same reason.
    const view = await getProjectAgentsView(fx.projectId, db);
    const availableIds = view.available.map((a) => a.id);

    expect(availableIds).not.toContain("orphan-pkg:helper");
  });

  it("PATCH replaces the trigger bindings wholesale and validates cron + event kinds", async () => {
    await updateAgentLink(
      {
        projectId: fx.projectId,
        agentId: fx.agentId,
        patch: {
          schedules: [
            { triggerType: "cron", cronExpr: "*/15 * * * *", timezone: "UTC" },
            { triggerType: "event", eventKinds: ["task.created"] },
          ],
        },
      },
      db,
    );

    let view = await getProjectAgentsView(fx.projectId, db);

    expect(view.attached[0].schedules).toHaveLength(2);

    // Full replacement — the second PATCH leaves exactly one binding.
    await updateAgentLink(
      {
        projectId: fx.projectId,
        agentId: fx.agentId,
        patch: {
          schedules: [
            { triggerType: "event", eventKinds: ["task.comment_added"] },
          ],
        },
      },
      db,
    );

    view = await getProjectAgentsView(fx.projectId, db);
    expect(view.attached[0].schedules).toEqual([
      {
        triggerType: "event",
        eventKinds: ["task.comment_added"],
        enabled: true,
      },
    ]);

    await expect(
      updateAgentLink(
        {
          projectId: fx.projectId,
          agentId: fx.agentId,
          patch: {
            schedules: [
              { triggerType: "cron", cronExpr: "not a cron", timezone: "UTC" },
            ],
          },
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    await expect(
      updateAgentLink(
        {
          projectId: fx.projectId,
          agentId: fx.agentId,
          patch: {
            schedules: [{ triggerType: "event", eventKinds: ["not.a.kind"] }],
          },
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("detach removes link + bindings and revokes every live (agent, project) token", async () => {
    await issueAgentRunToken({
      agentId: fx.agentId,
      projectId: fx.projectId,
      runId: randomUUID(),
      db,
    });

    await detachAgent({ projectId: fx.projectId, agentId: fx.agentId }, db);

    const links = await pool.query(
      `SELECT count(*)::int AS n FROM agent_project_links WHERE agent_id = $1`,
      [fx.agentId],
    );
    const schedules = await pool.query(
      `SELECT count(*)::int AS n FROM agent_schedules WHERE agent_id = $1`,
      [fx.agentId],
    );
    const liveTokens = await pool.query(
      `SELECT count(*)::int AS n FROM project_tokens
       WHERE agent_id = $1 AND revoked_at IS NULL`,
      [fx.agentId],
    );

    expect(links.rows[0].n).toBe(0);
    expect(schedules.rows[0].n).toBe(0);
    expect(liveTokens.rows[0].n).toBe(0);

    // Idempotency contract: a second detach is a 404-shaped PRECONDITION.
    await expect(
      detachAgent({ projectId: fx.projectId, agentId: fx.agentId }, db),
    ).rejects.toMatchObject({ code: "PRECONDITION" });

    // The agent is attachable again afterwards.
    const again = await attachAgent(
      { projectId: fx.projectId, agentId: fx.agentId },
      db,
    );

    expect(again.linkId).toBeTruthy();
  });

  it("disabling the agent flips its schedules off + revokes tokens; re-enabling restores schedules, not tokens (T6.2)", async () => {
    // Self-contained: start from a clean attached link with two schedules.
    await detachAgent(
      { projectId: fx.projectId, agentId: fx.agentId },
      db,
    ).catch(() => undefined);
    await attachAgent({ projectId: fx.projectId, agentId: fx.agentId }, db);
    await updateAgentLink(
      {
        projectId: fx.projectId,
        agentId: fx.agentId,
        patch: {
          schedules: [
            { triggerType: "cron", cronExpr: "*/15 * * * *", timezone: "UTC" },
            { triggerType: "event", eventKinds: ["task.created"] },
          ],
        },
      },
      db,
    );
    await issueAgentRunToken({
      agentId: fx.agentId,
      projectId: fx.projectId,
      runId: randomUUID(),
      db,
    });

    // DISABLE → every schedule flipped off + every live token revoked. The link
    // row survives (disabled, not detached) so the bindings can be restored.
    await updateAgentLink(
      {
        projectId: fx.projectId,
        agentId: fx.agentId,
        patch: { enabled: false },
      },
      db,
    );

    const offRows = await pool.query(
      `SELECT enabled FROM agent_schedules WHERE agent_id = $1 AND project_id = $2`,
      [fx.agentId, fx.projectId],
    );

    expect(offRows.rows).toHaveLength(2);
    expect(offRows.rows.every((r) => r.enabled === false)).toBe(true);

    const liveAfterDisable = await pool.query(
      `SELECT count(*)::int AS n FROM project_tokens WHERE agent_id = $1 AND revoked_at IS NULL`,
      [fx.agentId],
    );

    expect(liveAfterDisable.rows[0].n).toBe(0);

    const linkAfterDisable = await pool.query(
      `SELECT enabled FROM agent_project_links WHERE agent_id = $1 AND project_id = $2`,
      [fx.agentId, fx.projectId],
    );

    expect(linkAfterDisable.rows[0].enabled).toBe(false);

    // RE-ENABLE → schedules restored; the revoked token is NOT resurrected.
    await updateAgentLink(
      {
        projectId: fx.projectId,
        agentId: fx.agentId,
        patch: { enabled: true },
      },
      db,
    );

    const onRows = await pool.query(
      `SELECT enabled FROM agent_schedules WHERE agent_id = $1 AND project_id = $2`,
      [fx.agentId, fx.projectId],
    );

    expect(onRows.rows).toHaveLength(2);
    expect(onRows.rows.every((r) => r.enabled === true)).toBe(true);

    const liveAfterEnable = await pool.query(
      `SELECT count(*)::int AS n FROM project_tokens WHERE agent_id = $1 AND revoked_at IS NULL`,
      [fx.agentId],
    );

    expect(liveAfterEnable.rows[0].n).toBe(0);
  });

  it("PATCH persists per-instance branchBase + executionPolicyOverride and clears each with null (T6.1)", async () => {
    await detachAgent(
      { projectId: fx.projectId, agentId: fx.agentId },
      db,
    ).catch(() => undefined);
    await attachAgent({ projectId: fx.projectId, agentId: fx.agentId }, db);

    // SET both instance overrides.
    await updateAgentLink(
      {
        projectId: fx.projectId,
        agentId: fx.agentId,
        patch: {
          branchBase: "develop",
          executionPolicyOverride: {
            autoApply: "full",
            onBudgetBreach: "terminate_restorable",
          },
        },
      },
      db,
    );

    let view = await getProjectAgentsView(fx.projectId, db);

    expect(view.attached[0].branchBase).toBe("develop");
    expect(view.attached[0].executionPolicyOverride).toEqual({
      autoApply: "full",
      onBudgetBreach: "terminate_restorable",
    });

    // A field omitted from the patch is untouched (SET/CLEAR symmetry):
    // overriding only the policy leaves branchBase as it was.
    await updateAgentLink(
      {
        projectId: fx.projectId,
        agentId: fx.agentId,
        patch: { executionPolicyOverride: { autoApply: "permissions" } },
      },
      db,
    );

    view = await getProjectAgentsView(fx.projectId, db);
    expect(view.attached[0].executionPolicyOverride).toEqual({
      autoApply: "permissions",
    });
    expect(view.attached[0].branchBase).toBe("develop");

    // CLEAR both with explicit null → effective resolution falls back to the
    // agent `recommended` (then project/platform default).
    await updateAgentLink(
      {
        projectId: fx.projectId,
        agentId: fx.agentId,
        patch: { branchBase: null, executionPolicyOverride: null },
      },
      db,
    );

    view = await getProjectAgentsView(fx.projectId, db);
    expect(view.attached[0].branchBase).toBeNull();
    expect(view.attached[0].executionPolicyOverride).toBeNull();
  });

  it("PATCH persists per-instance config and clears it with null (ADR-110 SET/CLEAR)", async () => {
    await detachAgent(
      { projectId: fx.projectId, agentId: fx.agentId },
      db,
    ).catch(() => undefined);
    await attachAgent({ projectId: fx.projectId, agentId: fx.agentId }, db);

    // Fresh attach → no instance config yet.
    let view = await getProjectAgentsView(fx.projectId, db);

    expect(view.attached[0].config).toBeNull();

    // SET the per-instance config in the one aggregating PATCH alongside another
    // field — proves it rides the same transaction, not a separate write.
    await updateAgentLink(
      {
        projectId: fx.projectId,
        agentId: fx.agentId,
        patch: {
          enabled: true,
          config: { auto_enqueue: "always", detect_duplicates: false },
        },
      },
      db,
    );

    view = await getProjectAgentsView(fx.projectId, db);
    expect(view.attached[0].config).toEqual({
      auto_enqueue: "always",
      detect_duplicates: false,
    });

    // A patch that omits config leaves the column untouched (SET/CLEAR symmetry).
    await updateAgentLink(
      {
        projectId: fx.projectId,
        agentId: fx.agentId,
        patch: { branchBase: "develop" },
      },
      db,
    );

    view = await getProjectAgentsView(fx.projectId, db);
    expect(view.attached[0].config).toEqual({
      auto_enqueue: "always",
      detect_duplicates: false,
    });

    // CLEAR with explicit null → column null → resolve falls back to declared
    // defaults.
    await updateAgentLink(
      {
        projectId: fx.projectId,
        agentId: fx.agentId,
        patch: { config: null },
      },
      db,
    );

    view = await getProjectAgentsView(fx.projectId, db);
    expect(view.attached[0].config).toBeNull();
  });

  it("rejects a per-instance config value that violates the declared schema (ADR-110)", async () => {
    await detachAgent(
      { projectId: fx.projectId, agentId: fx.agentId },
      db,
    ).catch(() => undefined);
    await attachAgent({ projectId: fx.projectId, agentId: fx.agentId }, db);

    // Out-of-range enum value → CONFIG.
    await expect(
      updateAgentLink(
        {
          projectId: fx.projectId,
          agentId: fx.agentId,
          patch: { config: { auto_enqueue: "bogus" } },
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    // Wrong scalar type for a boolean param → CONFIG.
    await expect(
      updateAgentLink(
        {
          projectId: fx.projectId,
          agentId: fx.agentId,
          patch: { config: { detect_duplicates: "yes" } },
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    // Unknown key → CONFIG.
    await expect(
      updateAgentLink(
        {
          projectId: fx.projectId,
          agentId: fx.agentId,
          patch: { config: { not_a_param: 1 } },
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    // None of the rejected writes touched the link — config stays null.
    const view = await getProjectAgentsView(fx.projectId, db);

    expect(view.attached[0].config).toBeNull();
  });

  it("validates config against the PINNED definition, not the global catalog (F1 version skew)", async () => {
    await detachAgent(
      { projectId: fx.projectId, agentId: fx.agentId },
      db,
    ).catch(() => undefined);
    await attachAgent({ projectId: fx.projectId, agentId: fx.agentId }, db);

    // `catalog_only_key` is declared in the GLOBAL catalog row but NOT in the
    // pinned definition the project runs → REJECTED. If validation used the
    // catalog (the skew bug) this would be accepted and then silently defaulted
    // at launch (which reads the pinned definition).
    await expect(
      updateAgentLink(
        {
          projectId: fx.projectId,
          agentId: fx.agentId,
          patch: { config: { catalog_only_key: true } },
        },
        db,
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    // `intake_mode` is declared ONLY in the pinned definition (absent from the
    // catalog) → ACCEPTED, proving the pinned .md is the validation source.
    await updateAgentLink(
      {
        projectId: fx.projectId,
        agentId: fx.agentId,
        patch: { config: { intake_mode: "clarify" } },
      },
      db,
    );

    const view = await getProjectAgentsView(fx.projectId, db);

    expect(view.attached[0].config).toEqual({ intake_mode: "clarify" });
  });
});
