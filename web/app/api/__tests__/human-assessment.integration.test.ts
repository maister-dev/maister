import type { AnySchema } from "ajv";
import type { HumanAssessmentDraft } from "@/lib/tasks/human-assessment-schema";

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv from "ajv";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  GET,
  POST,
} from "@/app/api/projects/[slug]/tasks/[number]/human-assessment/route";
import { tasks } from "@/lib/db/schema";
import { QUALIFICATION_DIMENSIONS } from "@/lib/tasks/qualification-types";
import { seedTaskLaunchFixture } from "@/test-support/task-launch-admission";
import { mkdtempReal } from "@/test-support/worktree-test-root";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
let scope: { slug: string; number: string };
let actingUserId: string | null = null;
let schemas: Record<string, AnySchema>;
const ajv = new Ajv({ strict: false, validateFormats: false });

vi.mock("@/lib/db/client", () => ({ getDb: () => database.db }));
vi.mock("@/auth", () => ({
  auth: async () => (actingUserId ? { user: { id: actingUserId } } : null),
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "human_assessment_http",
  });
  root = await mkdtempReal("human-assessment-http-");
  const fixture = await seedTaskLaunchFixture(database, root);
  const taskId = randomUUID();

  await database.db.insert(tasks).values({
    id: taskId,
    projectId: fixture.projectId,
    number: 1,
    title: "Human reviewed request",
    prompt: "Describe the acceptance example.",
    flowId: fixture.flowId,
    runnerId: fixture.runnerId,
  });
  scope = { slug: fixture.projectId, number: taskId };
  actingUserId = fixture.userId;
  const api = await SwaggerParser.dereference(
    path.resolve("../docs/api/web.openapi.yaml"),
  );

  schemas = (
    api as unknown as { components: { schemas: Record<string, AnySchema> } }
  ).components.schemas;
}, 180_000);

afterAll(async () => {
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});

function contract(name: string, value: unknown): void {
  const validate = ajv.compile(schemas[name]);

  expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
}

function send(body: unknown, origin = "http://test"): Promise<Response> {
  return POST(
    new Request("http://test/human-assessment", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve(scope) },
  );
}

it("LA11 enforces active session and same origin before accepting the selector contract", async () => {
  const userId = actingUserId;

  actingUserId = null;
  expect((await send({ invalid: true })).status).toBe(401);
  actingUserId = userId;
  expect((await send({ invalid: true }, "http://foreign")).status).toBe(403);
  const response = await GET(new Request("http://test/human-assessment"), {
    params: Promise.resolve(scope),
  });
  const draft = (await response.json()) as HumanAssessmentDraft;

  expect(response.headers.get("cache-control")).toBe("no-store");
  contract("HumanTaskAssessmentDraft", draft);
  const request = {
    requestKey: randomUUID(),
    contextToken: draft.contextToken,
    expectedInputRevision: draft.expectedInputRevision,
    expectedQualificationRevision: draft.expectedQualificationRevision,
    repositoryToken: null,
    requestType: "feature",
    decision: "needs_information",
    evidence: [{ kind: "task", taskId: scope.number }],
    checks: QUALIFICATION_DIMENSIONS.map((dimension) => ({
      dimension,
      state: "unknown",
      rationale: "The current request needs a concrete acceptance example.",
      evidenceIndexes: [0],
    })),
    nextActions: ["Provide an input and expected output example."],
  };

  contract("HumanTaskAssessmentWrite", request);
  const accepted = await send(request);
  const receipt = await accepted.json();

  expect(accepted.status).toBe(200);
  contract("TaskQualificationReceipt", receipt);
  expect(await (await send(request)).json()).toEqual(receipt);
  const invalid = await send({
    ...request,
    requestKey: randomUUID(),
    checks: [],
  });
  const failure = await invalid.json();

  expect(invalid.status).toBe(400);
  contract("HumanTaskAssessmentError", failure);
  expect(failure.issues).toContainEqual({ path: "checks", key: "required" });
  expect((await send({ ...request, actorUserId: userId })).status).toBe(400);
  expect(
    (
      await GET(
        new Request("http://test/human-assessment?repository=1&repository=1"),
        { params: Promise.resolve(scope) },
      )
    ).status,
  ).toBe(400);
});
