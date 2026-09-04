import { createHash, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  bootHost,
  cleanupRuntimeRoot,
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

describe("runtime object transport", () => {
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
    const uploaded = await fetch(`${host.url}/runtime-objects/${objectId}/content`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(payload.byteLength),
        "content-digest": digest,
        "x-maister-command-id": randomUUID(),
        "x-maister-assignment-id": assignmentId,
        "x-maister-assignment-epoch": "1",
        "x-maister-object-generation": "1",
        "x-maister-sha256": checksum,
      },
      body: payload,
    });
    const uploadedBody = await uploaded.json() as Record<string, unknown>;
    const ranged = await fetch(`${host.url}/runtime-objects/${objectId}/content`, {
      headers: { range: "bytes=0-1" },
    });
    const suffixRange = await fetch(
      `${host.url}/runtime-objects/${objectId}/content`,
      { headers: { range: "bytes=-1" } },
    );
    const beyondEndRange = await fetch(
      `${host.url}/runtime-objects/${objectId}/content`,
      { headers: { range: `bytes=${payload.byteLength}-` } },
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
    expect(uploadedBody).toMatchObject({ objectId, state: "available", sha256: checksum });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 0-1/${payload.byteLength}`);
    expect(ranged.headers.get("content-digest")).toBe(digest);
    expect(ranged.headers.get("etag")).toBe(`"${checksum}"`);
    expect(Buffer.from(await ranged.arrayBuffer()).toString("utf8")).toBe("{\"");
    expect(suffixRange.status).toBe(416);
    expect(await suffixRange.json()).toMatchObject({
      code: "PRECONDITION",
      details: { reason: "runtime_object_range_invalid" },
    });
    expect(beyondEndRange.status).toBe(416);
    expect(deleted.status).toBe(204);
    expect(host.hostState.getRuntimeObject(objectId)?.state).toBe("deleted");
    expect(host.hostState.getReceipt(reserveId)?.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(outbox.map((event) => event.envelope.eventType)).toEqual([
      "runtime_object.state",
      "runtime_object.available",
      "runtime_object.state",
    ]);
    expect(JSON.stringify(outbox)).not.toContain("runtime-objects/");
  });
});
