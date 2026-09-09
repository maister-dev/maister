// AT-12 (AB-12, D5 download policy) — uploaded active documents served through
// the manager's content routes cannot execute in the MAIster origin.
//
// The attack is the real one: a scratch launch uploads `evil.html` and
// `evil.svg` whose scripts, if they ever ran on this origin, rename the run
// through an authenticated PATCH and request a marker URL. The bytes travel the
// production path (multipart upload → runtime object on the REAL supervisor →
// catalog → `GET /api/runs/{runId}/runtime-objects/{objectId}/content` and the
// artifact payload route over the same object). A real Chromium then opens
// each URL: the only acceptable outcome is a download of the exact bytes.
//
// The launch and the catalog availability wait happen once in `beforeAll`;
// C1–C4 are independent observations of that one run, so a failing policy
// header (C1) never hides whether the document actually executed (C2).
//
//   C1 authorized API reads carry the attachment policy and the exact bytes
//   C2 the browser downloads active documents instead of executing them
//   C3 the artifact payload route applies the same policy to the same object
//   C4 anonymous, non-member and foreign-run access is refused
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";

import { singleValue, withE2EDb } from "./_seed/db";
import { loadFixtures } from "./_seed/fixtures";
import { readLaunchResult } from "./_seed/launch-stream";

const MARKER = `pwned-${randomUUID().slice(0, 8)}`;
// Playwright recycles the worker after a failed test and runs `beforeAll`
// again, so every launch must be unique: the name derives the branch.
let scratchLaunchName = "";
// `location.pathname` of a content URL carries the run id, so an executed
// document needs nothing else to attempt the authenticated side effect.
const ACTIVE_SCRIPT = [
  `const runId = location.pathname.split("/")[3];`,
  `fetch("/api/scratch-runs/" + runId, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "${MARKER}" }) });`,
  `fetch("/api/runs/" + runId + "/${MARKER}");`,
  `document.title = "${MARKER}";`,
].join("\n");

type Upload = { fileName: string; mimeType: string; bytes: Uint8Array };

const utf8 = new TextEncoder();

const UPLOADS: readonly Upload[] = [
  {
    fileName: "evil.html",
    mimeType: "text/html",
    bytes: utf8.encode(
      `<!doctype html><html><head><title>inline document</title></head><body><script>${ACTIVE_SCRIPT}</script></body></html>`,
    ),
  },
  {
    fileName: "evil.svg",
    mimeType: "image/svg+xml",
    bytes: utf8.encode(
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>${ACTIVE_SCRIPT}</script><rect width="10" height="10"/></svg>`,
    ),
  },
  {
    fileName: "notes.txt",
    mimeType: "text/plain",
    bytes: utf8.encode("ordinary attachment bytes\n"),
  },
];

type ScratchAttachment = {
  kind: string;
  fileName: string | null;
  artifactRef: string | null;
  sha256: string | null;
};

let runId = "";
const objectIds = new Map<string, string>();
const logicalNames = new Map<string, string>();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function upload(fileName: string): Upload {
  const found = UPLOADS.find((entry) => entry.fileName === fileName);

  if (!found) throw new Error(`unknown upload ${fileName}`);

  return found;
}

function contentUrl(fileName: string): string {
  return `/api/runs/${runId}/runtime-objects/${objectIds.get(fileName)}/content`;
}

function expectSafeDownloadHeaders(
  headers: Record<string, string>,
  fileName: string,
): void {
  expect(headers["content-type"]).toBe("application/octet-stream");
  expect(headers["content-disposition"]).toBe(
    `attachment; filename="${fileName}"; filename*=UTF-8''${fileName}`,
  );
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["content-security-policy"]).toBe(
    "sandbox; default-src 'none'",
  );
  expect(headers["cache-control"]).toBe("private, no-store");
}

async function expectExactDownload(
  request: APIRequestContext,
  url: string,
  fileName: string,
  expectedName: string,
): Promise<void> {
  const response = await request.get(url);
  const bytes = new Uint8Array(await response.body());
  const representation = sha256(upload(fileName).bytes);
  const digest = `sha-256=:${Buffer.from(sha256(bytes), "hex").toString("base64")}:`;

  expect(response.status()).toBe(200);
  expectSafeDownloadHeaders(response.headers(), expectedName);
  expect(sha256(bytes)).toBe(representation);
  expect(response.headers()["content-digest"]).toBe(digest);
  expect(response.headers()["repr-digest"]).toBe(digest);
  expect(response.headers()["etag"]).toBe(`"1-${representation}"`);
  expect(response.headers()["content-encoding"]).toBeUndefined();

  const partial = await request.get(url, { headers: { range: "bytes=2-4" } });
  const slice = new Uint8Array(await partial.body());
  const sliceDigest = `sha-256=:${Buffer.from(sha256(slice), "hex").toString("base64")}:`;

  expect(partial.status()).toBe(206);
  expectSafeDownloadHeaders(partial.headers(), expectedName);
  expect(slice).toEqual(upload(fileName).bytes.subarray(2, 5));
  expect(partial.headers()["content-range"]).toBe(`bytes 2-4/${bytes.length}`);
  expect(partial.headers()["content-digest"]).toBe(sliceDigest);
  expect(sliceDigest).not.toBe(digest);
  expect(partial.headers()["repr-digest"]).toBe(digest);
  expect(partial.headers()["etag"]).toBe(`"1-${representation}"`);
  expect(partial.headers()["content-encoding"]).toBeUndefined();

  for (const range of ["bytes=0-1,3-4", `bytes=${bytes.length}-`, "bytes=-3"]) {
    const refused = await request.get(url, { headers: { range } });

    expect(refused.status()).toBe(416);
    expect(refused.headers()["content-digest"]).toBeUndefined();
  }
}

// A navigation that turns into a download rejects `page.goto` ("Download is
// starting"); the download event is the observation. An executed document
// would instead navigate, run its script and rename the run.
async function expectDownloadNotExecution(
  page: Page,
  url: string,
  fileName: string,
  expectedName: string,
): Promise<void> {
  const markerRequests: string[] = [];

  page.on("request", (request) => {
    if (request.url().includes(MARKER)) markerRequests.push(request.url());
  });
  const pendingDownload = page
    .waitForEvent("download", { timeout: 20_000 })
    .then(
      (download) => download,
      () => null,
    );

  await page.goto(url).catch(() => null);
  const download = await pendingDownload;

  // Every observation is reported: an executed document shows up as marker
  // requests and a changed title even when the download is also missing.
  expect.soft(markerRequests).toEqual([]);
  expect.soft(await page.title()).not.toContain(MARKER);
  expect.soft(page.url()).toBe("about:blank");
  expect(
    download,
    `${url} must become a download, not a navigation`,
  ).not.toBeNull();
  const savedPath = await (download as NonNullable<typeof download>).path();

  expect(savedPath).toBeTruthy();
  expect(sha256(new Uint8Array(await readFile(savedPath as string)))).toBe(
    sha256(upload(fileName).bytes),
  );
  expect((download as NonNullable<typeof download>).suggestedFilename()).toBe(
    expectedName,
  );
}

async function scratchName(): Promise<string | null> {
  return singleValue<string>(
    `SELECT name AS value FROM scratch_runs WHERE run_id = $1`,
    [runId],
  );
}

// Playwright Test applies the project's `storageState` (the admin session)
// to `browser.newContext()` too, so an unauthenticated or differently
// authenticated context must start from an explicitly empty state.
const EMPTY_STORAGE = { cookies: [], origins: [] };

async function signIn(
  browser: Browser,
  credentials: { email: string; password: string },
): Promise<APIRequestContext> {
  const context = await browser.newContext({ storageState: EMPTY_STORAGE });
  const page = await context.newPage();

  await page.goto("/login");
  await page.locator('input[name="email"]').fill(credentials.email);
  await page.locator('input[name="password"]').fill(credentials.password);
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 30_000,
  });
  await page.close();

  return context.request;
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({
    storageState: "e2e/.auth/admin.json",
  });
  const request = context.request;
  const fx = loadFixtures().byKey.scratch;
  const form = new FormData();

  scratchLaunchName = `AT-12 safe download ${randomUUID().slice(0, 8)}`;
  form.append(
    "payload",
    JSON.stringify({
      projectId: fx.projectId,
      baseBranch: "main",
      name: scratchLaunchName,
      // The lane's real supervisor spawns the mock claude adapter.
      runnerId: "claude-code",
      prompt: "Summarize the attached files in one sentence.",
      reasoningEffort: "high",
      attachments: [],
    }),
  );
  for (const entry of UPLOADS) {
    form.append(
      "files",
      new Blob([entry.bytes], { type: entry.mimeType }),
      entry.fileName,
    );
  }
  const launch = await request.post("/api/scratch-runs", { multipart: form });

  expect(launch.status()).toBe(200);
  ({ runId } = await readLaunchResult(launch));
  expect(runId).toMatch(/^[0-9a-f-]{36}$/);

  const attachments = await expect
    .poll(
      async () => {
        const detail = await request.get(`/api/scratch-runs/${runId}`);

        if (detail.status() !== 200) return null;
        const body = (await detail.json()) as {
          attachments: ScratchAttachment[];
        };
        const uploaded = body.attachments.filter(
          (entry) => entry.kind === "uploaded_file" && entry.artifactRef,
        );

        return uploaded.length === UPLOADS.length ? uploaded : null;
      },
      { timeout: 60_000 },
    )
    .not.toBeNull()
    .then(async () => {
      const detail = await request.get(`/api/scratch-runs/${runId}`);
      const body = (await detail.json()) as {
        attachments: ScratchAttachment[];
      };

      return body.attachments.filter((entry) => entry.kind === "uploaded_file");
    });

  for (const entry of UPLOADS) {
    const attachment = attachments.find(
      (row) => row.fileName === entry.fileName,
    );

    expect(attachment?.artifactRef).toMatch(/^[0-9a-f-]{36}$/);
    expect(attachment?.sha256).toBe(sha256(entry.bytes));
    objectIds.set(entry.fileName, attachment?.artifactRef as string);

    // The catalog row becomes `available` only through the canonical event
    // the REAL supervisor committed for the upload.
    await expect
      .poll(
        () =>
          singleValue<{ state: string; logical_name: string }>(
            `SELECT json_build_object('state', state, 'logical_name', logical_name) AS value
               FROM execution_runtime_objects WHERE id = $1 AND run_id = $2`,
            [attachment?.artifactRef, runId],
          ),
        { timeout: 60_000 },
      )
      .toMatchObject({ state: "available" });
    const catalog = await singleValue<{ logical_name: string }>(
      `SELECT json_build_object('logical_name', logical_name) AS value
         FROM execution_runtime_objects WHERE id = $1`,
      [attachment?.artifactRef],
    );

    expect(catalog?.logical_name).toMatch(
      new RegExp(
        `^scratch-upload-[0-9a-f]{16}-${entry.fileName.replace(".", "\\.")}$`,
      ),
    );
    logicalNames.set(entry.fileName, catalog?.logical_name as string);
  }
  await context.close();
});

test("C1: a launch with active uploads yields authorized reads of the exact bytes under the attachment policy", async ({
  request,
}) => {
  for (const entry of UPLOADS) {
    await expectExactDownload(
      request,
      contentUrl(entry.fileName),
      entry.fileName,
      logicalNames.get(entry.fileName) as string,
    );
  }
});

test("C2: a real browser downloads active documents and never executes them in the MAIster origin", async ({
  page,
}) => {
  for (const fileName of ["evil.html", "evil.svg", "notes.txt"]) {
    await expectDownloadNotExecution(
      page,
      contentUrl(fileName),
      fileName,
      logicalNames.get(fileName) as string,
    );
  }
  expect(await scratchName()).toBe(scratchLaunchName);
});

test("C3: the artifact payload route applies the same policy to the same object", async ({
  page,
  request,
}) => {
  const artifactId = `at12-${randomUUID()}`;

  await withE2EDb((pool) =>
    pool.query(
      `INSERT INTO artifact_instances (id, run_id, kind, producer, locator, validity)
       VALUES ($1, $2, 'generic_file', 'runner', $3::jsonb, 'current')`,
      [
        artifactId,
        runId,
        JSON.stringify({
          kind: "execution-object",
          objectId: objectIds.get("evil.html"),
        }),
      ],
    ),
  );
  const payloadUrl = `/api/runs/${runId}/artifacts/${artifactId}/payload`;
  const expectedName = logicalNames.get("evil.html") as string;

  await expectExactDownload(request, payloadUrl, "evil.html", expectedName);
  await expectDownloadNotExecution(page, payloadUrl, "evil.html", expectedName);
  expect(await scratchName()).toBe(scratchLaunchName);
});

test("C4: anonymous, non-member and foreign-run access to the object is refused", async ({
  browser,
  request,
}) => {
  const anonymous = await browser.newContext({ storageState: EMPTY_STORAGE });
  const anonymousRead = await anonymous.request.get(contentUrl("evil.html"));

  expect(anonymousRead.status()).toBe(401);
  expect(anonymousRead.headers()["content-disposition"]).toBeUndefined();
  await anonymous.close();

  const fixtures = loadFixtures();
  const outsider = await signIn(browser, fixtures.users.memberCandidate);
  const outsiderRead = await outsider.get(contentUrl("evil.html"));

  expect(outsiderRead.status()).toBe(403);
  expect(outsiderRead.headers()["content-disposition"]).toBeUndefined();

  // The payload route over the same object carries the same grant.
  const artifactId = `at12-outsider-${randomUUID()}`;

  await withE2EDb((pool) =>
    pool.query(
      `INSERT INTO artifact_instances (id, run_id, kind, producer, locator, validity)
       VALUES ($1, $2, 'generic_file', 'runner', $3::jsonb, 'current')`,
      [
        artifactId,
        runId,
        JSON.stringify({
          kind: "execution-object",
          objectId: objectIds.get("evil.html"),
        }),
      ],
    ),
  );
  const outsiderPayload = await outsider.get(
    `/api/runs/${runId}/artifacts/${artifactId}/payload`,
  );

  expect(outsiderPayload.status()).toBe(403);
  expect(outsiderPayload.headers()["content-disposition"]).toBeUndefined();
  await outsider.dispose();

  // The same object id under another run the admin CAN read is not found:
  // the catalog binds the object to its run before any authorization.
  const foreign = await request.get(
    `/api/runs/${fixtures.runId}/runtime-objects/${objectIds.get("evil.html")}/content`,
  );

  expect(foreign.status()).toBe(404);
});
