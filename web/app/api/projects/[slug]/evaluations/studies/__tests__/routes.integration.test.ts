import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import * as fullSchema from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const schema = fullSchema as unknown as Record<string, any>;

let testDatabase: StartedPostgresTestDb;
let db: NodePgDatabase<typeof fullSchema>;

const sessionRef: { value: unknown } = { value: null };

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => sessionRef.value),
  signIn: vi.fn(),
  signOut: vi.fn(),
  handlers: {},
}));
vi.mock("@/lib/db/client", () => ({ getDb: () => db }));

let studiesRoute: typeof import("../route");
let studyRoute: typeof import("../[studyId]/route");
let participantsRoute: typeof import("../[studyId]/participants/route");
let participantRoute: typeof import("../[studyId]/participants/[participantId]/route");
let verdictsRoute: typeof import("../[studyId]/verdicts/route");
let reviewRoute: typeof import("../../reviews/[reviewId]/route");
let startRoute: typeof import("../[studyId]/evaluations/route");
let streamRoute: typeof import("../[studyId]/stream/route");
let overrideRoute: typeof import("../../../evaluation-profiles/[profileId]/override/route");

let projectId: string;
let slug: string;
let taskId: string;
let flowRunId: string;
let adminId: string;
let viewerId: string;

function asAdmin(): void {
  sessionRef.value = { user: { id: adminId } };
}
function asViewer(): void {
  sessionRef.value = { user: { id: viewerId } };
}

function req(
  path: string,
  init?: { method?: string; body?: unknown; ifMatch?: string },
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (init?.ifMatch) headers["if-match"] = init.ifMatch;

  return new NextRequest(`http://localhost${path}`, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

beforeAll(async () => {
  testDatabase = await startMainPostgresTestDb({
    databaseName: "eval_study_routes_test",
  });
  db = testDatabase.db;

  studiesRoute = await import("../route");
  studyRoute = await import("../[studyId]/route");
  participantsRoute = await import("../[studyId]/participants/route");
  participantRoute = await import(
    "../[studyId]/participants/[participantId]/route"
  );
  verdictsRoute = await import("../[studyId]/verdicts/route");
  reviewRoute = await import("../../reviews/[reviewId]/route");
  startRoute = await import("../[studyId]/evaluations/route");
  streamRoute = await import("../[studyId]/stream/route");
  overrideRoute = await import(
    "../../../evaluation-profiles/[profileId]/override/route"
  );

  adminId = randomUUID();
  viewerId = randomUUID();
  await db.insert(schema.users).values([
    {
      id: adminId,
      email: `${adminId}@t.com`,
      role: "admin",
      accountStatus: "active",
      passwordHash: "x",
    },
    {
      id: viewerId,
      email: `${viewerId}@t.com`,
      role: "viewer",
      accountStatus: "active",
      passwordHash: "x",
    },
  ]);

  projectId = randomUUID();
  slug = `proj-${projectId.slice(0, 8)}`;
  await db.insert(schema.projects).values({
    taskKey: `T${randomUUID().slice(0, 8)}`.toUpperCase(),
    id: projectId,
    slug,
    name: "Test",
    repoPath: `/tmp/${slug}`,
    maisterYamlPath: "/tmp/m.yaml",
  });

  const flowId = randomUUID();

  await db.insert(schema.flows).values({
    id: flowId,
    projectId,
    flowRefId: "bugfix",
    source: "github.com/x/y",
    version: "v1.0.0",
    installedPath: "/tmp/flows/bugfix",
    manifest: { schemaVersion: 1, name: "Bugfix", nodes: [] },
    schemaVersion: 1,
  });

  taskId = randomUUID();
  await db.insert(schema.tasks).values({
    number: Number.parseInt(randomUUID().slice(0, 6), 16),
    id: taskId,
    projectId,
    title: "T",
    prompt: "p",
    flowId,
  });

  flowRunId = randomUUID();
  await db.insert(schema.runs).values({
    id: flowRunId,
    projectId,
    taskId,
    runKind: "flow",
    status: "Done",
    flowVersion: "v1",
    flowRevision: "manual",
    startedAt: new Date(),
  });
}, 180_000);

afterAll(async () => {
  await testDatabase?.stop();
});

beforeEach(() => {
  sessionRef.value = null;
});

describe("evaluation study/participant/verdict/review routes (T5)", () => {
  let studyId: string;

  it("creates, lists, and gets a study; refuses a viewer create (RBAC)", async () => {
    asAdmin();
    const created = await studiesRoute.POST(
      req(`/api/projects/${slug}/evaluations/studies`, {
        method: "POST",
        body: { taskId, title: "My Study", purpose: "compare" },
      }),
      { params: Promise.resolve({ slug }) },
    );

    expect(created.status).toBe(201);
    studyId = (await created.json()).study.id;

    const listed = await studiesRoute.GET(
      req(`/api/projects/${slug}/evaluations/studies`),
      { params: Promise.resolve({ slug }) },
    );
    const listBody = await listed.json();

    expect(listBody.studies.map((s: { id: string }) => s.id)).toContain(
      studyId,
    );

    const got = await studyRoute.GET(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}`),
      { params: Promise.resolve({ slug, studyId }) },
    );

    expect((await got.json()).study.title).toBe("My Study");

    // Viewer cannot create (manageEvaluationStudies is member-min).
    asViewer();
    const denied = await studiesRoute.POST(
      req(`/api/projects/${slug}/evaluations/studies`, {
        method: "POST",
        body: { taskId, title: "nope" },
      }),
      { params: Promise.resolve({ slug }) },
    );

    expect(denied.status).toBe(403);
  });

  it("PATCHes a study with If-Match, rejects stale + missing revision", async () => {
    asAdmin();

    const ok = await studyRoute.PATCH(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}`, {
        method: "PATCH",
        ifMatch: "1",
        body: { title: "Renamed" },
      }),
      { params: Promise.resolve({ slug, studyId }) },
    );

    expect(ok.status).toBe(200);
    expect((await ok.json()).study.version).toBe(2);

    // Stale revision → 409.
    const stale = await studyRoute.PATCH(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}`, {
        method: "PATCH",
        ifMatch: "1",
        body: { title: "again" },
      }),
      { params: Promise.resolve({ slug, studyId }) },
    );

    expect(stale.status).toBe(409);

    // Missing If-Match → 422.
    const noMatch = await studyRoute.PATCH(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}`, {
        method: "PATCH",
        body: { title: "x" },
      }),
      { params: Promise.resolve({ slug, studyId }) },
    );

    expect(noMatch.status).toBe(422);
  });

  it("hides a cross-project study id as 404", async () => {
    asAdmin();
    const other = randomUUID();

    const res = await studyRoute.GET(
      req(`/api/projects/${slug}/evaluations/studies/${other}`),
      { params: Promise.resolve({ slug, studyId: other }) },
    );

    expect(res.status).toBe(404);
  });

  it("adds an observed participant then removes it", async () => {
    asAdmin();

    const added = await participantsRoute.POST(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}/participants`, {
        method: "POST",
        body: { runIds: [flowRunId] },
      }),
      { params: Promise.resolve({ slug, studyId }) },
    );

    expect(added.status).toBe(201);
    const participantId = (await added.json()).participants[0].id;

    const listed = await participantsRoute.GET(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}/participants`),
      { params: Promise.resolve({ slug, studyId }) },
    );

    expect((await listed.json()).participants).toHaveLength(1);

    const removed = await participantRoute.DELETE(
      req(
        `/api/projects/${slug}/evaluations/studies/${studyId}/participants/${participantId}`,
        { method: "DELETE" },
      ),
      { params: Promise.resolve({ slug, studyId, participantId }) },
    );

    expect(removed.status).toBe(200);
    expect((await removed.json()).tombstoned).toBe(false);
  });

  it("records a zero-citation verdict only with the ack, then lists it", async () => {
    asAdmin();

    // Without the ack → 422 CONFIG.
    const noAck = await verdictsRoute.POST(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}/verdicts`, {
        method: "POST",
        body: {
          outcome: "inconclusive",
          participantIds: [],
          executionIds: [],
        },
      }),
      { params: Promise.resolve({ slug, studyId }) },
    );

    expect(noAck.status).toBe(422);

    // A verdict needs an OPEN study — flip draft→open by adding a participant.
    await participantsRoute.POST(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}/participants`, {
        method: "POST",
        body: { runIds: [flowRunId] },
      }),
      { params: Promise.resolve({ slug, studyId }) },
    );

    const ok = await verdictsRoute.POST(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}/verdicts`, {
        method: "POST",
        body: {
          outcome: "inconclusive",
          participantIds: [],
          executionIds: [],
          noEvaluationEvidenceAck: true,
          rationale: "no evaluations run",
        },
      }),
      { params: Promise.resolve({ slug, studyId }) },
    );

    expect(ok.status).toBe(201);

    const listed = await verdictsRoute.GET(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}/verdicts`),
      { params: Promise.resolve({ slug, studyId }) },
    );

    expect((await listed.json()).verdicts.length).toBeGreaterThanOrEqual(1);
  });

  it("guards the execution-start route (viewer 403, cross-project 404)", async () => {
    // Viewer lacks launchEvaluationRuns (member-min) → 403 before any start.
    asViewer();
    const denied = await startRoute.POST(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}/evaluations`, {
        method: "POST",
        body: { profileId: randomUUID() },
      }),
      { params: Promise.resolve({ slug, studyId }) },
    );

    expect(denied.status).toBe(403);

    // A cross-project studyId is hidden as 404 (ownership guard before start).
    asAdmin();
    const foreign = randomUUID();
    const notFound = await startRoute.POST(
      req(`/api/projects/${slug}/evaluations/studies/${foreign}/evaluations`, {
        method: "POST",
        body: { profileId: randomUUID() },
      }),
      { params: Promise.resolve({ slug, studyId: foreign }) },
    );

    expect(notFound.status).toBe(404);
  });

  it("resolves a review with If-Match; hides a cross-project review as 404", async () => {
    asAdmin();

    // Seed an execution + a required review directly.
    const executionId = randomUUID();

    await db.insert(schema.evaluationExecutions).values({
      id: executionId,
      studyId,
      status: "review_required",
    });

    const reviewId = randomUUID();

    await db.insert(schema.evaluationReviews).values({
      id: reviewId,
      executionId,
      kind: "disagreement",
      status: "required",
    });

    const resolved = await reviewRoute.PATCH(
      req(`/api/projects/${slug}/evaluations/reviews/${reviewId}`, {
        method: "PATCH",
        ifMatch: "1",
        body: { resolution: "accept", rationale: "reviewed" },
      }),
      { params: Promise.resolve({ slug, reviewId }) },
    );

    expect(resolved.status).toBe(200);

    const [row] = await db
      .select({ status: schema.evaluationReviews.status })
      .from(schema.evaluationReviews)
      .where(eq(schema.evaluationReviews.id, reviewId));

    expect(row.status).toBe("resolved");

    // Unknown review id → 404.
    const missing = await reviewRoute.PATCH(
      req(`/api/projects/${slug}/evaluations/reviews/${randomUUID()}`, {
        method: "PATCH",
        ifMatch: "1",
        body: { resolution: "accept" },
      }),
      { params: Promise.resolve({ slug, reviewId: randomUUID() }) },
    );

    expect(missing.status).toBe(404);
  });

  it("refuses unauthenticated requests 401-first without leaking project existence", async () => {
    // beforeEach left the session unset. Auth-first ordering: every handler
    // must return the SAME 401 for an existing and a missing slug — never a
    // 404/existence oracle before authentication.
    const missingSlug = `missing-${randomUUID().slice(0, 8)}`;
    const anyId = randomUUID();

    const existing = await studiesRoute.GET(
      req(`/api/projects/${slug}/evaluations/studies`),
      { params: Promise.resolve({ slug }) },
    );
    const missing = await studiesRoute.GET(
      req(`/api/projects/${missingSlug}/evaluations/studies`),
      { params: Promise.resolve({ slug: missingSlug }) },
    );

    expect(existing.status).toBe(401);
    expect(missing.status).toBe(401);

    const existingBody = await existing.json();

    expect(existingBody.code).toBe("UNAUTHENTICATED");
    expect(await missing.json()).toEqual(existingBody);

    const p = { slug: missingSlug, studyId: anyId };
    // Sequential on purpose: authz resolves the session via a dynamic
    // import("@/auth"), and concurrent first-hit dynamic imports can race past
    // the vi.mock registry into the real next-auth module.
    const calls: Array<[string, () => Promise<Response>]> = [
      [
        "studies POST",
        () =>
          studiesRoute.POST(
            req(`/api/projects/${missingSlug}/evaluations/studies`, {
              method: "POST",
              body: { taskId: anyId, title: "x" },
            }),
            { params: Promise.resolve({ slug: missingSlug }) },
          ),
      ],
      [
        "study GET",
        () =>
          studyRoute.GET(
            req(`/api/projects/${missingSlug}/evaluations/studies/${anyId}`),
            { params: Promise.resolve(p) },
          ),
      ],
      [
        "study PATCH",
        () =>
          studyRoute.PATCH(
            req(`/api/projects/${missingSlug}/evaluations/studies/${anyId}`, {
              method: "PATCH",
              ifMatch: "1",
              body: { title: "x" },
            }),
            { params: Promise.resolve(p) },
          ),
      ],
      [
        "participants GET",
        () =>
          participantsRoute.GET(
            req(
              `/api/projects/${missingSlug}/evaluations/studies/${anyId}/participants`,
            ),
            { params: Promise.resolve(p) },
          ),
      ],
      [
        "participants POST",
        () =>
          participantsRoute.POST(
            req(
              `/api/projects/${missingSlug}/evaluations/studies/${anyId}/participants`,
              { method: "POST", body: { runIds: [anyId] } },
            ),
            { params: Promise.resolve(p) },
          ),
      ],
      [
        "participant DELETE",
        () =>
          participantRoute.DELETE(
            req(
              `/api/projects/${missingSlug}/evaluations/studies/${anyId}/participants/${anyId}`,
              { method: "DELETE" },
            ),
            { params: Promise.resolve({ ...p, participantId: anyId }) },
          ),
      ],
      [
        "verdicts GET",
        () =>
          verdictsRoute.GET(
            req(
              `/api/projects/${missingSlug}/evaluations/studies/${anyId}/verdicts`,
            ),
            { params: Promise.resolve(p) },
          ),
      ],
      [
        "verdicts POST",
        () =>
          verdictsRoute.POST(
            req(
              `/api/projects/${missingSlug}/evaluations/studies/${anyId}/verdicts`,
              {
                method: "POST",
                body: { outcome: "tie", participantIds: [], executionIds: [] },
              },
            ),
            { params: Promise.resolve(p) },
          ),
      ],
      [
        "start POST",
        () =>
          startRoute.POST(
            req(
              `/api/projects/${missingSlug}/evaluations/studies/${anyId}/evaluations`,
              { method: "POST", body: { profileId: anyId } },
            ),
            { params: Promise.resolve(p) },
          ),
      ],
      [
        "stream GET",
        () =>
          streamRoute.GET(
            req(
              `/api/projects/${missingSlug}/evaluations/studies/${anyId}/stream`,
            ),
            { params: Promise.resolve(p) },
          ),
      ],
      [
        "review PATCH",
        () =>
          reviewRoute.PATCH(
            req(`/api/projects/${missingSlug}/evaluations/reviews/${anyId}`, {
              method: "PATCH",
              ifMatch: "1",
              body: { resolution: "accept" },
            }),
            {
              params: Promise.resolve({ slug: missingSlug, reviewId: anyId }),
            },
          ),
      ],
      [
        "override GET",
        () =>
          overrideRoute.GET(
            req(
              `/api/projects/${missingSlug}/evaluation-profiles/${anyId}/override`,
            ),
            {
              params: Promise.resolve({ slug: missingSlug, profileId: anyId }),
            },
          ),
      ],
      [
        "override PUT",
        () =>
          overrideRoute.PUT(
            req(
              `/api/projects/${missingSlug}/evaluation-profiles/${anyId}/override`,
              { method: "PUT", body: { overrides: {} } },
            ),
            {
              params: Promise.resolve({ slug: missingSlug, profileId: anyId }),
            },
          ),
      ],
      [
        "override DELETE",
        () =>
          overrideRoute.DELETE(
            req(
              `/api/projects/${missingSlug}/evaluation-profiles/${anyId}/override`,
              { method: "DELETE" },
            ),
            {
              params: Promise.resolve({ slug: missingSlug, profileId: anyId }),
            },
          ),
      ],
    ];

    for (const [label, call] of calls) {
      const res = await call();

      expect(res.status, label).toBe(401);
      expect(((await res.json()) as { code: string }).code, label).toBe(
        "UNAUTHENTICATED",
      );
    }
  });
});
