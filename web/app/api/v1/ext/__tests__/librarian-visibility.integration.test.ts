import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { issueLibrarianTurnToken } from "@/lib/librarian/authority";
import { createTask } from "@/lib/services/tasks";
import { LIBRARIAN_TOKEN_SCOPES } from "@/types/token-scopes";
import { seedProjectRow, seedRun } from "@/test-support/execution-host-seed";
import {
  addProjectMember,
  seedLibrarianTurn,
  seedActiveUser,
} from "@/test-support/librarian-seed";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

// ADR-184 LAU-06: every cross-project read filters by the owner's visible
// projects BEFORE it aggregates, and a foreign project answers exactly like a
// missing one. Each case feeds data that DOES exist in a foreign project.

let database: StartedPostgresTestDb;
let db: NodePgDatabase;

vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

const fx = {
  ownerId: "",
  visible: { id: "", slug: "" },
  foreign: { id: "", slug: "" },
  token: "",
};

let routes: {
  projects: typeof import("@/app/api/v1/ext/projects/route");
  directory: typeof import("@/app/api/v1/ext/projects/[slug]/directory/route");
  search: typeof import("@/app/api/v1/ext/tasks/search/route");
  work: typeof import("@/app/api/v1/ext/work/route");
  feed: typeof import("@/app/api/v1/ext/activity/feed/route");
  decisions: typeof import("@/app/api/v1/ext/decisions/route");
};

function get(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "GET",
    headers: { authorization: `Bearer ${fx.token}` },
  });
}

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "librarian_visibility",
  });
  db = database.db as unknown as NodePgDatabase;

  fx.ownerId = await seedActiveUser(db);
  fx.visible = await seedProjectRow(db);
  fx.foreign = await seedProjectRow(db);
  await addProjectMember(db, {
    projectId: fx.visible.id,
    userId: fx.ownerId,
    role: "member",
  });

  for (const project of [fx.visible, fx.foreign]) {
    await createTask(
      { title: `Invoice payments ${project.slug}`, prompt: "Pay invoices" },
      { projectId: project.id, actorUserId: null },
      db,
    );
    await seedRun(db, {
      projectId: project.id,
      runKind: "flow",
      status: "Crashed",
    });
  }

  fx.token = (
    await issueLibrarianTurnToken(
      {
        ownerUserId: fx.ownerId,
        turnId: await seedLibrarianTurn(db, fx.ownerId),
        scopes: LIBRARIAN_TOKEN_SCOPES,
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
      db,
    )
  ).secret;

  routes = {
    projects: await import("@/app/api/v1/ext/projects/route"),
    directory: await import("@/app/api/v1/ext/projects/[slug]/directory/route"),
    search: await import("@/app/api/v1/ext/tasks/search/route"),
    work: await import("@/app/api/v1/ext/work/route"),
    feed: await import("@/app/api/v1/ext/activity/feed/route"),
    decisions: await import("@/app/api/v1/ext/decisions/route"),
  };
}, 180_000);

afterAll(async () => {
  await database?.stop();
});

function mentionsForeign(body: unknown): boolean {
  const text = JSON.stringify(body);

  return text.includes(fx.foreign.id) || text.includes(fx.foreign.slug);
}

describe("IT-LAU-06: reads never reveal a project the owner cannot see", () => {
  it("lists only visible projects", async () => {
    const res = await routes.projects.GET(get("/api/v1/ext/projects"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual([
      fx.visible.id,
    ]);
  });

  it("searches only visible tasks and reports no foreign hit or count", async () => {
    const res = await routes.search.GET(
      get("/api/v1/ext/tasks/search?q=invoice"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].projectSlug).toBe(fx.visible.slug);
    expect(body.truncated).toBe(false);
    expect(mentionsForeign(body)).toBe(false);
  });

  it("builds the work table from visible projects only", async () => {
    const res = await routes.work.GET(get("/api/v1/ext/work"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.projectCount).toBe(1);
    expect(body.rows.length).toBeGreaterThan(0);
    expect(mentionsForeign(body)).toBe(false);
  });

  it("builds the activity feed from visible projects only", async () => {
    const res = await routes.feed.GET(get("/api/v1/ext/activity/feed"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.rows.length).toBeGreaterThan(0);
    expect(mentionsForeign(body)).toBe(false);
  });

  it("reads the owner's own decision queue with no foreign item in list or count", async () => {
    const res = await routes.decisions.GET(get("/api/v1/ext/decisions"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(body.items.length);
    expect(body.items.length).toBeGreaterThan(0);
    expect(mentionsForeign(body)).toBe(false);
  });

  it("answers a foreign project's directory exactly like a missing one", async () => {
    const foreign = await routes.directory.GET(
      get(`/api/v1/ext/projects/${fx.foreign.slug}/directory`),
      { params: Promise.resolve({ slug: fx.foreign.slug }) },
    );
    const missing = await routes.directory.GET(
      get("/api/v1/ext/projects/nope/directory"),
      { params: Promise.resolve({ slug: `missing-${randomUUID()}` }) },
    );
    const visible = await routes.directory.GET(
      get(`/api/v1/ext/projects/${fx.visible.slug}/directory`),
      { params: Promise.resolve({ slug: fx.visible.slug }) },
    );

    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual(await missing.json());
    expect(visible.status).toBe(200);
    expect(await visible.json()).toMatchObject({
      project: { id: fx.visible.id, slug: fx.visible.slug },
      launchableFlows: [],
      triagerConfigured: false,
      brainEnabled: false,
    });
  });
});
