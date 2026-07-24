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

// The controlled-launch batch routes kick the drive async; stub it to a no-op so
// the route contract (create/read/retry) is tested without the launch stack. The
// lib's own drive is covered by launch-batch.integration.test.ts.
vi.mock("@/lib/evaluations/launch-seam", () => ({
  defaultLaunchRunSeam: () => async () => ({ runId: "stub-run" }),
}));
vi.mock("@/lib/evaluations/launch-batch", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/evaluations/launch-batch")>();

  return { ...actual, runControlledLaunchBatch: async () => ({}) };
});

let studiesRoute: typeof import("../route");
let studyRoute: typeof import("../[studyId]/route");
let participantsRoute: typeof import("../[studyId]/participants/route");
let participantRoute: typeof import("../[studyId]/participants/[participantId]/route");
let verdictsRoute: typeof import("../[studyId]/verdicts/route");
let reviewRoute: typeof import("../../reviews/[reviewId]/route");
let startRoute: typeof import("../[studyId]/evaluations/route");
let streamRoute: typeof import("../[studyId]/stream/route");
let preflightRoute: typeof import("../[studyId]/launch-preflight/route");
let batchesRoute: typeof import("../[studyId]/launch-batches/route");
let batchRoute: typeof import("../[studyId]/launch-batches/[batchId]/route");
let batchRetryRoute: typeof import("../[studyId]/launch-batches/[batchId]/retry/route");
let pinOptionsRoute: typeof import("../../pin-options/route");
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
  init?: {
    method?: string;
    body?: unknown;
    // Raw (possibly malformed) body bytes — bypasses JSON.stringify.
    rawBody?: string;
    ifMatch?: string;
  },
): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (init?.ifMatch) headers["if-match"] = init.ifMatch;

  const body =
    init?.rawBody !== undefined
      ? init.rawBody
      : init?.body === undefined
        ? undefined
        : JSON.stringify(init.body);

  return new NextRequest(`http://localhost${path}`, {
    method: init?.method ?? "GET",
    headers,
    body,
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
  preflightRoute = await import("../[studyId]/launch-preflight/route");
  batchesRoute = await import("../[studyId]/launch-batches/route");
  batchRoute = await import("../[studyId]/launch-batches/[batchId]/route");
  batchRetryRoute = await import("../[studyId]/launch-batches/[batchId]/retry/route");
  pinOptionsRoute = await import("../../pin-options/route");
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

  it("surfaces a superseding verdict as current: newest-first, supersede pointer intact, history append-only", async () => {
    asAdmin();

    // The zero-citation test above decided the study with one standing
    // verdict — the current head is the only verdict nothing supersedes.
    const before = await verdictsRoute.GET(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}/verdicts`),
      { params: Promise.resolve({ slug, studyId }) },
    );
    const priorVerdicts = (
      (await before.json()) as {
        verdicts: Array<{ id: string; supersedesId: string | null }>;
      }
    ).verdicts;
    const superseded = new Set(
      priorVerdicts.map((v) => v.supersedesId).filter(Boolean),
    );
    const heads = priorVerdicts.filter((v) => !superseded.has(v.id));

    expect(heads).toHaveLength(1);
    const supersededId = heads[0].id;

    // A decided study refuses a NEW verdict that does not supersede the
    // standing one (mere recency can never win).
    const noSupersede = await verdictsRoute.POST(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}/verdicts`, {
        method: "POST",
        body: {
          outcome: "inconclusive",
          participantIds: [],
          executionIds: [],
          noEvaluationEvidenceAck: true,
          rationale: "not a correction",
        },
      }),
      { params: Promise.resolve({ slug, studyId }) },
    );

    expect(noSupersede.status).toBe(422);

    // A correction without a rationale is refused (422 CONFIG).
    const noRationale = await verdictsRoute.POST(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}/verdicts`, {
        method: "POST",
        body: {
          outcome: "tie",
          participantIds: [],
          executionIds: [],
          noEvaluationEvidenceAck: true,
          supersedesId: supersededId,
        },
      }),
      { params: Promise.resolve({ slug, studyId }) },
    );

    expect(noRationale.status).toBe(422);

    const second = await verdictsRoute.POST(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}/verdicts`, {
        method: "POST",
        body: {
          outcome: "tie",
          participantIds: [],
          executionIds: [],
          noEvaluationEvidenceAck: true,
          supersedesId: supersededId,
          rationale: "corrected after re-reading the evidence",
        },
      }),
      { params: Promise.resolve({ slug, studyId }) },
    );

    expect(second.status).toBe(201);
    const supersedingId = (await second.json()).id as string;

    const listed = await verdictsRoute.GET(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}/verdicts`),
      { params: Promise.resolve({ slug, studyId }) },
    );
    const { verdicts } = (await listed.json()) as {
      verdicts: Array<{ id: string; supersedesId: string | null }>;
    };

    // Newest-first: the SUPERSEDING verdict is the current head — an
    // asc-ordered read would surface the very first verdict instead.
    expect(verdicts[0].id).toBe(supersedingId);
    expect(verdicts[0].supersedesId).toBe(supersededId);

    // Append-only: the superseded verdict stays in the history, and nothing
    // supersedes the current head.
    expect(verdicts.map((v) => v.id)).toContain(supersededId);
    expect(verdicts.some((v) => v.supersedesId === supersedingId)).toBe(false);

    // No forks: superseding the SAME verdict a second time is refused (409).
    const fork = await verdictsRoute.POST(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}/verdicts`, {
        method: "POST",
        body: {
          outcome: "inconclusive",
          participantIds: [],
          executionIds: [],
          noEvaluationEvidenceAck: true,
          supersedesId: supersededId,
          rationale: "competing correction",
        },
      }),
      { params: Promise.resolve({ slug, studyId }) },
    );

    expect(fork.status).toBe(409);
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

  it("returns 401 (never 422/404) for an unauthenticated request with a MALFORMED body — auth precedes body parse", async () => {
    // beforeEach left the session unset. If a handler read/parsed the body
    // before authenticating, a malformed body would leak a 422 to an anonymous
    // caller; the auth-first contract pins the 401.
    const rawBody = "{definitely not json";
    const anyId = randomUUID();
    const p = { slug, studyId: anyId };

    const calls: Array<[string, () => Promise<Response>]> = [
      [
        "studies POST",
        () =>
          studiesRoute.POST(
            req(`/api/projects/${slug}/evaluations/studies`, {
              method: "POST",
              rawBody,
            }),
            { params: Promise.resolve({ slug }) },
          ),
      ],
      [
        "study PATCH",
        () =>
          studyRoute.PATCH(
            req(`/api/projects/${slug}/evaluations/studies/${anyId}`, {
              method: "PATCH",
              ifMatch: "1",
              rawBody,
            }),
            { params: Promise.resolve(p) },
          ),
      ],
      [
        "participants POST",
        () =>
          participantsRoute.POST(
            req(
              `/api/projects/${slug}/evaluations/studies/${anyId}/participants`,
              { method: "POST", rawBody },
            ),
            { params: Promise.resolve(p) },
          ),
      ],
      [
        "verdicts POST",
        () =>
          verdictsRoute.POST(
            req(`/api/projects/${slug}/evaluations/studies/${anyId}/verdicts`, {
              method: "POST",
              rawBody,
            }),
            { params: Promise.resolve(p) },
          ),
      ],
      [
        "start POST",
        () =>
          startRoute.POST(
            req(
              `/api/projects/${slug}/evaluations/studies/${anyId}/evaluations`,
              { method: "POST", rawBody },
            ),
            { params: Promise.resolve(p) },
          ),
      ],
      [
        "review PATCH",
        () =>
          reviewRoute.PATCH(
            req(`/api/projects/${slug}/evaluations/reviews/${anyId}`, {
              method: "PATCH",
              ifMatch: "1",
              rawBody,
            }),
            { params: Promise.resolve({ slug, reviewId: anyId }) },
          ),
      ],
      [
        "override PUT",
        () =>
          overrideRoute.PUT(
            req(`/api/projects/${slug}/evaluation-profiles/${anyId}/override`, {
              method: "PUT",
              rawBody,
            }),
            { params: Promise.resolve({ slug, profileId: anyId }) },
          ),
      ],
    ];

    // Sequential on purpose (see the auth-first sweep above).
    for (const [label, call] of calls) {
      const res = await call();

      expect(res.status, label).toBe(401);
      expect(((await res.json()) as { code: string }).code, label).toBe(
        "UNAUTHENTICATED",
      );
    }
  });
});

describe("launch-preflight route (ADR-150)", () => {
  let preflightStudyId: string;

  beforeAll(async () => {
    asAdmin();
    const created = await studiesRoute.POST(
      req(`/api/projects/${slug}/evaluations/studies`, {
        method: "POST",
        body: { taskId, title: "Preflight Study" },
      }),
      { params: Promise.resolve({ slug }) },
    );

    preflightStudyId = (await created.json()).study.id;
  });

  function call(
    studyId: string,
    body: unknown,
  ): Promise<Response> {
    return preflightRoute.POST(
      req(
        `/api/projects/${slug}/evaluations/studies/${studyId}/launch-preflight`,
        { method: "POST", body },
      ),
      { params: Promise.resolve({ slug, studyId: studyId }) },
    );
  }

  it("401 without a session", async () => {
    sessionRef.value = null;
    const res = await call(preflightStudyId, { recipes: [{}] });

    expect(res.status).toBe(401);
  });

  it("403 for a member below launchEvaluationRuns", async () => {
    asViewer();
    const res = await call(preflightStudyId, { recipes: [{}] });

    expect(res.status).toBe(403);
  });

  it("404 for a cross-project / unknown study", async () => {
    asAdmin();
    const res = await call(randomUUID(), { recipes: [{}] });

    expect(res.status).toBe(404);
  });

  it("422 for a malformed body (empty recipes)", async () => {
    asAdmin();
    const res = await call(preflightStudyId, { recipes: [] });

    expect(res.status).toBe(422);
  });

  it("422 for an unknown top-level key", async () => {
    asAdmin();
    const res = await call(preflightStudyId, { recipes: [{}], extra: 1 });

    expect(res.status).toBe(422);
  });
});

describe("launch-batches routes (ADR-150)", () => {
  let batchStudyId: string;
  let recipeId: string;
  let otherStudyId: string;
  let otherRecipeId: string;

  const validRecipe = {
    schemaVersion: 1,
    flow: {
      flowRefId: "bugfix",
      flowRevisionId: "rev-1",
      inputContractDigest: "d-in",
      artifactContractDigest: "d-art",
    },
    inputs: { taskSnapshotRef: "snap", formValues: {} },
    executionPolicy: { preset: "supervised" },
  };

  async function seedStudy(): Promise<string> {
    asAdmin();
    const created = await studiesRoute.POST(
      req(`/api/projects/${slug}/evaluations/studies`, {
        method: "POST",
        body: { taskId, title: "Batch Study" },
      }),
      { params: Promise.resolve({ slug }) },
    );

    return (await created.json()).study.id;
  }

  async function seedRecipe(studyId: string, key: string): Promise<string> {
    const [row] = await db
      .insert(schema.evaluationRecipes)
      .values({
        studyId,
        key,
        label: key,
        definition: validRecipe,
        definitionDigest: `digest-${key}`,
      })
      .returning({ id: schema.evaluationRecipes.id });

    return row.id as string;
  }

  beforeAll(async () => {
    batchStudyId = await seedStudy();
    recipeId = await seedRecipe(batchStudyId, "variant-a");
    otherStudyId = await seedStudy();
    otherRecipeId = await seedRecipe(otherStudyId, "variant-x");
  });

  function createCall(studyId: string, body: unknown): Promise<Response> {
    return batchesRoute.POST(
      req(`/api/projects/${slug}/evaluations/studies/${studyId}/launch-batches`, {
        method: "POST",
        body,
      }),
      { params: Promise.resolve({ slug, studyId }) },
    );
  }

  it("creates a batch (201) and reads it back with one queued item", async () => {
    asAdmin();
    const res = await createCall(batchStudyId, { items: [{ recipeId }] });

    expect(res.status).toBe(201);
    const { batchId, deduped, itemCount } = await res.json();

    expect(deduped).toBe(false);
    expect(itemCount).toBe(1);

    asAdmin();
    const read = await batchRoute.GET(
      req(
        `/api/projects/${slug}/evaluations/studies/${batchStudyId}/launch-batches/${batchId}`,
      ),
      { params: Promise.resolve({ slug, studyId: batchStudyId, batchId }) },
    );

    expect(read.status).toBe(200);
    const batch = await read.json();

    expect(batch.items).toHaveLength(1);
    expect(batch.items[0].recipeId).toBe(recipeId);
  });

  it("dedups an identical idempotency key (deduped: true)", async () => {
    asAdmin();
    const body = { idempotencyKey: "k-1", items: [{ recipeId }] };
    const first = await createCall(batchStudyId, body);
    const second = await createCall(batchStudyId, body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await second.json()).deduped).toBe(true);
  });

  it("409s a recipe from another study (cross-resource guard)", async () => {
    asAdmin();
    const res = await createCall(batchStudyId, { items: [{ recipeId: otherRecipeId }] });

    expect(res.status).toBe(404);
  });

  it("403s a viewer (below launchEvaluationRuns)", async () => {
    asViewer();
    const res = await createCall(batchStudyId, { items: [{ recipeId }] });

    expect(res.status).toBe(403);
  });

  it("422s an empty items list", async () => {
    asAdmin();
    const res = await createCall(batchStudyId, { items: [] });

    expect(res.status).toBe(422);
  });

  it("422s when the kill switch is off", async () => {
    asAdmin();
    process.env.MAISTER_CONTROLLED_RECIPES_ENABLED = "false";
    try {
      const res = await createCall(batchStudyId, { items: [{ recipeId }] });

      expect(res.status).toBe(422);
    } finally {
      delete process.env.MAISTER_CONTROLLED_RECIPES_ENABLED;
    }
  });

  it("retry returns 200 requeued:0 when nothing failed", async () => {
    asAdmin();
    const created = await createCall(batchStudyId, {
      idempotencyKey: "k-retry",
      items: [{ recipeId }],
    });
    const { batchId } = await created.json();

    asAdmin();
    const res = await batchRetryRoute.POST(
      req(
        `/api/projects/${slug}/evaluations/studies/${batchStudyId}/launch-batches/${batchId}/retry`,
        { method: "POST" },
      ),
      { params: Promise.resolve({ slug, studyId: batchStudyId, batchId }) },
    );

    expect(res.status).toBe(200);
    expect((await res.json()).requeued).toBe(0);
  });
});

describe("pin-options route (ADR-150)", () => {
  function call(query: string): Promise<Response> {
    return pinOptionsRoute.GET(
      req(`/api/projects/${slug}/evaluations/pin-options${query}`),
      { params: Promise.resolve({ slug }) },
    );
  }

  it("401 without a session", async () => {
    sessionRef.value = null;
    expect((await call(`?taskId=${taskId}`)).status).toBe(401);
  });

  it("403 for a viewer", async () => {
    asViewer();
    expect((await call(`?taskId=${taskId}`)).status).toBe(403);
  });

  it("422 when taskId is missing", async () => {
    asAdmin();
    expect((await call("")).status).toBe(422);
  });

  it("422 for a task outside the project", async () => {
    asAdmin();
    expect((await call(`?taskId=${randomUUID()}`)).status).toBe(422);
  });

  it("200 with server-filtered options for a project task", async () => {
    asAdmin();
    const res = await call(`?taskId=${taskId}`);

    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).options)).toBe(true);
  });
});
