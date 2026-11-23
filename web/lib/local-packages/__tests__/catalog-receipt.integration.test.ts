import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { POST } from "@/app/api/studio/local-packages/[id]/catalog/apply/route";
import { GET } from "@/app/api/studio/local-packages/[id]/catalog/operations/[operationId]/route";
import * as atomic from "@/lib/atomic";
import { closeDb } from "@/lib/db/client";
import { localPackages, users } from "@/lib/db/schema";
import { previewCatalogImport } from "@/lib/local-packages/catalog-operation";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

const editor = randomUUID();
const draftId = randomUUID();
let actor = editor;

vi.mock("@/lib/authz", () => ({
  requireGlobalRole: async () => ({ id: actor }),
}));
let database: StartedPostgresTestDb;
let root: string;
let address: string;
const params = Promise.resolve({ id: draftId });
const http = createServer(async (request, response) => {
  const url = address + request.url;

  try {
    let result: Response;

    if (request.method === "POST") {
      const chunks: Buffer[] = [];

      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      result = await POST(
        new NextRequest(url, {
          method: "POST",
          body: Buffer.concat(chunks).toString(),
        }),
        { params },
      );
    } else {
      result = await GET(new Request(url), {
        params: Promise.resolve({
          id: draftId,
          operationId: url.split("/").at(-1)!,
        }),
      });
    }
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(await result.text());
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "catalog_receipts",
  });
  vi.stubEnv("DB_URL", database.container.getConnectionUri());
  root = await mkdtemp(join(tmpdir(), "maister-catalog-receipt-"));
  const workingDir = join(root, "draft");

  await mkdir(workingDir);
  await writeFile(
    join(workingDir, "maister-package.yaml"),
    "schemaVersion: 1\nname: demo\nflows: []\n",
  );
  await database.db
    .insert(users)
    .values({ id: editor, name: "Editor", email: editor + "@test.example" });
  await database.db.insert(localPackages).values({
    id: draftId,
    name: "Demo",
    slug: draftId,
    workingDir,
    lockedByUserId: editor,
    lockedBySession: "editor",
    lockExpiresAt: new Date(Date.now() + 60_000),
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const socket = http.address();

  if (!socket || typeof socket === "string")
    throw new Error("Expected a loopback HTTP port");
  address = "http://127.0.0.1:" + socket.port;
}, 180_000);

afterAll(async () => {
  if (http.listening)
    await new Promise<void>((resolve, reject) =>
      http.close((e) => (e ? reject(e) : resolve())),
    );
  await closeDb();
  await database?.stop();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("IT-CAT-03 returns a durable owner-bound pending receipt during an actual HTTP apply and replays its final result", async () => {
  const workingDir = join(root, "draft");
  const skill =
    "---\nname: design\ndescription: Design a site.\n---\nDesign it.";
  const preview = await previewCatalogImport(
    { packageId: draftId, actorId: editor, workingDir },
    {
      kind: "skill",
      sourceId: "anthropic-skills",
      sourceUrl: "https://github.com/anthropics/skills/tree/main/skills/design",
      selector: "skills/design",
      publisher: "anthropics",
      pin: "f".repeat(40),
      name: "design",
      files: { "SKILL.md": skill },
      notices: [],
      configuration: [],
    },
    "capability/skills/design",
  );
  const body = {
    previewId: preview.previewId,
    expectedDraftBase: preview.expectedDraftBase,
    requestKey: "same-key",
  };
  const post = (value: typeof body) =>
    fetch(address + "/apply", { method: "POST", body: JSON.stringify(value) });
  const accepted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = atomic.atomicWriteJson;
  const pause = vi
    .spyOn(atomic, "atomicWriteJson")
    .mockImplementation(async (file, data) => {
      await write(file, data);
      if (file.endsWith("/pending.json")) {
        accepted.resolve();
        await release.promise;
      }
    });
  const original = post(body);

  try {
    await Promise.race([
      accepted.promise,
      original.then((r) => {
        throw new Error("Writer stopped before journal, HTTP " + r.status);
      }),
    ]);
    const duplicate = await post(body);

    expect(duplicate.status).toBe(202);
    const pending = await duplicate.json();

    expect(pending).toEqual({
      operationId: expect.stringMatching(/^[a-f0-9]{64}$/),
      state: "pending",
    });
    const status = () => fetch(address + "/operations/" + pending.operationId);
    const observed = await status();

    expect(observed.status).toBe(200);
    expect(await observed.json()).toEqual(pending);
    expect(
      (await post({ ...body, expectedDraftBase: "0".repeat(64) })).status,
    ).toBe(409);
    expect((await post({ ...body, requestKey: "another-key" })).status).toBe(
      409,
    );
    actor = randomUUID();
    expect((await status()).status).toBe(404);
    expect((await post(body)).status).toBe(409);
    actor = editor;
    release.resolve();
    const committed = await original;

    expect(committed.status).toBe(200);
    const receipt = await committed.json();

    expect(receipt).toMatchObject({
      operationId: pending.operationId,
      state: "applied",
    });
    expect(await (await post(body)).json()).toEqual(receipt);
    expect(await (await status()).json()).toEqual(receipt);
    expect(
      await readFile(
        join(workingDir, "capability/skills/design/SKILL.md"),
        "utf8",
      ),
    ).toBe(skill);
  } finally {
    actor = editor;
    release.resolve();
    await original;
    pause.mockRestore();
  }
});
