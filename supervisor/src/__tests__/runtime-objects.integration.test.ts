import { once } from "node:events";
import * as filesystem from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  rename,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeObjectRegistry } from "../runtime-objects";

import {
  adoptDirectory,
  bootHost,
  cleanupRuntimeRoot,
  completePrompt,
  envelope,
  postJson,
  type BootedHost,
} from "./_fixtures/boot-host";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});

const booted: BootedHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

async function integrityObject(content = "sealed original bytes") {
  const host = await bootHost({ runtimeRoot: await tempRoot() });

  booted.push(host);
  const fence = {
    hostKey: host.hostState.hostKey,
    assignmentId: randomUUID(),
    assignmentEpoch: 1,
    runId: `run-${randomUUID().slice(0, 8)}`,
  };

  await adoptDirectory(host, fence);
  const objectId = await publishObject({
    host,
    fence,
    kind: "capability_instructions",
    logicalName: "instructions.md",
    content,
  });
  const object = host.hostState.getRuntimeObject(objectId)!;

  return {
    host,
    fence,
    objectId,
    object,
    objects: new RuntimeObjectRegistry(
      host.hostState,
      dirname(object.privatePath),
    ),
  };
}

describe("runtime object transport", () => {
  it.each(["tamper", "truncate", "unlink", "symlink", "replace"] as const)(
    "persists %s read failure before returning a typed error without a projector",
    async (mutation) => {
      const host = await bootHost({ runtimeRoot: await tempRoot() });

      booted.push(host);
      const fence = {
        hostKey: host.hostState.hostKey,
        assignmentId: randomUUID(),
        assignmentEpoch: 1,
        runId: `run-${randomUUID().slice(0, 8)}`,
      };

      await adoptDirectory(host, fence);
      const original = "sealed original bytes";
      const objectId = await publishObject({
        host,
        fence,
        kind: "capability_instructions",
        logicalName: "instructions.md",
        content: original,
      });
      const object = host.hostState.getRuntimeObject(objectId)!;

      if (mutation === "tamper")
        await writeFile(object.privatePath, "x".repeat(original.length));
      if (mutation === "truncate") await truncate(object.privatePath, 1);
      if (mutation === "unlink") await unlink(object.privatePath);
      if (mutation === "replace" || mutation === "symlink") {
        await rename(object.privatePath, `${object.privatePath}.original`);
        if (mutation === "replace")
          await writeFile(object.privatePath, original);
        else
          await symlink(`${object.privatePath}.original`, object.privatePath);
      }
      const abort = new AbortController();
      const response = await fetch(
        `${host.url}/runtime-objects/${objectId}/content`,
        { signal: abort.signal, headers: { connection: "close" } },
      );
      const failure = response.status === 409 ? await response.json() : null;

      abort.abort();
      expect(response.status).toBe(409);
      expect(failure).toMatchObject({
        code: "PRECONDITION",
        details: {
          reason:
            mutation === "unlink"
              ? "runtime_object_missing"
              : "runtime_object_integrity_mismatch",
        },
      });
      expect(response.headers.has("content-digest")).toBe(false);
      const expectedState = mutation === "unlink" ? "missing" : "corrupt";

      expect(host.hostState.getRuntimeObject(objectId)).toMatchObject({
        state: expectedState,
        sha256: object.sha256,
        sizeBytes: object.sizeBytes,
      });
      const events = host.hostState.pendingRuntimeEvents(
        host.hostState.getRuntimeEventStreamId(),
      );

      expect(events.map((event) => event.envelope)).toContainEqual(
        expect.objectContaining({
          eventType: "runtime_object.state",
          payload: expect.objectContaining({ objectId, state: expectedState }),
        }),
      );
      await host.stop();
      booted.splice(booted.indexOf(host), 1);
      const restarted = await bootHost({
        runtimeRoot: host.runtimeRoot,
        stateDir: host.stateDir,
      });

      booted.push(restarted);
      expect(restarted.hostState.getRuntimeObject(objectId)?.state).toBe(
        expectedState,
      );
      expect(
        restarted.hostState
          .pendingRuntimeEvents(restarted.hostState.getRuntimeEventStreamId())
          .map((event) => event.envelope),
      ).toContainEqual(
        expect.objectContaining({
          eventType: "runtime_object.state",
          payload: expect.objectContaining({ objectId, state: expectedState }),
        }),
      );
    },
  );

  it.each(["retained writer", "interrupted seal"] as const)(
    "seals a distinct inode with %s",
    async (scenario) => {
      const host = await bootHost({ runtimeRoot: await tempRoot() });

      booted.push(host);
      const fence = {
        hostKey: host.hostState.hostKey,
        assignmentId: randomUUID(),
        assignmentEpoch: 1,
        runId: `run-${randomUUID().slice(0, 8)}`,
      };
      const workspaceId = await adoptDirectory(host, fence);
      const objectId = randomUUID();
      const created = await postJson(
        `${host.url}/sessions`,
        envelope("session.create", fence, {
          executionWorkspaceId: workspaceId,
          stepId: "plan",
          executor: { agent: "claude", model: "claude-sonnet-4-6" },
          outputObjects: [
            {
              objectId,
              kind: "plan_review",
              logicalName: "plan.md",
              mimeType: "text/markdown",
              generation: 1,
              retentionClass: "run",
              envName: "MAISTER_PLAN_DOCUMENT_FILE",
            },
          ],
        }),
      );

      expect(created.status).toBe(201);
      const object = host.hostState.getRuntimeObject(objectId)!;
      const objects = new RuntimeObjectRegistry(
        host.hostState,
        dirname(object.privatePath),
      );
      const allocation = await objects.allocateOutput({
        runId: fence.runId,
        assignmentId: fence.assignmentId,
        assignmentEpoch: fence.assignmentEpoch,
        hostSessionId: String(created.body.sessionId),
        walletId: host.hostState.getRuntimeFile(`object:${objectId}`)!
          .walletId!,
        binding: {
          objectId,
          kind: "plan_review",
          logicalName: "plan.md",
          mimeType: "text/markdown",
          generation: 1,
          retentionClass: "run",
          envName: "MAISTER_PLAN_DOCUMENT_FILE",
        },
      });
      const writer = await filesystem.open(allocation.path, "w+");

      try {
        await writer.writeFile("original output");
        await writer.sync();
        const initial = await writer.stat({ bigint: true });

        if (scenario === "interrupted seal") {
          vi.spyOn(filesystem, "rename").mockRejectedValueOnce(
            Object.assign(new Error("injected seal write failure"), {
              code: "EIO",
            }),
          );
          await expect(
            objects.sealOutput({
              objectId,
              hostSessionId: String(created.body.sessionId),
            }),
          ).rejects.toMatchObject({ reason: "runtime_storage_unavailable" });
          expect(host.hostState.getRuntimeObject(objectId)?.state).toBe(
            "pending",
          );
          expect(await filesystem.readFile(allocation.path, "utf8")).toBe(
            "original output",
          );
          expect(
            (await filesystem.readdir(dirname(object.privatePath))).filter(
              (name) => name.endsWith(".partial"),
            ),
          ).toEqual([]);
        } else {
          await objects.sealOutput({
            objectId,
            hostSessionId: String(created.body.sessionId),
          });
          expect(
            (await filesystem.stat(object.privatePath, { bigint: true })).ino,
          ).not.toBe(initial.ino);
          await writer.write(Buffer.from("changed!"), 0, 8, 0);
          await writer.sync();
          await filesystem.writeFile(allocation.path, "reopened output");
          const response = await fetch(
            `${host.url}/runtime-objects/${objectId}/content`,
          );

          expect(response.status).toBe(200);
          expect(await response.text()).toBe("original output");
        }
      } finally {
        await writer.close();
      }
    },
  );

  it("rejects a mutation during the descriptor scan before any success headers", async () => {
    const { host, object, objectId } = await integrityObject(
      "x".repeat(128 * 1024),
    );
    const actualOpen = (
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      )
    ).open;
    let mutated = false;

    vi.spyOn(filesystem, "open").mockImplementation(async (...args) => {
      const handle = await actualOpen(...args);

      if (args[0] === object.privatePath) {
        const actualRead = handle.read.bind(handle);

        vi.spyOn(handle, "read").mockImplementation(
          async (...readArgs: Parameters<typeof handle.read>) => {
            const result = await actualRead(...readArgs);

            if (!mutated && result.bytesRead > 0) {
              mutated = true;
              await writeFile(object.privatePath, "y".repeat(128 * 1024));
            }

            return result;
          },
        );
      }

      return handle;
    });
    const abort = new AbortController();
    const response = await fetch(
      `${host.url}/runtime-objects/${objectId}/content`,
      { signal: abort.signal, headers: { connection: "close" } },
    );
    const failure = response.status === 409 ? await response.json() : null;

    abort.abort();
    expect(response.status).toBe(409);
    expect(mutated).toBe(true);
    expect(failure).toMatchObject({
      details: { reason: "runtime_object_integrity_mismatch" },
    });
    expect(host.hostState.getRuntimeObject(objectId)?.state).toBe("corrupt");
  });

  it("serves the verified descriptor after source replacement and releases both bounded read slots", async () => {
    const content = "verified original bytes";
    const { host, object, objectId, objects } = await integrityObject(content);
    const before = host.hostState.runtimeFileBudget().chargedBytes;
    const first = await objects.read(objectId);
    const second = await objects.read(objectId);

    try {
      await expect(objects.read(objectId)).rejects.toMatchObject({
        reason: "command_in_progress",
      });
      expect(host.hostState.runtimeFileBudget().chargedBytes - before).toBe(
        2 * Buffer.byteLength(content),
      );
      await writeFile(object.privatePath, "z".repeat(content.length));
      const bytes: Buffer[] = [];

      for await (const chunk of first.stream) bytes.push(Buffer.from(chunk));
      expect(Buffer.concat(bytes).toString()).toBe(content);
      expect(
        (await filesystem.readdir(dirname(object.privatePath))).filter((name) =>
          name.endsWith(".response"),
        ),
      ).toEqual([]);
    } finally {
      const closed = once(second.stream, "close");

      second.stream.destroy();
      await closed;
      first.stream.destroy();
    }
    expect(host.hostState.runtimeFileBudget().chargedBytes).toBe(before);
    await expect(objects.read(objectId)).rejects.toMatchObject({
      details: { reason: "runtime_object_integrity_mismatch" },
    });
    expect(host.hostState.runtimeFileBudget().chargedBytes).toBe(before);
  });

  it("verifies bytes outside the maximum eight MiB range and refuses an unbounded response", async () => {
    const limit = 8 * 1024 * 1024;
    const { host, object, objectId } = await integrityObject(
      "x".repeat(limit + 1),
    );
    const url = `${host.url}/runtime-objects/${objectId}/content`;
    const full = await fetch(url);

    expect(full.status).toBe(416);
    await full.body?.cancel();
    const range = await fetch(url, {
      headers: { range: `bytes=0-${limit - 1}` },
    });

    expect(range.status).toBe(206);
    expect((await range.arrayBuffer()).byteLength).toBe(limit);
    const oversized = await fetch(url, {
      headers: { range: `bytes=0-${limit}` },
    });

    expect(oversized.status).toBe(416);
    await oversized.body?.cancel();
    const writer = await filesystem.open(object.privatePath, "r+");

    try {
      await writer.write(Buffer.from("y"), 0, 1, limit);
    } finally {
      await writer.close();
    }
    const corrupted = await fetch(url, { headers: { range: "bytes=0-7" } });

    expect(corrupted.status).toBe(409);
    expect(await corrupted.json()).toMatchObject({
      details: { reason: "runtime_object_integrity_mismatch" },
    });
  });

  it("releases canceled verifications and removes completed spool accounting", async () => {
    const { host, objectId, objects } = await integrityObject();
    const before = host.hostState.runtimeFileBudget().chargedBytes;

    await expect(
      objects.read(objectId, undefined, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
    for (let index = 0; index < 3; index += 1) {
      const response = await objects.read(objectId);
      const closed = once(response.stream, "close");

      response.stream.resume();
      await closed;
    }
    expect(host.hostState.runtimeFileBudget().chargedBytes).toBe(before);
    const db = new DatabaseSync(join(host.stateDir, "state.sqlite"));

    try {
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM runtime_files WHERE kind = 'spool'",
          )
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("rolls back missing/corrupt state when its durable outbox write fails", async () => {
    const { host, object, objectId } = await integrityObject();
    const db = new DatabaseSync(join(host.stateDir, "state.sqlite"));

    try {
      db.exec(`CREATE TRIGGER fail_object_state BEFORE INSERT ON runtime_event_outbox
        WHEN json_extract(NEW.envelope_json, '$.eventType') = 'runtime_object.state'
        BEGIN SELECT RAISE(ABORT, 'injected object evidence failure'); END;`);
      await unlink(object.privatePath);
      const response = await fetch(
        `${host.url}/runtime-objects/${objectId}/content`,
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "EXECUTOR_UNAVAILABLE",
        details: { reason: "runtime_storage_unavailable" },
      });
      expect(host.hostState.getRuntimeObject(objectId)?.state).toBe(
        "available",
      );
      expect(host.hostState.runtimeStorageAvailable()).toBe(false);
      expect(
        host.hostState
          .pendingRuntimeEvents(host.hostState.getRuntimeEventStreamId())
          .map((event) => event.envelope),
      ).not.toContainEqual(
        expect.objectContaining({
          eventType: "runtime_object.state",
          payload: expect.objectContaining({ objectId, state: "missing" }),
        }),
      );
    } finally {
      db.close();
    }
  });

  it("upgrades SQLite 12 seals by verified copy and preserves the existing catalog identity", async () => {
    const { host, object, objectId } = await integrityObject();
    const before = await filesystem.stat(object.privatePath, { bigint: true });

    await host.stop();
    booted.splice(booted.indexOf(host), 1);
    const db = new DatabaseSync(join(host.stateDir, "state.sqlite"));

    const columns = db.prepare("PRAGMA table_info(runtime_objects)").all();

    for (const name of ["producer_path", "sealed_device", "sealed_inode"]) {
      if (columns.some((column) => column.name === name))
        db.exec(`ALTER TABLE runtime_objects DROP COLUMN ${name}`);
    }
    db.exec("PRAGMA user_version = 12;");
    db.close();
    const restarted = await bootHost({
      runtimeRoot: host.runtimeRoot,
      stateDir: host.stateDir,
    });

    booted.push(restarted);
    const response = await fetch(
      `${restarted.url}/runtime-objects/${objectId}/content`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("sealed original bytes");
    const sealed = restarted.hostState.getRuntimeObject(objectId)!;

    expect(sealed).toMatchObject({
      id: objectId,
      generation: object.generation,
      sha256: object.sha256,
      state: "available",
    });
    expect(sealed.sealedInode).not.toBe(before.ino.toString());
    expect(sealed.sealedInode).toBe(
      (
        await filesystem.stat(object.privatePath, { bigint: true })
      ).ino.toString(),
    );
    const inspected = new DatabaseSync(join(host.stateDir, "state.sqlite"));

    try {
      expect(inspected.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 13,
      });
    } finally {
      inspected.close();
    }
  });

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

  it("resolves an uploaded attachment referenced by opaque id into the prompt the adapter receives", async () => {
    // AB-12 browser lane (AT-12) RED finding: the prompt route's resolver call
    // omitted `expectedKind`, so the registry compared the attachment's kind
    // against `undefined` and refused every prompt carrying an upload.
    const host = await bootHost({ runtimeRoot: await tempRoot() });

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
    const objectId = randomUUID();
    const payload = Buffer.from("<html><script>1</script></html>", "utf8");
    const checksum = createHash("sha256").update(payload).digest("hex");
    const reserved = await postJson(
      `${host.url}/runtime-objects`,
      envelope("runtime_object.reserve", fence, {
        objectId,
        kind: "attachment",
        logicalName: "scratch-upload-0123456789abcdef-evil.html",
        mimeType: "text/html",
        sizeBytes: payload.byteLength,
        sha256: checksum,
        generation: 1,
        retentionClass: "run",
      }),
    );

    expect(reserved.status).toBe(201);
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
    const uploaded = await fetch(
      `${host.url}/runtime-objects/${objectId}/content`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(payload.byteLength),
          "content-digest": `sha-256=:${Buffer.from(checksum, "hex").toString("base64")}:`,
          "x-maister-command-id": uploadCommandId,
          "x-maister-command-issued-at": new Date(0).toISOString(),
          "x-maister-assignment-id": assignmentId,
          "x-maister-assignment-epoch": "1",
          "x-maister-object-generation": "1",
          "x-maister-sha256": checksum,
        },
        body: payload,
      },
    );

    expect(uploaded.status).toBe(200);
    const created = await postJson(
      `${host.url}/sessions`,
      envelope("session.create", fence, {
        executionWorkspaceId,
        stepId: "scratch",
        executor: { agent: "claude", model: "claude-sonnet-4-6" },
      }),
    );

    expect(created.status).toBe(201);
    const completed = await completePrompt(
      host,
      created.body.sessionId as string,
      envelope("session.prompt", fence, {
        stepId: "scratch",
        prompt: "Summarize the attached file.",
        contentBlocks: [
          { type: "text", text: "Summarize the attached file." },
          { type: "runtime_object", objectId, name: "evil.html" },
        ],
      }),
    );

    // Admission (202) then completion (200): the host resolved the opaque id
    // itself. A refusal surfaces here as the admission status instead.
    expect(completed.status).toBe(200);
    // The resolved private path is handed to the ADAPTER only; nothing the
    // manager can read carries it.
    expect(JSON.stringify(completed.body)).not.toContain("file:");
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
    const full = await fetch(`${host.url}/runtime-objects/${objectId}/content`);
    const fullBody = Buffer.from(await full.arrayBuffer());
    const ranged = await fetch(
      `${host.url}/runtime-objects/${objectId}/content`,
      {
        headers: { range: "bytes=2-4" },
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
    expect(full.status).toBe(200);
    expect(fullBody).toEqual(payload);
    // AT-12 (D5): the host never labels bytes with the reserved MIME
    // (`application/json` here); 200 and 206 both carry the attachment policy.
    for (const response of [full, ranged]) {
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="verification.json"; filename*=UTF-8''verification.json`,
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toBe(
        "sandbox; default-src 'none'",
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(
      `bytes 2-4/${payload.byteLength}`,
    );
    const rangeBytes = Buffer.from(await ranged.arrayBuffer());
    const sliceDigest = `sha-256=:${createHash("sha256").update(rangeBytes).digest("base64")}:`;

    expect(rangeBytes).toEqual(payload.subarray(2, 5));
    expect(ranged.headers.get("content-digest")).toBe(sliceDigest);
    expect(sliceDigest).not.toBe(digest);
    expect(ranged.headers.get("repr-digest")).toBe(digest);
    expect(ranged.headers.get("etag")).toBe(`"1-${checksum}"`);
    expect(full.headers.get("content-digest")).toBe(
      `sha-256=:${createHash("sha256").update(fullBody).digest("base64")}:`,
    );
    expect(full.headers.get("repr-digest")).toBe(digest);
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
