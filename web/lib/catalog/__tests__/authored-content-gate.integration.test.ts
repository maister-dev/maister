/**
 * Integration test for T4.2: the per-kind CONTENT-validation hard-gate.
 *
 * The BLOCK subset of `validateArtifactContent` is wired into the draft-save
 * path ALONGSIDE the manifest hard-gate, BEFORE the `draft_version` CAS. A BLOCK
 * issue (e.g. a `schemas/*.json` that fails JSON.parse, or a skill/agent md with
 * missing frontmatter) throws `MaisterError("CONFIG")` (→ 422) and the row is
 * never mutated.
 *
 * Asserts BOTH save paths gate:
 *  - the `updateAuthoredFlowAction` server action funnels through
 *    `updateAuthoredDraft` after building the package body → driven here at the
 *    `updateAuthoredDraft` service seam (its shared sink).
 *  - the `PATCH /caps/[capId]/draft` route handler → driven directly with a
 *    mocked session + container DB.
 */
import type { AuthoredFlowPackageFile } from "@/lib/catalog/authored-types";

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
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createAuthoredCapability } from "@/lib/catalog/authored-service";
import { isMaisterError } from "@/lib/errors";
import * as schemaModule from "@/lib/db/schema";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase<typeof schemaModule>;
let updateAuthoredDraft: typeof import("@/lib/catalog/authored-service").updateAuthoredDraft;
let draftPATCH: typeof import("@/app/api/projects/[slug]/catalog/caps/[capId]/draft/route").PATCH;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const FORM_NODE_MANIFEST = {
  schemaVersion: 1,
  name: "content-gate-flow",
  compat: { engine_min: "1.2.0" },
  nodes: [
    {
      id: "collect",
      type: "form",
      settings: { form_schema: "schemas/review.json" },
      transitions: { success: "done" },
    },
  ],
};

const VALID_SCHEMA_FILE = JSON.stringify({
  schemaVersion: 1,
  fields: [{ name: "summary", type: "string", required: true }],
});

// Builds the persisted `AuthoredFlowPackageBody`-shaped object the save paths
// hand to `updateAuthoredDraft` (manifest + files + flowYaml are what the gate
// reads; the rest mirror the real body envelope but are not consulted).
function flowBody(args: {
  manifest: unknown;
  files: { path: string; content: string }[];
}): Record<string, unknown> {
  return {
    flowYaml: "schemaVersion: 1\nname: content-gate-flow\n",
    manifest: args.manifest,
    packageMetadata: { slug: "content-gate-flow", name: "Content Gate Flow" },
    files: args.files.map(
      (f): AuthoredFlowPackageFile => ({
        kind: "asset",
        path: f.path,
        content: f.content,
      }),
    ),
    validation: {
      status: "valid",
      issueCount: 0,
      issues: [],
      manifestDigest: null,
      contentHash: null,
    },
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("authored_content_gate_test")
    .withUsername("test")
    .withPassword("test")
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });

  ({ updateAuthoredDraft } = await import("@/lib/catalog/authored-service"));
  ({ PATCH: draftPATCH } = await import(
    "@/app/api/projects/[slug]/catalog/caps/[capId]/draft/route"
  ));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(() => {
  sessionRef.value = null;
});

async function seedAdminFlowCap(
  slugPrefix: string,
): Promise<{ projectSlug: string; capId: string; adminUserId: string }> {
  const projectSlug = `${slugPrefix}-${randomUUID()}`;
  const adminUserId = randomUUID();

  await db.insert(schemaModule.users).values({
    id: adminUserId,
    email: `admin-${adminUserId.slice(0, 8)}@example.test`,
    name: "Admin User",
    role: "admin",
    accountStatus: "active",
  });

  await db.insert(schemaModule.projects).values({
    id: randomUUID(),
    slug: projectSlug,
    name: projectSlug,
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    repoPath: `/tmp/${projectSlug}`,
    maisterYamlPath: `/tmp/${projectSlug}/maister.yaml`,
  });

  const { capability } = await createAuthoredCapability({
    projectSlug,
    input: {
      kind: "flow",
      slug: "editable-flow",
      title: "Editable Flow",
      body: flowBody({
        manifest: FORM_NODE_MANIFEST,
        files: [{ path: "schemas/review.json", content: VALID_SCHEMA_FILE }],
      }),
      manifest: FORM_NODE_MANIFEST,
    },
    db,
  });

  return { projectSlug, capId: capability.id, adminUserId };
}

async function readDraftVersion(capId: string): Promise<number> {
  const res = await db.execute(sql`
    SELECT draft_version FROM authored_capabilities WHERE id = ${capId} LIMIT 1
  `);
  const row = (res.rows ?? [])[0] as { draft_version: number } | undefined;

  return Number(row?.draft_version);
}

function patchRequest(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost/api/projects/p/catalog/caps/c/draft",
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("authored content-validation gate (T4.2)", () => {
  describe("server-action path (updateAuthoredDraft seam)", () => {
    it("rejects a BLOCK content issue with CONFIG and leaves the row unchanged", async () => {
      const { projectSlug, capId } =
        await seedAdminFlowCap("content-action-bad");
      const before = await readDraftVersion(capId);

      let thrown: unknown;

      try {
        await updateAuthoredDraft({
          projectSlug,
          capId,
          input: {
            title: "Editable Flow",
            body: flowBody({
              manifest: FORM_NODE_MANIFEST,
              files: [{ path: "schemas/review.json", content: "{ not json" }],
            }),
            manifest: FORM_NODE_MANIFEST,
            expectedDraftVersion: before,
          },
          db,
        });
      } catch (err) {
        thrown = err;
      }

      expect(isMaisterError(thrown)).toBe(true);
      expect((thrown as { code?: string }).code).toBe("CONFIG");
      // Gate runs BEFORE the CAS → draft_version untouched.
      expect(await readDraftVersion(capId)).toBe(before);
    });

    it("manifest-null + a file-level BLOCK still rejects with CONFIG, row unchanged (Gap 2)", async () => {
      const { projectSlug, capId } = await seedAdminFlowCap(
        "content-action-null-block",
      );
      const before = await readDraftVersion(capId);

      let thrown: unknown;

      try {
        await updateAuthoredDraft({
          projectSlug,
          capId,
          input: {
            title: "Editable Flow",
            // manifest does NOT parse → null. The manifest gate is skipped, but
            // the file-level BLOCK (skill md missing `description`) still fires.
            manifest: null,
            body: flowBody({
              manifest: null,
              files: [
                {
                  path: "skills/do/SKILL.md",
                  content: "---\nname: do-thing\n---\nbody",
                },
              ],
            }),
            expectedDraftVersion: before,
          },
          db,
        });
      } catch (err) {
        thrown = err;
      }

      expect(isMaisterError(thrown)).toBe(true);
      expect((thrown as { code?: string }).code).toBe("CONFIG");
      expect(await readDraftVersion(capId)).toBe(before);
    });

    it("a WARN-only body still SAVES and bumps draft_version (Gap 3)", async () => {
      const { projectSlug, capId } = await seedAdminFlowCap(
        "content-action-warn-only",
      );
      const before = await readDraftVersion(capId);

      await updateAuthoredDraft({
        projectSlug,
        capId,
        input: {
          title: "Editable Flow",
          body: flowBody({
            manifest: FORM_NODE_MANIFEST,
            files: [
              { path: "schemas/review.json", content: VALID_SCHEMA_FILE },
              // An unknown frontmatter key on a valid skill → WARN only.
              {
                path: "skills/do/SKILL.md",
                content:
                  "---\nname: do-thing\ndescription: Does the thing.\nunknown-key: 1\n---\nbody",
              },
            ],
          }),
          manifest: FORM_NODE_MANIFEST,
          expectedDraftVersion: before,
        },
        db,
      });

      expect(await readDraftVersion(capId)).toBe(before + 1);
    });

    it("accepts valid content and bumps draft_version", async () => {
      const { projectSlug, capId } =
        await seedAdminFlowCap("content-action-ok");
      const before = await readDraftVersion(capId);

      await updateAuthoredDraft({
        projectSlug,
        capId,
        input: {
          title: "Editable Flow",
          body: flowBody({
            manifest: FORM_NODE_MANIFEST,
            files: [
              { path: "schemas/review.json", content: VALID_SCHEMA_FILE },
            ],
          }),
          manifest: FORM_NODE_MANIFEST,
          expectedDraftVersion: before,
        },
        db,
      });

      expect(await readDraftVersion(capId)).toBe(before + 1);
    });
  });

  describe("PATCH /caps/[capId]/draft route path", () => {
    it("returns 422 on a BLOCK content issue and leaves the row unchanged", async () => {
      const { projectSlug, capId, adminUserId } =
        await seedAdminFlowCap("content-patch-bad");
      const before = await readDraftVersion(capId);

      sessionRef.value = { user: { id: adminUserId, role: "admin" } };

      const res = await draftPATCH(
        patchRequest({
          title: "Editable Flow",
          body: flowBody({
            manifest: FORM_NODE_MANIFEST,
            files: [
              { path: "skills/do/SKILL.md", content: "no frontmatter at all" },
            ],
          }),
          manifest: FORM_NODE_MANIFEST,
          expectedDraftVersion: before,
        }),
        { params: Promise.resolve({ slug: projectSlug, capId }) },
      );

      expect(res.status).toBe(422);
      const payload = await res.json();

      expect(payload.code).toBe("CONFIG");
      expect(await readDraftVersion(capId)).toBe(before);
    });

    it("returns 200 and bumps draft_version on valid content", async () => {
      const { projectSlug, capId, adminUserId } =
        await seedAdminFlowCap("content-patch-ok");
      const before = await readDraftVersion(capId);

      sessionRef.value = { user: { id: adminUserId, role: "admin" } };

      const res = await draftPATCH(
        patchRequest({
          title: "Editable Flow",
          body: flowBody({
            manifest: FORM_NODE_MANIFEST,
            files: [
              { path: "schemas/review.json", content: VALID_SCHEMA_FILE },
            ],
          }),
          manifest: FORM_NODE_MANIFEST,
          expectedDraftVersion: before,
        }),
        { params: Promise.resolve({ slug: projectSlug, capId }) },
      );

      expect(res.status).toBe(200);
      expect(await readDraftVersion(capId)).toBe(before + 1);
    });
  });
});
