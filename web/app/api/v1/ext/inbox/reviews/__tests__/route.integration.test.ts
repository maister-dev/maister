import type { StartedPostgresTestDb } from "@/test-support/pg-container";

import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { expect, it, vi } from "vitest";

import { GET as list } from "../route";
import { GET as detail } from "../[kind]/[proposalId]/route";
import { POST as decide } from "../[kind]/[proposalId]/decision/route";

import { GET as readKnowledgeRevisions } from "@/app/api/v1/ext/knowledge/[recordId]/revisions/route";
import { GET as listVaults } from "@/app/api/v1/ext/knowledge/vaults/route";
import { GET as readVaultPath } from "@/app/api/v1/ext/knowledge/vaults/[locationId]/view/route";
import { GET as readVaultNote } from "@/app/api/v1/ext/knowledge/vaults/[locationId]/notes/[noteId]/route";
import { GET as listVaultRevisions } from "@/app/api/v1/ext/knowledge/vaults/[locationId]/notes/[noteId]/revisions/route";
import { GET as readVaultRevision } from "@/app/api/v1/ext/knowledge/vaults/[locationId]/notes/[noteId]/revisions/[revisionId]/route";
import { agentMemoryVaultLimits } from "@/lib/agent-memory-vault/limits";
import { prepareHumanProjectVault } from "@/lib/agent-memory-vault/project-access";
import {
  parseMemoryPromotion,
  promoteMemory,
} from "@/lib/agent-memory-vault/promotion";
import { applyVaultMutation } from "@/lib/agent-memory-vault/store";
import { viewAgentMemory } from "@/lib/agent-memory-vault/view";
import { reviewKnowledgeProposal } from "@/lib/brain/knowledge-proposals";
import { issueToken, issueUserAccessToken } from "@/lib/tokens/issue";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import { seedActiveUser } from "@/test-support/librarian-seed";
import { seedProjectReviewQueue } from "@/test-support/knowledge-review-seed";
import { startMainAndBrainPostgresTestDb } from "@/test-support/pg-container";

let fixture: StartedPostgresTestDb;

vi.mock("@/lib/db/client", () => ({ getDb: () => fixture.db }));

const endpoint = "/api/v1/ext/inbox/reviews";

it("K11 K12 binds browser-compatible review results to global PAT scopes and the installed personal MCP profile", async () => {
  fixture = await startMainAndBrainPostgresTestDb({
    databaseName: "personal_review_routes",
  });
  vi.stubEnv("AUTH_SECRET", "personal-review-qualification");
  const { userId, project, expectedIds } =
    await seedProjectReviewQueue(fixture);
  const proposalId = expectedIds.at(-1)!;
  const params = { params: Promise.resolve({ kind: "brain", proposalId }) };
  const personal = await issueUserAccessToken(
    {
      ownerUserId: userId,
      name: "Personal review",
      scopes: ["decisions:read", "decisions:review", "memory:read"],
    },
    fixture.db,
  );
  const broad = await issueUserAccessToken(
    {
      ownerUserId: userId,
      name: "Broad read",
      scopes: ["*"],
    },
    fixture.db,
  );
  const other = await issueToken(
    {
      projectId: project.id,
      name: "Project token",
      scopes: ["*"],
      createdByUserId: userId,
    },
    fixture.db,
  );
  const request = (path: string, token: string, body?: unknown) =>
    new Request(`http://127.0.0.1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const base = `${endpoint}/brain/${proposalId}`;
  const http = createServer((incoming, outgoing) => {
    void (async () => {
      const buffers: Buffer[] = [];

      for await (const part of incoming) buffers.push(Buffer.from(part));
      const routed = new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method,
        headers: {
          authorization: incoming.headers.authorization ?? "",
          "content-type": "application/json",
        },
        ...(incoming.method === "POST" ? { body: Buffer.concat(buffers) } : {}),
      });
      const response =
        incoming.method === "POST"
          ? await decide(routed, params)
          : incoming.url?.startsWith(base)
            ? await detail(routed, params)
            : await list(routed);

      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    })().catch(() => {
      outgoing.writeHead(500);
      outgoing.end();
    });
  });

  try {
    const draftContent = `    ${"a".repeat(263_000)}\n`;

    await fixture.pool.query(
      "UPDATE brain_proposals SET draft = draft || jsonb_build_object('content', $2::text) WHERE id=$1",
      [proposalId, draftContent],
    );
    const queue = await list(request(`${endpoint}?limit=1`, personal.secret));

    expect(queue.status).toBe(200);
    const { total, nextCursor } = await queue.json();

    expect(total).toBe(26);
    expect(
      (
        await list(
          request(
            `${endpoint}?limit=1&cursor=${encodeURIComponent(nextCursor)}`,
            broad.secret,
          ),
        )
      ).status,
    ).toBe(422);
    const inspected = await detail(request(base, personal.secret), params);
    const row = await inspected.json();
    const command = {
      expectedVersion: row.version,
      decision: "accept",
      requestKey: "mcp-personal-brain",
    };

    expect(inspected.status).toBe(200);
    expect(row.nextCursor).toEqual(expect.any(String));
    const previewPage = `${base}?${new URLSearchParams({ cursor: row.nextCursor })}`;

    const continuation = await detail(
      request(previewPage, personal.secret),
      params,
    );

    expect(continuation.status).toBe(200);
    expect(
      row.summary + (await continuation.json()).summary === draftContent,
    ).toBe(true);
    expect
      .soft((await detail(request(previewPage, broad.secret), params)).status)
      .toBe(422);
    expect(
      (await decide(request(`${base}/decision`, broad.secret, command), params))
        .status,
    ).toBe(403);
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();

    if (!address || typeof address === "string")
      throw new Error("Expected a local test listener");
    const run = async (profile: string, token: string) => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["test/fixtures/personal-knowledge-client.mjs"],
        {
          cwd: resolve("../mcp"),
          timeout: 20_000,
          env: {
            ...process.env,
            MAISTER_MCP_TOOLSET: profile,
            MAISTER_API_BASE_URL: `http://127.0.0.1:${address.port}`,
            MAISTER_ACCESS_TOKEN: token,
            MAISTER_TEST_PROPOSAL_ID: proposalId,
          },
        },
      );

      return JSON.parse(stdout);
    };
    const allowed = await run("personal-knowledge", personal.secret);

    expect(allowed.error, allowed.diagnostic).toBe(false);
    expect(allowed.tools.map((tool: { name: string }) => tool.name)).toContain(
      "proposal_review_decide",
    );
    expect(allowed.receipt).toMatchObject({
      id: proposalId,
      domainState: "applied",
      reviewedVersion: row.version,
      outcome: {
        type: "project_task",
        taskId: expect.any(String),
        href: expect.stringContaining(`/projects/${project.slug}/tasks/`),
      },
    });
    const replay = await decide(
      request(`${base}/decision`, personal.secret, command),
      params,
    );

    expect(await replay.json()).toMatchObject({
      receiptId: allowed.receipt.receiptId,
      replayed: true,
    });
    expect(
      await (await detail(request(base, personal.secret), params)).json(),
    ).toMatchObject({
      decision: { reviewedVersion: row.version, by: userId },
      detail: { draftPath: "docs/review.md", contentFormat: "markdown" },
    });
    expect((await run("personal-knowledge", other.secret)).error).toBe(true);
    for (const profile of [
      "",
      "unknown-profile",
      "librarian",
      "installation",
      "vault",
    ]) {
      const refused = await run(profile, personal.secret);

      expect(refused.error).toBe(true);
      expect(
        refused.tools.map((tool: { name: string }) => tool.name),
      ).not.toContain("proposal_review_get");
    }
    await fixture.pool.query(
      "UPDATE project_tokens SET revoked_at=now() WHERE id=$1",
      [personal.tokenId],
    );
    expect(
      (
        await decide(
          request(`${base}/decision`, personal.secret, command),
          params,
        )
      ).status,
    ).toBe(401);
  } finally {
    if (http.listening)
      await new Promise<void>((closed) => http.close(() => closed()));
    vi.unstubAllEnvs();
    await fixture.stop();
  }
}, 180_000);

it("K10 K11 exposes exact vault revisions and pages every authorized review result", async () => {
  fixture = await startMainAndBrainPostgresTestDb({
    databaseName: "personal_vault_routes",
  });
  vi.stubEnv("AUTH_SECRET", "personal-vault-result-qualification");
  const endpoint = "/api/v1/ext/knowledge/vaults";

  try {
    const userId = await seedActiveUser(fixture.db, { role: "admin" });
    const [project, other] = await Promise.all([
      seedProjectRow(fixture.db),
      seedProjectRow(fixture.db),
    ]);
    const agentId = "fixture:personal-memory";
    const path = "/memories/source/fixture.md";

    await fixture.pool.query(
      "INSERT INTO agent_memory_cutover(generation) VALUES (1)",
    );
    await fixture.pool.query(
      `INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path)
      VALUES ($1,'fixture','v1','git','Memory specialist','Fixture','none','session','[]','read_only','/unused/specialist.md')`,
      [agentId],
    );
    await fixture.pool.query(
      `INSERT INTO agent_project_links(id,project_id,agent_id,memory_enabled)
      VALUES ('primary-vault',$1,$3,true),('other-vault',$2,$3,true)`,
      [project.id, other.id, agentId],
    );
    const content = "Exact revision inside its owner.";
    const prepare = prepareHumanProjectVault({
      userId,
      agentId,
      slug: project.slug,
      action: "editSettings",
    });
    const limits = agentMemoryVaultLimits();
    const write = await applyVaultMutation(
      fixture.db,
      {
        command: "create",
        path,
        file_text: content,
        requestKey: "personal-vault-fixture",
        ifHash: null,
        ifRevisionId: null,
      },
      prepare,
      limits,
    );

    if (write.status !== "applied" || !write.affected[0])
      throw new Error("Expected one retained revision");
    const { noteId, revisionId } = write.affected[0];
    const [personal, broad] = await Promise.all([
      issueUserAccessToken(
        {
          ownerUserId: userId,
          name: "Vault reader",
          scopes: ["agent_memory:read", "decisions:read", "decisions:review"],
        },
        fixture.db,
      ),
      issueUserAccessToken(
        { ownerUserId: userId, name: "Wildcard", scopes: ["*"] },
        fixture.db,
      ),
    ]);
    const request = (suffix = "", token = personal.secret) =>
      new Request(`http://127.0.0.1${endpoint}${suffix}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const locationId = "project:primary-vault";
    const locationParams = { params: Promise.resolve({ locationId }) };
    const noteParams = { params: Promise.resolve({ locationId, noteId }) };
    const revisionParams = {
      params: Promise.resolve({ locationId, noteId, revisionId }),
    };
    const selection = `/${locationId}/notes/${noteId}`;

    const catalog = await listVaults(request());

    expect(catalog.status).toBe(200);
    expect((await catalog.json()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ locationId, state: "ready" }),
        expect.objectContaining({
          locationId: "project:other-vault",
          state: "empty",
        }),
      ]),
    );
    expect((await listVaults(request("", broad.secret))).status).toBe(403);
    const folder = await readVaultPath(
      request(`/${locationId}/view?path=/memories/source`),
      locationParams,
    );

    expect(await folder.json()).toMatchObject({
      kind: "directory",
      entries: [{ kind: "note", path, noteId }],
    });
    const note = await readVaultNote(request(selection), noteParams);

    expect(await note.json()).toMatchObject({
      id: noteId,
      revisionId,
      path,
      content,
    });
    const revisions = await listVaultRevisions(
      request(`${selection}/revisions`),
      noteParams,
    );

    expect(await revisions.json()).toMatchObject({
      items: [{ id: revisionId, path }],
      nextCursor: null,
    });
    const exact = await readVaultRevision(
      request(`${selection}/revisions/${revisionId}`),
      revisionParams,
    );

    expect(await exact.json()).toMatchObject({
      id: noteId,
      revisionId,
      content,
    });
    const crossOwner = await readVaultRevision(
      request(`/project:other-vault/notes/${noteId}/revisions/${revisionId}`),
      {
        params: Promise.resolve({
          locationId: "project:other-vault",
          noteId,
          revisionId,
        }),
      },
    );

    expect(crossOwner.status).toBe(404);

    await fixture.pool.query(
      "UPDATE projects SET brain_enabled=true WHERE id=$1",
      [project.id],
    );
    const principal = { kind: "user", userId } as const;
    const promotion = await promoteMemory(
      fixture.db,
      principal,
      parseMemoryPromotion({
        path,
        ifRevisionId: revisionId,
        ifHash: write.affected[0].hash,
        requestKey: "personal-vault-promotion",
        target: {
          kind: "knowledge",
          ownerKind: "project",
          ownerId: project.id,
        },
      }),
      prepare,
    );
    const published = await reviewKnowledgeProposal(fixture.db, {
      proposalId: promotion.proposalId,
      principal,
      expectedRevision: 1,
      decision: "accept",
      reason: "Retain the exact vault witness",
      idempotencyKey: "personal-revision-publish",
    });
    const recordId = published.acceptedRecordId!;
    const revisionPath = `/api/v1/ext/knowledge/${recordId}/revisions`;
    const payload = { params: Promise.resolve({ recordId }) };
    const [knowledgeOnly, withVaultScope] = await Promise.all(
      [["knowledge:read"], ["knowledge:read", "agent_memory:read"]].map(
        (scopes) =>
          issueUserAccessToken(
            { ownerUserId: userId, name: "Knowledge history", scopes },
            fixture.db,
          ),
      ),
    );
    const readHistory = (token: string) =>
      readKnowledgeRevisions(
        new Request(`http://localhost${revisionPath}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
        payload,
      );
    const accessible = await readHistory(withVaultScope!.secret);
    const history = await accessible.json();

    expect(accessible.status).toBe(200);
    expect(history).toMatchObject({ items: [{ recordId, revision: 1 }] });
    for (const token of [knowledgeOnly!, broad]) {
      const hiddenHistory = await readHistory(token.secret);

      expect.soft(hiddenHistory.status).toBe(404);
      expect.soft(await hiddenHistory.json()).not.toHaveProperty("items");
    }

    const historyServer = createServer((incoming, outgoing) => {
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");

      if (incoming.method !== "GET" || url.pathname !== revisionPath) {
        outgoing.writeHead(404);
        outgoing.end();

        return;
      }
      void readKnowledgeRevisions(
        new Request(url, {
          headers: { authorization: incoming.headers.authorization ?? "" },
        }),
        payload,
      )
        .then(async (response) => {
          outgoing.writeHead(
            response.status,
            Object.fromEntries(response.headers),
          );
          outgoing.end(await response.text());
        })
        .catch(() => {
          outgoing.writeHead(500);
          outgoing.end();
        });
    });

    try {
      historyServer.listen(0, "127.0.0.1");
      await once(historyServer, "listening");
      const address = historyServer.address();

      if (!address || typeof address === "string")
        throw new Error("Expected a local history listener");
      const run = async (token: string) => {
        const { stdout } = await promisify(execFile)(
          process.execPath,
          ["test/fixtures/personal-knowledge-client.mjs"],
          {
            cwd: resolve("../mcp"),
            timeout: 20_000,
            env: {
              ...process.env,
              MAISTER_MCP_TOOLSET: "personal-knowledge",
              MAISTER_API_BASE_URL: `http://127.0.0.1:${address.port}`,
              MAISTER_ACCESS_TOKEN: token,
              MAISTER_TEST_RECORD_ID: recordId,
            },
          },
        );

        return JSON.parse(stdout);
      };

      expect
        .soft(await run(knowledgeOnly!.secret))
        .toMatchObject({ error: true });
      expect(await run(withVaultScope!.secret)).toMatchObject({
        error: false,
        body: history,
      });
    } finally {
      if (historyServer.listening)
        await new Promise<void>((closed) =>
          historyServer.close(() => closed()),
        );
    }

    for (let index = 0; index < 20; index++) {
      const added = await applyVaultMutation(
        fixture.db,
        {
          command: "create",
          path: `/memories/source/note-${index}.md`,
          file_text: `Note ${index}`,
          requestKey: `personal-vault-note-${index}`,
          ifHash: null,
          ifRevisionId: null,
        },
        prepare,
        limits,
      );

      if (added.status !== "applied")
        throw new Error("Expected an applied seed");
    }
    const source = await viewAgentMemory(
      fixture.db,
      { command: "view", path: "/memories/source", limit: 100 },
      prepare,
    );

    if (source.kind !== "directory")
      throw new Error("Expected the source directory");
    const pending = await applyVaultMutation(
      fixture.db,
      {
        command: "rename",
        old_path: source.path,
        new_path: "/memories/destination",
        ifGeneration: source.generation,
        heads: source.entries.map((entry) => ({
          path: entry.path,
          ifRevisionId: entry.revisionId!,
          ifHash: entry.hash!,
        })),
        requestKey: "personal-move-proposal",
      },
      async (tx) => ({
        ...(await prepare(tx)),
        writeAdmission: "review_required",
      }),
      limits,
    );

    if (pending.status !== "pending")
      throw new Error("Expected review of the move");
    const reviewPath = `/api/v1/ext/inbox/reviews/vault/${pending.proposalId}`;
    const reviewParams = {
      params: Promise.resolve({
        kind: "vault",
        proposalId: pending.proposalId,
      }),
    };
    const reviewRequest = (path: string, token: string, body?: string) =>
      new Request(`http://127.0.0.1${path}`, {
        method: body ? "POST" : "GET",
        body,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      });
    const approved = await decide(
      reviewRequest(
        `${reviewPath}/decision`,
        personal.secret,
        JSON.stringify({
          expectedVersion: "1",
          decision: "accept",
          requestKey: "personal-move-accept",
        }),
      ),
      reviewParams,
    );
    const receipt = await approved.json();

    expect(approved.status, JSON.stringify(receipt)).toBe(200);
    expect(receipt.outcome).toMatchObject({
      type: "applied_vault_operation",
      revisionCount: 21,
      revisionsNextCursor: expect.any(String),
    });
    expect(receipt.outcome.revisions).toHaveLength(20);
    const rest = `${reviewPath}?${new URLSearchParams({ outcomeCursor: receipt.outcome.revisionsNextCursor })}`;
    const continued = await detail(
      reviewRequest(rest, personal.secret),
      reviewParams,
    );
    const outcome = (await continued.json()).outcome;

    expect(continued.status).toBe(200);
    expect(outcome.revisionsNextCursor).toBeNull();
    expect(outcome.revisions).toHaveLength(1);
    expect(
      new Set(
        [...receipt.outcome.revisions, ...outcome.revisions].map(
          (revision: { revisionId: string }) => revision.revisionId,
        ),
      ).size,
    ).toBe(21);
    const alternate = await issueUserAccessToken(
      {
        ownerUserId: userId,
        name: "Other vault reviewer",
        scopes: ["agent_memory:read", "decisions:read"],
      },
      fixture.db,
    );

    expect(
      (await detail(reviewRequest(reviewPath, alternate.secret), reviewParams))
        .status,
    ).toBe(200);
    expect(
      (await detail(reviewRequest(rest, alternate.secret), reviewParams))
        .status,
    ).toBe(422);
    await fixture.pool.query(
      "UPDATE project_tokens SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [personal.tokenId],
    );
    expect((await listVaults(request())).status).toBe(401);
  } finally {
    vi.unstubAllEnvs();
    await fixture.stop();
  }
}, 180_000);
