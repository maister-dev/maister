import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  adoptDirectory,
  bootHost,
  cleanupRuntimeRoot,
  completePrompt,
  envelope,
  postJson,
  type BootedHost,
} from "./_fixtures/boot-host";

const booted: BootedHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const host of booted.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await cleanupRuntimeRoot(root);
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eh-runtime-objects-"));

  roots.push(root);

  return root;
}

async function oversizedUploadStatus(url: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const upload = request(url, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "26214401",
      },
    });

    upload.on("response", (response) => {
      response.resume();
      response.on("end", () => resolveStatus(response.statusCode ?? 0));
    });
    upload.on("error", reject);
    upload.end();
  });
}

async function publishObject(input: {
  host: BootedHost;
  fence: {
    hostKey: string;
    assignmentId: string;
    assignmentEpoch: number;
    runId: string;
  };
  kind: "capability_profile" | "capability_instructions";
  logicalName: string;
  content: string;
}): Promise<string> {
  const objectId = randomUUID();
  const bytes = Buffer.from(input.content, "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const reserved = await postJson(
    `${input.host.url}/runtime-objects`,
    envelope("runtime_object.reserve", input.fence, {
      objectId,
      kind: input.kind,
      logicalName: input.logicalName,
      mimeType:
        input.kind === "capability_profile"
          ? "application/json"
          : "text/markdown",
      sizeBytes: bytes.byteLength,
      sha256,
      generation: 1,
      retentionClass: "run",
    }),
  );

  expect(reserved.status).toBe(201);
  const uploaded = await fetch(
    `${input.host.url}/runtime-objects/${objectId}/content`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
        "content-digest": `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`,
        "x-maister-command-id": randomUUID(),
        "x-maister-command-issued-at": new Date().toISOString(),
        "x-maister-assignment-id": input.fence.assignmentId,
        "x-maister-assignment-epoch": String(input.fence.assignmentEpoch),
        "x-maister-object-generation": "1",
        "x-maister-sha256": sha256,
      },
      body: bytes,
    },
  );

  expect(uploaded.status).toBe(200);

  return objectId;
}

describe("runtime object transport", () => {
  it("resolves typed capability inputs without accepting a caller path or wrong object kind", async () => {
    const host = await bootHost({ runtimeRoot: await tempRoot() });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const fence = {
      hostKey: host.hostState.hostKey,
      assignmentId: randomUUID(),
      assignmentEpoch: 1,
      runId,
    };
    const executionWorkspaceId = await adoptDirectory(host, fence);
    const capabilityProfileObjectId = await publishObject({
      host,
      fence,
      kind: "capability_profile",
      logicalName: "profile.json",
      content: '{"version":1}',
    });
    const capabilityInstructionsObjectId = await publishObject({
      host,
      fence,
      kind: "capability_instructions",
      logicalName: "instructions.md",
      content: "# Instructions\n",
    });
    const payload = {
      executionWorkspaceId,
      stepId: "plan",
      executor: { agent: "claude", model: "claude-sonnet-4-6" },
      capabilityProfileObjectId,
      capabilityInstructionsObjectId,
    };
    const created = await postJson(
      `${host.url}/sessions`,
      envelope("session.create", fence, payload),
    );
    const wrongKind = await postJson(
      `${host.url}/sessions`,
      envelope("session.create", fence, {
        ...payload,
        capabilityProfileObjectId: capabilityInstructionsObjectId,
      }),
    );

    expect(created.status).toBe(201);
    expect(wrongKind.status).toBe(409);
    expect(wrongKind.body).toMatchObject({
      code: "PRECONDITION",
      details: { reason: "command_invariant_conflict" },
    });
    expect(JSON.stringify(created.body)).not.toContain(host.runtimeRoot);
    await postJson(
      `${host.url}/sessions/${String(created.body.sessionId)}`,
      envelope("session.delete", fence, {}),
      "DELETE",
    );
  });

  it("allocates host-private output paths and seals typed objects into the prompt receipt", async () => {
    const plan = "# Durable plan\n";
    const review = JSON.stringify({ schemaVersion: 1, decisions: [] });
    const host = await bootHost({
      runtimeRoot: await tempRoot(),
      fixtureArgs: [
        "--hang",
        "--write-env",
        "MAISTER_PLAN_DOCUMENT_FILE",
        plan,
        "--write-env",
        "MAISTER_PLAN_REVIEW_FILE",
        review,
      ],
    });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const assignmentId = randomUUID();
    const fence = {
      hostKey: host.hostState.hostKey,
      assignmentId,
      assignmentEpoch: 1,
      runId,
    };
    const executionWorkspaceId = await adoptDirectory(host, fence);
    const planObjectId = randomUUID();
    const reviewObjectId = randomUUID();
    const created = await postJson(
      `${host.url}/sessions`,
      envelope("session.create", fence, {
        executionWorkspaceId,
        stepId: "plan",
        executor: { agent: "claude", model: "claude-sonnet-4-6" },
        outputObjects: [
          {
            objectId: planObjectId,
            kind: "plan_review",
            logicalName: "plan-document.md",
            mimeType: "text/markdown",
            generation: 1,
            retentionClass: "run",
            envName: "MAISTER_PLAN_DOCUMENT_FILE",
          },
          {
            objectId: reviewObjectId,
            kind: "plan_review",
            logicalName: "plan-review.json",
            mimeType: "application/json",
            generation: 1,
            retentionClass: "run",
            envName: "MAISTER_PLAN_REVIEW_FILE",
          },
        ],
      }),
    );

    expect(created.status).toBe(201);

    const completed = await completePrompt(
      host,
      created.body.sessionId as string,
      envelope("session.prompt", fence, {
        stepId: "plan",
        prompt: "write the plan outputs",
      }),
    );
    const runtimeObjects = completed.body.runtimeObjects as Array<
      Record<string, unknown>
    >;
    const planContent = await fetch(
      `${host.url}/runtime-objects/${planObjectId}/content`,
    );
    const reviewContent = await fetch(
      `${host.url}/runtime-objects/${reviewObjectId}/content`,
    );

    expect(completed.status).toBe(200);
    expect(runtimeObjects).toEqual([
      expect.objectContaining({
        objectId: planObjectId,
        state: "available",
        sizeBytes: Buffer.byteLength(plan),
      }),
      expect.objectContaining({
        objectId: reviewObjectId,
        state: "available",
        sizeBytes: Buffer.byteLength(review),
      }),
    ]);
    expect(await planContent.text()).toBe(plan);
    expect(await reviewContent.text()).toBe(review);
    expect(JSON.stringify(completed.body)).not.toContain(host.runtimeRoot);
    await postJson(
      `${host.url}/sessions/${String(created.body.sessionId)}`,
      envelope("session.delete", fence, {}),
      "DELETE",
    );
  });

  it("binds every reservation metadata field and enforces retention expiry symmetry", async () => {
    const host = await bootHost({ runtimeRoot: await tempRoot() });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const objectId = randomUUID();
    const fence = {
      hostKey: host.hostState.hostKey,
      assignmentId: randomUUID(),
      assignmentEpoch: 1,
      runId,
    };
    const basePayload = {
      objectId,
      kind: "evidence",
      logicalName: "verification.json",
      mimeType: "application/json",
      sizeBytes: 11,
      sha256: "a".repeat(64),
      generation: 1,
      retentionClass: "ephemeral",
      expiresAt: "2026-09-05T00:00:00.000Z",
    };
    const created = await postJson(
      `${host.url}/runtime-objects`,
      envelope("runtime_object.reserve", fence, basePayload),
    );

    expect(created.status).toBe(201);
    for (const changed of [
      { mimeType: "text/plain" },
      { sizeBytes: 12 },
      { sha256: "b".repeat(64) },
      { retentionClass: "run", expiresAt: null },
      { expiresAt: "2026-09-06T00:00:00.000Z" },
    ]) {
      const conflict = await postJson(
        `${host.url}/runtime-objects`,
        envelope("runtime_object.reserve", fence, {
          ...basePayload,
          ...changed,
        }),
      );

      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({
        code: "PRECONDITION",
        details: { reason: "command_invariant_conflict" },
      });
    }

    const invalidExpiry = await postJson(
      `${host.url}/runtime-objects`,
      envelope("runtime_object.reserve", fence, {
        ...basePayload,
        objectId: randomUUID(),
        retentionClass: "run",
      }),
    );

    expect(invalidExpiry.status).toBe(409);
    expect(invalidExpiry.body).toMatchObject({ code: "PRECONDITION" });

    const missingExpiry = await postJson(
      `${host.url}/runtime-objects`,
      envelope("runtime_object.reserve", fence, {
        ...basePayload,
        objectId: randomUUID(),
        expiresAt: null,
      }),
    );

    expect(missingExpiry.status).toBe(409);
    expect(missingExpiry.body).toMatchObject({ code: "PRECONDITION" });
    expect(
      await oversizedUploadStatus(
        `${host.url}/runtime-objects/${randomUUID()}/content`,
      ),
    ).toBe(413);
  });

  it("stores bytes only on the host while receipts, opaque metadata, events, and bounded reads stay fenced", async () => {
    const host = await bootHost({ runtimeRoot: await tempRoot() });

    booted.push(host);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    const objectId = randomUUID();
    const assignmentId = randomUUID();
    const reserveId = randomUUID();
    const fence = {
      hostKey: host.hostState.hostKey,
      assignmentId,
      assignmentEpoch: 1,
      runId,
    };
    const reserve = envelope(
      "runtime_object.reserve",
      fence,
      {
        objectId,
        kind: "evidence",
        logicalName: "verification.json",
        mimeType: "application/json",
        sizeBytes: 11,
        sha256:
          "4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93",
        generation: 1,
        retentionClass: "run",
      },
      reserveId,
    );
    const reserved = await postJson(`${host.url}/runtime-objects`, reserve);
    const replayed = await postJson(`${host.url}/runtime-objects`, reserve);
    const payload = Buffer.from('{"ok":true}', "utf8");
    const checksum = createHash("sha256").update(payload).digest("hex");
    const digest = `sha-256=:${Buffer.from(checksum, "hex").toString("base64")}:`;
    const uploadCommandId = randomUUID();

    host.hostState.putReceipt({
      commandId: uploadCommandId,
      runId,
      kind: "runtime_object.upload",
      assignmentId,
      epoch: 1,
      hostSessionId: objectId,
      requestDigest: null,
      eventId: null,
      phase: "accepted",
      httpStatus: 202,
      body: {},
      receivedAt: new Date().toISOString(),
      completedAt: null,
    });
    const uploadHeaders = {
      "content-type": "application/octet-stream",
      "content-length": String(payload.byteLength),
      "content-digest": digest,
      "x-maister-command-id": uploadCommandId,
      "x-maister-command-issued-at": new Date(0).toISOString(),
      "x-maister-assignment-id": assignmentId,
      "x-maister-assignment-epoch": "1",
      "x-maister-object-generation": "1",
      "x-maister-sha256": checksum,
    };
    const uploaded = await fetch(
      `${host.url}/runtime-objects/${objectId}/content`,
      {
        method: "PUT",
        headers: uploadHeaders,
        body: payload,
      },
    );
    const uploadedBody = (await uploaded.json()) as Record<string, unknown>;
    const uploadReplay = await fetch(
      `${host.url}/runtime-objects/${objectId}/content`,
      { method: "PUT", headers: uploadHeaders, body: payload },
    );
    const ranged = await fetch(
      `${host.url}/runtime-objects/${objectId}/content`,
      {
        headers: { range: "bytes=0-1" },
      },
    );
    const suffixRange = await fetch(
      `${host.url}/runtime-objects/${objectId}/content`,
      { headers: { range: "bytes=-1" } },
    );
    const beyondEndRange = await fetch(
      `${host.url}/runtime-objects/${objectId}/content`,
      { headers: { range: `bytes=${payload.byteLength}-` } },
    );
    const newerObjectId = randomUUID();
    const newerFence = {
      ...fence,
      assignmentId: randomUUID(),
      assignmentEpoch: fence.assignmentEpoch + 1,
    };

    await postJson(
      `${host.url}/runtime-objects`,
      envelope("runtime_object.reserve", newerFence, {
        objectId: newerObjectId,
        kind: "generated_artifact",
        logicalName: "newer.txt",
        mimeType: "text/plain",
        sizeBytes: payload.byteLength,
        sha256: checksum,
        generation: 1,
        retentionClass: "run",
        expiresAt: null,
      }),
    );
    const deleted = await postJson(
      `${host.url}/runtime-objects/${objectId}`,
      envelope("runtime_object.delete", fence, { generation: 1 }),
      "DELETE",
    );
    const outbox = host.hostState.runtimeEventsAfter(
      host.hostState.getRuntimeEventStreamId(),
      null,
    );

    expect(reserved.status).toBe(201);
    expect(reserved.body).toMatchObject({ objectId, state: "pending" });
    expect(replayed.status).toBe(201);
    expect(replayed.headers.get("x-maister-command-replayed")).toBe("true");
    expect(uploaded.status).toBe(200);
    expect(uploaded.headers.get("x-maister-command-replayed")).toBeNull();
    expect(uploadReplay.status).toBe(200);
    expect(uploadReplay.headers.get("x-maister-command-replayed")).toBe("true");
    expect(uploadedBody).toMatchObject({
      objectId,
      state: "available",
      sha256: checksum,
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(
      `bytes 0-1/${payload.byteLength}`,
    );
    expect(ranged.headers.get("content-digest")).toBe(digest);
    expect(ranged.headers.get("etag")).toBe(`"${checksum}"`);
    expect(Buffer.from(await ranged.arrayBuffer()).toString("utf8")).toBe('{"');
    expect(suffixRange.status).toBe(416);
    expect(await suffixRange.json()).toMatchObject({
      code: "PRECONDITION",
      details: { reason: "runtime_object_range_invalid" },
    });
    expect(beyondEndRange.status).toBe(416);
    expect(deleted.status).toBe(204);
    expect(host.hostState.getRuntimeObject(objectId)?.state).toBe("deleted");
    expect(host.hostState.getReceipt(reserveId)?.eventId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(outbox.map((event) => event.envelope.eventType)).toEqual([
      "runtime_object.state",
      "runtime_object.available",
      "runtime_object.state",
      "runtime_object.state",
    ]);
    expect(JSON.stringify(outbox)).not.toContain("runtime-objects/");
  });
});
