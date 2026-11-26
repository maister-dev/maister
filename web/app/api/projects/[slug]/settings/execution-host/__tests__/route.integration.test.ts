import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { randomUUID } from "node:crypto";

import { afterEach, expect, it, vi } from "vitest";

import { closeDb } from "@/lib/db/client";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  addProjectMember,
  seedActiveUser,
} from "@/test-support/librarian-seed";
import { startMainPostgresTestDb } from "@/test-support/pg-container";

const session = vi.hoisted(() => ({ userId: "" }));

vi.mock("@/lib/authz", async (original) => {
  const actual = await original<typeof import("@/lib/authz")>();

  return {
    ...actual,
    requireActiveSession: () => actual.requireActiveUserById(session.userId),
  };
});

let database: StartedPostgresTestDb | undefined;

afterEach(async () => {
  await closeDb();
  vi.unstubAllEnvs();
  await database?.stop();
});

it("C-11 checks project authority and performs one composite-revision update", async () => {
  const { GET, PATCH } = await import("../route");
  database = await startMainPostgresTestDb({
    databaseName: "eh_project_preference",
  });
  const project = await seedProjectRow(database.db);
  const owner = await seedActiveUser(database.db);
  const member = await seedActiveUser(database.db);
  await addProjectMember(database.db, {
    projectId: project.id,
    userId: owner,
    role: "owner",
  });
  await addProjectMember(database.db, {
    projectId: project.id,
    userId: member,
    role: "member",
  });
  const hostId = randomUUID();
  const hostKey = `eh_${randomUUID()}`;
  await database.pool.query(
    `INSERT INTO execution_hosts (id, host_key, kind, display_name, transport, capabilities, readiness)
      VALUES ($1, $2, 'local_direct', 'Fixture supervisor', '{"kind":"local_direct"}', '{"workspaceProtocol":[1]}', 'ready')`,
    [hostId, hostKey],
  );
  vi.stubEnv("DB_URL", database.databaseUrl);
  vi.stubEnv("AUTH_URL", "http://maister.test");
  vi.stubEnv("MAISTER_SUPERVISOR_URL", "http://127.0.0.1:1");
  vi.stubEnv("MAISTER_SELECTED_EXECUTION_HOST_KEY", hostKey);
  vi.stubEnv(
    "MAISTER_SELECTED_EXECUTION_HOST_PROJECT_IDS",
    JSON.stringify([project.id]),
  );
  const url = `http://maister.test/api/projects/${project.slug}/settings/execution-host`;
  const params = { params: Promise.resolve({ slug: project.slug }) };
  const patch = (etag: string, defaultExecutionHostId: string | null) =>
    PATCH(
      new Request(url, {
        method: "PATCH",
        headers: {
          origin: "http://maister.test",
          "content-type": "application/json",
          "if-match": etag,
        },
        body: JSON.stringify({ defaultExecutionHostId }),
      }),
      params,
    );

  session.userId = member;
  expect((await GET(new Request(url), params)).status).toBe(403);
  expect((await patch("invalid", hostId)).status).toBe(403);
  session.userId = owner;
  const initial = await GET(new Request(url), params);
  expect(initial.status).toBe(200);
  const etag = initial.headers.get("etag");
  expect(etag).toMatch(/^"1:[a-f0-9]{64}"$/);
  if (!etag) throw new Error("GET did not return a project host revision");
  const forbidden = await patch(etag, randomUUID());
  expect(forbidden.status).toBe(409);
  expect(await forbidden.json()).toMatchObject({
    details: { reason: "host_ineligible" },
  });
  const changes = await Promise.all([patch(etag, hostId), patch(etag, hostId)]);
  expect(changes.map((response) => response.status).sort()).toEqual([200, 409]);
  const winner = changes.find((response) => response.ok);
  const saved = await winner?.json();
  expect(saved).toMatchObject({
    defaultExecutionHostId: hostId,
    preferenceRevision: 2,
  });
  expect(await changes.find((response) => !response.ok)?.json()).toMatchObject({
    details: { reason: "settings_revision_mismatch" },
  });
  const staleEligibility = winner?.headers.get("etag");
  if (!staleEligibility)
    throw new Error("PATCH did not return the new revision");
  vi.stubEnv("MAISTER_SELECTED_EXECUTION_HOST_PROJECT_IDS", "[]");
  expect((await patch(staleEligibility, null)).status).toBe(409);
  const refreshed = await GET(new Request(url), params);
  const currentTag = refreshed.headers.get("etag");
  if (!currentTag)
    throw new Error("GET did not return the new eligibility revision");
  expect(currentTag).not.toBe(staleEligibility);
  const cleared = await patch(currentTag, null);
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toMatchObject({
    defaultExecutionHostId: null,
    preferenceRevision: 3,
  });
}, 60_000);
