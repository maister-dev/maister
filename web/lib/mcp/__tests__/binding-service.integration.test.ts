import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildResolvedCapabilitySet } from "@/lib/capabilities/resolver";
import { MaisterError } from "@/lib/errors";
import {
  connectPlatform,
  createBinding,
  deleteBinding,
  disconnectRef,
  loadProjectMcpBindings,
  updateBinding,
} from "@/lib/mcp/binding-service";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-129 (W-A/W-B/W-C): binding service + binding-aware resolution against real
// Postgres. Proves bind→load→snapshot provenance, disconnect→exclusion,
// grandfather zero-change, and the target/overlay validation contract.
//
// `platform_mcp_servers` is a GLOBAL (host-wide) catalog projected into
// capability_records with `capability_ref_id = <server id>` (projection.ts), so a
// platform target's ref IS its server id. Each test therefore binds the minted
// server id AS the ref — the realistic, coherent shape the resolver (select by
// (refId, source)) and the bind-time `target.refId === ref_id` guard both require.

type Db = NodePgDatabase;

let testDatabase: StartedPostgresTestDb;
let db: Db;

// The launch-frozen catalog for one ref: a platform candidate (sha "pf") shadows
// a project candidate (sha "pj") only when a binding forces it; otherwise project
// wins by precedence.
const catalogFor = (ref: string) => [
  { capabilityRefId: ref, kind: "mcp", source: "platform", revision: "pf" },
  { capabilityRefId: ref, kind: "mcp", source: "project", revision: "pj" },
];

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "maister_binding_test",
  });
  db = testDatabase.db;
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

const injected = () => ({
  execute: (q: Parameters<Db["execute"]>[0]) => db.execute(q),
});

async function seedProject(): Promise<string> {
  const projectId = randomUUID();

  await db.execute(sql`
    INSERT INTO projects (id, slug, name, repo_path, task_key)
    VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'Binding project',
            ${`/tmp/p-${projectId.slice(0, 8)}`}, ${`T${projectId.slice(0, 8)}`.toUpperCase()})
  `);

  return projectId;
}

async function seedPlatformServer(args: {
  enabled: boolean;
  trust: string;
  envKeys?: string[];
}): Promise<string> {
  const id = `srv-${randomUUID().slice(0, 8)}`;

  await db.execute(sql`
    INSERT INTO platform_mcp_servers (id, transport, command, env_keys, enabled, trust_status)
    VALUES (${id}, 'stdio', 'npx', ${JSON.stringify(args.envKeys ?? [])}::jsonb,
            ${args.enabled}, ${args.trust})
  `);

  return id;
}

async function seedProjectMcp(projectId: string, refId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO capability_records (
      id, project_id, capability_ref_id, kind, label, source, agents,
      enforceability, selected_by_default, selectable, material, created_at, updated_at
    )
    VALUES (${randomUUID()}, ${projectId}, ${refId}, 'mcp', ${refId}, 'project',
            ${JSON.stringify(["claude"])}::jsonb, 'enforced', true, true,
            ${JSON.stringify({ origin: "project-mcp", transport: "stdio", command: "npx", envKeys: ["GH_TOKEN"] })}::jsonb,
            now(), now())
  `);
}

function snapshotFor(
  mcpBindings: Awaited<ReturnType<typeof loadProjectMcpBindings>>,
  ref: string,
) {
  return buildResolvedCapabilitySet({
    records: catalogFor(ref),
    flowRevisionId: "r",
    flowOrigin: "git",
    mcpBindings,
  });
}

describe("binding-service — bind → load → resolve (W-A/W-B)", () => {
  it("an enabled binding to platform WINS over project precedence with provenance", async () => {
    const projectId = await seedProject();
    const ref = await seedPlatformServer({
      enabled: true,
      trust: "trusted",
      envKeys: ["env:GITHUB_TOKEN"],
    });

    await seedProjectMcp(projectId, ref);

    // Grandfather (no binding) → project wins by precedence.
    const grandfather = snapshotFor(
      await loadProjectMcpBindings(projectId, injected()),
      ref,
    );

    expect(grandfather.mcps).toEqual([
      {
        refId: ref,
        sha: "pj",
        scope: "project",
        provenance: "precedence",
      },
    ]);

    // Bind to platform → platform wins over precedence.
    await createBinding(
      projectId,
      { refId: ref, targetKind: "platform", targetId: ref },
      injected(),
    );
    const bound = snapshotFor(
      await loadProjectMcpBindings(projectId, injected()),
      ref,
    );

    expect(bound.mcps).toEqual([
      {
        refId: ref,
        sha: "pf",
        scope: "platform",
        provenance: "binding",
        boundTarget: { kind: "platform", id: ref },
      },
    ]);
  });

  it("disconnect makes the ref unresolvable, delete reverts to grandfather", async () => {
    const projectId = await seedProject();
    const ref = await seedPlatformServer({
      enabled: true,
      trust: "trusted",
    });

    await seedProjectMcp(projectId, ref);
    await connectPlatform(projectId, ref, ref, null, injected());

    await disconnectRef(projectId, ref, null, injected());
    const bindings = await loadProjectMcpBindings(projectId, injected());

    expect(bindings.find((b) => b.refId === ref)?.enabled).toBe(false);
    expect(snapshotFor(bindings, ref).mcps).toEqual([]);

    await deleteBinding(projectId, ref, injected());
    expect(
      snapshotFor(await loadProjectMcpBindings(projectId, injected()), ref)
        .mcps[0]?.provenance,
    ).toBe("precedence");
  });
});

describe("binding-service — validation contract", () => {
  it("refuses binding a disabled/untrusted platform target as executable (CONFLICT)", async () => {
    const projectId = await seedProject();
    const ref = await seedPlatformServer({
      enabled: false,
      trust: "untrusted",
    });

    await expect(
      createBinding(
        projectId,
        { refId: ref, targetKind: "platform", targetId: ref },
        injected(),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("refuses a cross-ref target that implements a different ref (CONFIG)", async () => {
    const projectId = await seedProject();
    const ref = await seedPlatformServer({ enabled: true, trust: "trusted" });

    // ref "github" bound to a platform server whose projected ref is `ref` — the
    // resolver selects by (refId, source), so this target would be silently
    // ignored at resolution; the bind-time guard refuses it up front.
    await expect(
      createBinding(
        projectId,
        { refId: "github", targetKind: "platform", targetId: ref },
        injected(),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });
  });

  it("refuses a missing target (CONFIG) and a duplicate binding (CONFLICT)", async () => {
    const projectId = await seedProject();
    const ref = await seedPlatformServer({
      enabled: true,
      trust: "trusted",
    });

    await expect(
      createBinding(
        projectId,
        { refId: "ghost", targetKind: "platform", targetId: "does-not-exist" },
        injected(),
      ),
    ).rejects.toMatchObject({ code: "CONFIG" });

    await createBinding(
      projectId,
      { refId: ref, targetKind: "platform", targetId: ref },
      injected(),
    );
    await expect(
      createBinding(
        projectId,
        { refId: ref, targetKind: "platform", targetId: ref },
        injected(),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("validates the overlay against the target's declared slots (unknown slot → CONFIG)", async () => {
    const projectId = await seedProject();
    const ref = await seedPlatformServer({
      enabled: true,
      trust: "trusted",
      envKeys: ["env:GITHUB_TOKEN"],
    });

    // Known slot → accepted.
    await createBinding(
      projectId,
      {
        refId: ref,
        targetKind: "platform",
        targetId: ref,
        configOverlay: { envRemap: { GITHUB_TOKEN: "env:PROJ_A_GH" } },
      },
      injected(),
    );

    // Unknown slot → CONFIG.
    let threw: MaisterError | null = null;

    try {
      await updateBinding(
        projectId,
        ref,
        { configOverlay: { envRemap: { NOT_A_SLOT: "env:X" } } },
        injected(),
      );
    } catch (err) {
      threw = err as MaisterError;
    }
    expect(threw?.code).toBe("CONFIG");
  });

  it("disconnect (disable) does not require the target to still resolve", async () => {
    // A soft-disable must not require the (possibly deleted/misconfigured)
    // dependency it disables: after connecting, delete the platform server, then
    // disconnect — it must still succeed and leave a disabled binding.
    const projectId = await seedProject();
    const ref = await seedPlatformServer({ enabled: true, trust: "trusted" });

    await connectPlatform(projectId, ref, ref, null, injected());
    await db.execute(sql`DELETE FROM platform_mcp_servers WHERE id = ${ref}`);

    await disconnectRef(projectId, ref, null, injected());
    const bindings = await loadProjectMcpBindings(projectId, injected());

    expect(bindings.find((b) => b.refId === ref)?.enabled).toBe(false);
  });
});
