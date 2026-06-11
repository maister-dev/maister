// RED test: the route at
//   web/app/api/projects/[slug]/flow-packages/[flowRefId]/revisions/[revisionId]/fork/route.ts
// (and its service web/lib/catalog/seed-from-revision.ts) does not exist yet.
// This file fails with "Cannot find module" until T2.2 is implemented.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { updateAuthoredDraft } from "@/lib/catalog/authored-service";
import * as schemaModule from "@/lib/db/schema";
import { isMaisterError } from "@/lib/errors";

const schema = schemaModule as unknown as Record<string, any>;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;

// Mutable session identity, swapped per test (graph route pattern).
const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let POST: typeof import("@/app/api/projects/[slug]/flow-packages/[flowRefId]/revisions/[revisionId]/fork/route").POST;

const PROJECT_A_ID = randomUUID();
const PROJECT_A_SLUG = `proj-fork-${randomUUID()}`;
const PROJECT_B_ID = randomUUID();
const PROJECT_B_SLUG = `proj-fork-other-${randomUUID()}`;

// A valid graph-form flow.yaml WITH a presentation block — proves presentation
// survives the fork because it lives verbatim in the seeded flowYaml text.
const FLOW_YAML = `schemaVersion: 1
name: bugfix
compat:
  engine_min: "1.2.0"
nodes:
  - id: work
    type: ai_coding
    action:
      prompt: "/aif-implement"
    transitions:
      success: done
presentation:
  nodes:
    work:
      x: 120
      y: 240
`;

const MANIFEST_JSON = {
  schemaVersion: 1,
  name: "bugfix",
  compat: { engine_min: "1.2.0" },
  nodes: [
    {
      id: "work",
      type: "ai_coding",
      action: { prompt: "/aif-implement" },
      transitions: { success: "done" },
    },
  ],
};

let bundleDir: string;
let missingBundleDir: string;

// flow + revision ids per project.
const FLOW_A_ID = randomUUID();
const REVISION_A_ID = randomUUID();
const FLOW_B_ID = randomUUID();
const REVISION_B_ID = randomUUID();
// A revision under PROJECT_A whose installed_path is gone (422 case).
const REVISION_A_MISSING_ID = randomUUID();

function makeRequest(
  slug: string,
  flowRefId: string,
  revisionId: string,
  body?: unknown,
): NextRequest {
  return new NextRequest(
    `http://localhost/api/projects/${slug}/flow-packages/${flowRefId}/revisions/${revisionId}/fork`,
    {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

function params(slug: string, flowRefId: string, revisionId: string) {
  return { params: Promise.resolve({ slug, flowRefId, revisionId }) };
}

function fakeSha(): string {
  return randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40);
}

async function readDraftVersion(capId: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT draft_version FROM authored_capabilities WHERE id = ${capId} LIMIT 1
  `);
  const row = (res.rows ?? [])[0] as { draft_version: number } | undefined;

  return Number(row?.draft_version);
}

async function writeBundle(dir: string): Promise<void> {
  await writeFile(join(dir, "flow.yaml"), FLOW_YAML, "utf8");
  await mkdir(join(dir, "skills", "do-thing"), { recursive: true });
  await writeFile(
    join(dir, "skills", "do-thing", "SKILL.md"),
    "---\nname: do-thing\ndescription: does the thing\n---\nbody\n",
    "utf8",
  );
}

async function seedFlowRevision(args: {
  flowRefId: string;
  source: string;
  flowId: string;
  revisionId: string;
  projectId: string;
  installedPath: string;
}): Promise<void> {
  await db.insert(schema.flowRevisions).values({
    id: args.revisionId,
    flowRefId: args.flowRefId,
    source: args.source,
    versionLabel: "v1.0.0",
    resolvedRevision: fakeSha(),
    manifestDigest: `sha256:${randomUUID()}`,
    manifest: MANIFEST_JSON,
    schemaVersion: 1,
    installedPath: args.installedPath,
    packageStatus: "Installed",
    setupStatus: "done",
    execTrust: "untrusted",
  });
  await db.insert(schema.flows).values({
    id: args.flowId,
    projectId: args.projectId,
    flowRefId: args.flowRefId,
    source: args.source,
    version: "v1.0.0",
    installedPath: args.installedPath,
    manifest: MANIFEST_JSON,
    schemaVersion: 1,
    enabledRevisionId: args.revisionId,
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("fork_route_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  bundleDir = await mkdtemp(join(tmpdir(), "fork-bundle-"));
  await writeBundle(bundleDir);
  missingBundleDir = join(tmpdir(), `fork-missing-${randomUUID()}`);

  await db.insert(schema.projects).values([
    {
      id: PROJECT_A_ID,
      slug: PROJECT_A_SLUG,
      name: PROJECT_A_SLUG,
      repoPath: `/tmp/${PROJECT_A_SLUG}`,
      maisterYamlPath: `/tmp/${PROJECT_A_SLUG}/maister.yaml`,
    },
    {
      id: PROJECT_B_ID,
      slug: PROJECT_B_SLUG,
      name: PROJECT_B_SLUG,
      repoPath: `/tmp/${PROJECT_B_SLUG}`,
      maisterYamlPath: `/tmp/${PROJECT_B_SLUG}/maister.yaml`,
    },
  ]);

  await db.insert(schema.users).values([
    {
      id: "u-admin",
      email: "admin@test.com",
      role: "admin",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-viewer",
      email: "viewer@test.com",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
    {
      id: "u-cap-admin",
      email: "cap-admin@test.com",
      role: "member",
      passwordHash: "x",
      accountStatus: "active",
    },
  ]);

  await db.insert(schema.projectMembers).values([
    {
      id: randomUUID(),
      projectId: PROJECT_A_ID,
      userId: "u-viewer",
      role: "viewer",
    },
    {
      id: randomUUID(),
      projectId: PROJECT_A_ID,
      userId: "u-cap-admin",
      role: "admin",
    },
  ]);

  await seedFlowRevision({
    flowRefId: "bugfix",
    source: "github.com/org/maister-flow-bugfix",
    flowId: FLOW_A_ID,
    revisionId: REVISION_A_ID,
    projectId: PROJECT_A_ID,
    installedPath: bundleDir,
  });

  // A second revision of the SAME flow whose dir is gone → 422.
  await db.insert(schema.flowRevisions).values({
    id: REVISION_A_MISSING_ID,
    flowRefId: "bugfix",
    source: "github.com/org/maister-flow-bugfix",
    versionLabel: "v0.9.0",
    resolvedRevision: fakeSha(),
    manifestDigest: `sha256:${randomUUID()}`,
    manifest: MANIFEST_JSON,
    schemaVersion: 1,
    installedPath: missingBundleDir,
    packageStatus: "Installed",
    setupStatus: "done",
    execTrust: "untrusted",
  });

  // A flow + revision in PROJECT_B (foreign revisionId case).
  await seedFlowRevision({
    flowRefId: "other-flow",
    source: "github.com/org/maister-flow-other",
    flowId: FLOW_B_ID,
    revisionId: REVISION_B_ID,
    projectId: PROJECT_B_ID,
    installedPath: bundleDir,
  });

  ({ POST } = await import(
    "@/app/api/projects/[slug]/flow-packages/[flowRefId]/revisions/[revisionId]/fork/route"
  ));
}, 180_000);

afterAll(async () => {
  await rm(bundleDir, { recursive: true, force: true });
  await pool?.end();
  await container?.stop();
});

describe("POST .../revisions/[revisionId]/fork (integration)", () => {
  it("forks an installed revision into an authored flow draft with lineage", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const res = await POST(
      makeRequest(PROJECT_A_SLUG, "bugfix", REVISION_A_ID),
      params(PROJECT_A_SLUG, "bugfix", REVISION_A_ID),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.slug).toBe("bugfix");
    expect(body.projectSlug).toBe(PROJECT_A_SLUG);
    expect(typeof body.capId).toBe("string");
    // Response is an explicit DTO — no installedPath / manifest / DB row leak.
    expect(body).toEqual({
      capId: body.capId,
      projectSlug: PROJECT_A_SLUG,
      slug: "bugfix",
    });

    const capRows = await db.execute(sql`
      SELECT source_flow_ref_id, kind
      FROM authored_capabilities
      WHERE id = ${body.capId}
      LIMIT 1
    `);
    const cap = (capRows.rows ?? [])[0] as Record<string, unknown> | undefined;

    expect(cap?.kind).toBe("flow");
    expect(cap?.source_flow_ref_id).toBe("bugfix");

    // Presentation is carried because it lives in the seeded flowYaml text.
    const revRows = await db.execute(sql`
      SELECT body
      FROM authored_capability_revisions
      WHERE capability_id = ${body.capId}
      ORDER BY revision_number DESC
      LIMIT 1
    `);
    const rev = (revRows.rows ?? [])[0] as
      | { body?: { flowYaml?: string } }
      | undefined;

    expect(rev?.body?.flowYaml).toContain("presentation:");
    expect(rev?.body?.flowYaml).toContain("x: 120");

    // §8.2.10: the fork executes NOTHING — the source revision's exec_trust is
    // never flipped by forking.
    const trustRows = await db.execute(sql`
      SELECT exec_trust FROM flow_revisions WHERE id = ${REVISION_A_ID} LIMIT 1
    `);

    expect((trustRows.rows ?? [])[0]).toMatchObject({
      exec_trust: "untrusted",
    });
  });

  it("probes -fork when the default slug already exists", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const res = await POST(
      makeRequest(PROJECT_A_SLUG, "bugfix", REVISION_A_ID),
      params(PROJECT_A_SLUG, "bugfix", REVISION_A_ID),
    );
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.slug).toBe("bugfix-fork");
  });

  it("returns 409 CONFLICT when an EXPLICIT slug collides (no probe)", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const res = await POST(
      makeRequest(PROJECT_A_SLUG, "bugfix", REVISION_A_ID, { slug: "bugfix" }),
      params(PROJECT_A_SLUG, "bugfix", REVISION_A_ID),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("CONFLICT");
  });

  it("returns 422 CONFIG when the bundle dir is missing/unreadable, without leaking the path", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const res = await POST(
      makeRequest(PROJECT_A_SLUG, "bugfix", REVISION_A_MISSING_ID),
      params(PROJECT_A_SLUG, "bugfix", REVISION_A_MISSING_ID),
    );
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.code).toBe("CONFIG");
    // §3.1: the server-only installedPath MUST NOT appear in the response body.
    expect(JSON.stringify(body)).not.toContain(missingBundleDir);
    expect(JSON.stringify(body)).not.toMatch(/\/(tmp|Users|home|var|root)\//);
  });

  it("returns 404 for a revisionId that belongs to another flow/project", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const res = await POST(
      makeRequest(PROJECT_A_SLUG, "bugfix", REVISION_B_ID),
      params(PROJECT_A_SLUG, "bugfix", REVISION_B_ID),
    );

    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown flowRefId", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const res = await POST(
      makeRequest(PROJECT_A_SLUG, "ghost-flow", REVISION_A_ID),
      params(PROJECT_A_SLUG, "ghost-flow", REVISION_A_ID),
    );

    expect(res.status).toBe(404);
  });

  it("returns 403 for a project viewer (below manageCatalog)", async () => {
    sessionRef.value = { user: { id: "u-viewer", role: "member" } };

    const res = await POST(
      makeRequest(PROJECT_A_SLUG, "bugfix", REVISION_A_ID),
      params(PROJECT_A_SLUG, "bugfix", REVISION_A_ID),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for an unauthenticated request", async () => {
    sessionRef.value = null;

    const res = await POST(
      makeRequest(PROJECT_A_SLUG, "bugfix", REVISION_A_ID),
      params(PROJECT_A_SLUG, "bugfix", REVISION_A_ID),
    );

    expect(res.status).toBe(401);
  });

  it("fork-then-first-save: a frontmatter-less skill AUX file forks AND saves (only skills/**/SKILL.md is gated)", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const auxBundleDir = await mkdtemp(join(tmpdir(), "fork-bundle-aux-"));
    const revisionId = randomUUID();

    try {
      await writeBundle(auxBundleDir);
      await mkdir(join(auxBundleDir, "skills", "do-thing", "references"), {
        recursive: true,
      });
      await writeFile(
        join(auxBundleDir, "skills", "do-thing", "references", "notes.md"),
        "plain reference notes, no frontmatter\n",
        "utf8",
      );
      await seedFlowRevision({
        flowRefId: "aux-pack",
        source: "github.com/org/maister-flow-aux",
        flowId: randomUUID(),
        revisionId,
        projectId: PROJECT_A_ID,
        installedPath: auxBundleDir,
      });

      const res = await POST(
        makeRequest(PROJECT_A_SLUG, "aux-pack", revisionId),
        params(PROJECT_A_SLUG, "aux-pack", revisionId),
      );
      const body = await res.json();

      expect(res.status).toBe(201);

      // First save of the UNCHANGED forked draft: the aux file must not block.
      const before = await readDraftVersion(body.capId);

      await updateAuthoredDraft({
        projectSlug: PROJECT_A_SLUG,
        capId: body.capId,
        input: { expectedDraftVersion: before },
        db,
      });

      expect(await readDraftVersion(body.capId)).toBe(before + 1);
    } finally {
      await rm(auxBundleDir, { recursive: true, force: true });
    }
  });

  it("fork-then-first-save: a SKILL.md missing description forks (no gate at fork) but the first save is CONFIG-blocked", async () => {
    sessionRef.value = { user: { id: "u-admin", role: "admin" } };

    const gatedBundleDir = await mkdtemp(join(tmpdir(), "fork-bundle-gated-"));
    const revisionId = randomUUID();

    try {
      await writeFile(join(gatedBundleDir, "flow.yaml"), FLOW_YAML, "utf8");
      await mkdir(join(gatedBundleDir, "skills", "broken"), {
        recursive: true,
      });
      await writeFile(
        join(gatedBundleDir, "skills", "broken", "SKILL.md"),
        "---\nname: broken\n---\nbody\n",
        "utf8",
      );
      await seedFlowRevision({
        flowRefId: "gated-pack",
        source: "github.com/org/maister-flow-gated",
        flowId: randomUUID(),
        revisionId,
        projectId: PROJECT_A_ID,
        installedPath: gatedBundleDir,
      });

      const res = await POST(
        makeRequest(PROJECT_A_SLUG, "gated-pack", revisionId),
        params(PROJECT_A_SLUG, "gated-pack", revisionId),
      );
      const body = await res.json();

      // The content gate does NOT run at fork — a violating bundle still forks.
      expect(res.status).toBe(201);

      const before = await readDraftVersion(body.capId);
      let thrown: unknown;

      try {
        await updateAuthoredDraft({
          projectSlug: PROJECT_A_SLUG,
          capId: body.capId,
          input: { expectedDraftVersion: before },
          db,
        });
      } catch (err) {
        thrown = err;
      }

      expect(isMaisterError(thrown)).toBe(true);
      expect((thrown as { code?: string }).code).toBe("CONFIG");
      expect((thrown as Error).message).toContain(
        "[frontmatter_field_missing]",
      );
      // Gate runs BEFORE the CAS → draft_version untouched.
      expect(await readDraftVersion(body.capId)).toBe(before);
    } finally {
      await rm(gatedBundleDir, { recursive: true, force: true });
    }
  });
});
