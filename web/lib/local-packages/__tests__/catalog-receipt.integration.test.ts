import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { MockAgent } from "undici";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { POST } from "@/app/api/studio/local-packages/[id]/catalog/apply/route";
import { GET } from "@/app/api/studio/local-packages/[id]/catalog/operations/[operationId]/route";
import { POST as previewImport } from "@/app/api/studio/local-packages/[id]/catalog/preview/route";
import { GET as searchImports } from "@/app/api/studio/local-packages/[id]/catalog/search/route";
import * as atomic from "@/lib/atomic";
import { closeDb } from "@/lib/db/client";
import { localPackages, users } from "@/lib/db/schema";
import { acquireLock } from "@/lib/local-packages/lock";
import {
  pinnedDispatcher,
  resolveAllowedDestination,
} from "@/lib/webhooks/destination";
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
vi.mock("@/lib/webhooks/destination", () => ({
  pinnedDispatcher: vi.fn(),
  resolveAllowedDestination: vi.fn(),
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
      const handler = url.endsWith("/preview") ? previewImport : POST;

      result = await handler(
        new NextRequest(url, {
          method: "POST",
          body: Buffer.concat(chunks).toString(),
        }),
        { params },
      );
    } else if (new URL(url).pathname === "/search") {
      result = await searchImports(new NextRequest(url), { params });
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
  vi.stubEnv(
    "MAISTER_STUDIO_CATALOG_REPOS",
    JSON.stringify([
      { id: "anthropic-skills", repo: "anthropics/skills", kind: "skill" },
    ]),
  );
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

function githubReply(path: string, body: object): MockAgent {
  const wire = new MockAgent();

  wire.disableNetConnect();
  wire
    .get("https://api.github.com")
    .intercept({ path })
    .reply(200, JSON.stringify(body));
  vi.mocked(pinnedDispatcher).mockReturnValueOnce(wire);

  return wire;
}

it("IT-CAT-03 returns a durable owner-bound pending receipt during an actual HTTP apply and replays its final result", async () => {
  const workingDir = join(root, "draft");
  const skill =
    "---\nname: design\ndescription: Design a site.\n---\nDesign it.";
  const repo = "/repos/anthropics/skills";
  const pin = "f".repeat(40);
  const size = Buffer.byteLength(skill);
  const blob = createHash("sha1")
    .update(`blob ${size}\0`)
    .update(skill)
    .digest("hex");
  const selection = {
    kind: "skill",
    sourceId: "anthropic-skills",
    selector: "skills/design",
    destination: "capability/skills/design",
  };
  const previewPost = (sessionId: string, sourceId = selection.sourceId) =>
    fetch(address + "/preview", {
      method: "POST",
      body: JSON.stringify({ ...selection, sessionId, sourceId }),
    });

  expect((await previewPost("stale-tab")).status).toBe(409);
  expect((await previewPost("editor", "unapproved-source")).status).toBe(422);
  expect(resolveAllowedDestination).not.toHaveBeenCalled();
  vi.mocked(resolveAllowedDestination).mockResolvedValue({
    ok: true,
    addresses: [{ address: "192.0.2.10", family: 4 }],
  });
  const upstream = [
    githubReply(repo + "/commits/HEAD", {
      sha: pin,
      commit: { tree: { sha: pin } },
    }),
    githubReply(repo + "/git/trees/" + pin + "?recursive=1", {
      truncated: false,
      tree: [
        {
          path: "skills/design/SKILL.md",
          sha: blob,
          type: "blob",
          mode: "100644",
          size,
        },
      ],
    }),
    githubReply(repo + "/git/blobs/" + blob, {
      encoding: "base64",
      content: Buffer.from(skill).toString("base64"),
    }),
  ];
  const search = await fetch(address + "/search?kind=skill&q=design");

  expect(search.status).toBe(200);
  expect(await search.json()).toMatchObject({
    results: [{ sourceId: selection.sourceId, resultId: selection.selector }],
  });
  const previewResponse = await previewPost("editor");

  expect(previewResponse.status).toBe(200);
  const preview = await previewResponse.json();

  expect(preview).toMatchObject({
    pin,
    artifactDigest: null,
    files: [{ path: selection.destination + "/SKILL.md", after: skill }],
  });
  upstream.forEach((wire) => wire.assertNoPendingInterceptors());
  const body = {
    sessionId: "editor",
    previewId: preview.previewId,
    expectedDraftBase: preview.expectedDraftBase,
    requestKey: "same-key",
  };
  const post = (value: typeof body) =>
    fetch(address + "/apply", { method: "POST", body: JSON.stringify(value) });

  expect((await post({ ...body, sessionId: "stale-tab" })).status).toBe(409);
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
    await acquireLock(draftId, editor, "next-tab");
    expect((await post(body)).status).toBe(409);
    expect(
      await (await post({ ...body, sessionId: "next-tab" })).json(),
    ).toEqual(receipt);
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
