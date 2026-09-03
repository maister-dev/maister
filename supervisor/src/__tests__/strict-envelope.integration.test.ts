// ADR-166 T5.1 — the strict flip (E-EH-08 / X-EH-13): no envelope, no legacy
// path field, and no host-private path in the session projection.
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LEGACY_SESSION_PATH_FIELDS } from "../types";

import {
  adoptDirectory,
  bootHost,
  cleanupRuntimeRoot,
  createBody,
  createEnvelope,
  createSession,
  envelope,
  fenceFor,
  postJson,
  type BootedHost,
} from "./_fixtures/boot-host";

const booted: BootedHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const host of booted.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await cleanupRuntimeRoot(root);
});

async function host(): Promise<BootedHost> {
  const root = await mkdtemp(join(tmpdir(), "eh-strict-"));

  roots.push(root);
  const h = await bootHost({ runtimeRoot: root, fixtureArgs: ["--hang"] });

  booted.push(h);

  return h;
}

const PATH_KEYS = [
  "worktreePath",
  "repoPath",
  "confineRoot",
  "logPath",
  "contextMounts",
];

describe("strict envelope contract", () => {
  it("Z1: a bare create body (no envelope) is 409 PRECONDITION missing_envelope", async () => {
    const h = await host();
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const handle = await adoptDirectory(h, { runId });
    const res = await postJson(`${h.url}/sessions`, createBody(handle));

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "PRECONDITION",
      details: { reason: "missing_envelope" },
    });
    expect(h.registry.size()).toBe(0);
  });

  it("Z1b: every session command route refuses a bare body with missing_envelope", async () => {
    const h = await host();
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const { sessionId } = await createSession(h, { runId });
    const base = `${h.url}/sessions/${sessionId}`;
    const attempts: Array<[string, unknown, "POST" | "DELETE"]> = [
      [`${base}/prompt`, { stepId: "step-1", prompt: "hello" }, "POST"],
      [`${base}/cancel`, {}, "POST"],
      [`${base}/checkpoint`, {}, "POST"],
      [
        `${base}/input`,
        {
          kind: "permission",
          action: "select",
          requestId: randomUUID(),
          optionId: "allow",
        },
        "POST",
      ],
      [base, {}, "DELETE"],
    ];

    for (const [url, body, method] of attempts) {
      const res = await postJson(url, body, method);

      expect(res.status, url).toBe(409);
      expect(res.body.details, url).toEqual({ reason: "missing_envelope" });
    }
    expect(h.registry.get(sessionId)?.record.status).toBe("live");
  });

  it("Z2: an enveloped create carrying a legacy path field is 409 legacy_field naming the field", async () => {
    const h = await host();
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const handle = await adoptDirectory(h, { runId });
    const legacyValues: Record<
      (typeof LEGACY_SESSION_PATH_FIELDS)[number],
      unknown
    > = {
      runId,
      projectSlug: "demo",
      worktreePath: "/tmp/wt",
      repoPath: "/tmp/repo",
      confineRoot: "/tmp/confine",
      contextMounts: [],
    };

    for (const field of LEGACY_SESSION_PATH_FIELDS) {
      const res = await postJson(
        `${h.url}/sessions`,
        envelope(
          "session.create",
          fenceFor(h, runId),
          createBody(handle, { [field]: legacyValues[field] }),
        ),
      );

      expect(res.status, field).toBe(409);
      expect(res.body.details, field).toEqual({
        reason: "legacy_field",
        field,
      });
    }

    // The pre-ADR-166 body shape (paths, no handle) is refused by name too —
    // never as a generic unknown-key error.
    const legacyShape = await postJson(
      `${h.url}/sessions`,
      envelope("session.create", fenceFor(h, runId), {
        runId,
        projectSlug: "demo",
        worktreePath: "/tmp/wt",
        stepId: "step-1",
        executor: { agent: "claude", model: "claude-sonnet-4-6" },
      }),
    );

    expect(legacyShape.body.details).toEqual({
      reason: "legacy_field",
      field: "runId",
    });
    expect(h.registry.size()).toBe(0);
  });

  it("Z3: GET /sessions carries the handle + fence and no host-private path key", async () => {
    const h = await host();
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const commandId = randomUUID();
    const created = await postJson(
      `${h.url}/sessions`,
      await createEnvelope(h, { runId }, {}, commandId),
    );

    expect(created.status).toBe(201);
    const res = await fetch(`${h.url}/sessions`);
    const listed = (await res.json()) as Array<Record<string, unknown>>;

    expect(listed).toHaveLength(1);
    for (const key of PATH_KEYS) {
      expect(listed[0], key).not.toHaveProperty(key);
    }
    expect(listed[0]).toMatchObject({
      sessionId: created.body.sessionId,
      runId,
      projectSlug: "demo",
      stepId: "step-1",
      status: "live",
      executionWorkspaceId: expect.stringMatching(/^ws_[0-9a-f]{32}$/),
      assignmentEpoch: 1,
      createdByCommandId: commandId,
    });
  });
});
