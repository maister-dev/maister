import { createHash } from "node:crypto";

import { expect, it, vi } from "vitest";

import { GET } from "../route";

import { parseAgentMemoryMutation } from "@/lib/agent-memory-vault/commands";
import { agentMemoryVaultLimits } from "@/lib/agent-memory-vault/limits";
import { prepareHumanProjectVault } from "@/lib/agent-memory-vault/project-access";
import { applyVaultMutation } from "@/lib/agent-memory-vault/store";
import { createBrainProposal } from "@/lib/brain/proposals";
import { seedProjectRow } from "@/test-support/execution-host-seed";
import {
  addProjectMember,
  removeProjectMember,
  seedActiveUser,
} from "@/test-support/librarian-seed";
import {
  startMainAndBrainPostgresTestDb,
  startMainPostgresTestDb,
} from "@/test-support/pg-container";

let fixture: Awaited<ReturnType<typeof startMainPostgresTestDb>>;
let userId: string;

vi.mock("@/lib/db/client", () => ({ getDb: () => fixture.db }));
vi.mock("@/lib/authz", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/authz")>()),
  requireActiveSession: async () => ({ id: userId }),
}));

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

type Preview = { summary: string; nextCursor: string | null };

it("AV-11 returns every part of a large vault proposal and reauthorizes its continuation", async () => {
  fixture = await startMainPostgresTestDb({
    databaseName: "inbox_review_preview",
  });
  vi.stubEnv("AUTH_SECRET", "inbox-review-preview-test-secret");

  try {
    const reviewer = await seedActiveUser(fixture.db);
    const otherReviewer = await seedActiveUser(fixture.db, { role: "admin" });
    const project = await seedProjectRow(fixture.db);
    const agentId = "fixture:inbox-preview";

    userId = reviewer;
    await addProjectMember(fixture.db, {
      projectId: project.id,
      userId,
      role: "admin",
    });
    await fixture.pool.query(
      "INSERT INTO agent_memory_cutover(generation) VALUES (1)",
    );
    await fixture.pool.query(
      `INSERT INTO agents(id,package_name,version_label,origin,name,description,workspace,mode,triggers,risk_tier,source_path)
      VALUES ($1,'fixture','v1','git','Preview author','Fixture','none','session','[]','read_only','/unused/inbox-preview.md')`,
      [agentId],
    );
    await fixture.pool.query(
      `INSERT INTO agent_project_links(id,project_id,agent_id,memory_enabled)
      VALUES (gen_random_uuid()::text,$1,$2,true)`,
      [project.id, agentId],
    );
    const prepare = prepareHumanProjectVault({
      userId,
      slug: project.slug,
      agentId,
      action: "editSettings",
    });
    const limits = agentMemoryVaultLimits();
    const oldPrefix = "/memories/notes/old";
    const newPrefix = "/memories/notes/new";
    const notes = [];

    for (const index of [1, 2, 3]) {
      const path = `${oldPrefix}/${index}.md`;
      const target = `${newPrefix}/${index}.md`;
      const content = "🙂".repeat(32_500) + String(index);
      const saved = await applyVaultMutation(
        fixture.db,
        parseAgentMemoryMutation({
          command: "create",
          path,
          file_text: content,
          ifHash: null,
          ifRevisionId: null,
          requestKey: `preview-note-${index}`,
        }),
        prepare,
        limits,
      );

      if (saved.status !== "applied")
        throw new Error("Expected a saved preview fixture");
      const { noteId, hash, revisionId } = saved.affected[0]!;

      notes.push({ path, target, content, noteId, hash, revisionId });
    }
    const pending = await applyVaultMutation(
      fixture.db,
      parseAgentMemoryMutation({
        command: "rename",
        old_path: oldPrefix,
        new_path: newPrefix,
        ifGeneration: "3",
        heads: notes.map(({ path, hash, revisionId }) => ({
          path,
          ifHash: hash,
          ifRevisionId: revisionId,
        })),
        requestKey: "large-preview-proposal",
      }),
      async (tx) => ({
        ...(await prepare(tx)),
        writeAdmission: "review_required",
      }),
      limits,
    );

    if (pending.status !== "pending")
      throw new Error("Expected a pending preview fixture");
    const read = (cursor?: string) => {
      const url = new URL(
        `http://localhost/api/inbox/reviews/vault/${pending.proposalId}`,
      );

      if (cursor !== undefined) url.searchParams.set("cursor", cursor);

      return GET(new Request(url), {
        params: Promise.resolve({
          kind: "vault",
          proposalId: pending.proposalId,
        }),
      });
    };
    const first = await read();

    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    const firstPage = (await first.json()) as Preview;

    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const firstCursor = firstPage.nextCursor!;

    userId = otherReviewer;
    expect((await read(firstCursor)).status).toBe(422);
    userId = reviewer;
    const segments = [firstPage.summary];
    let cursor = firstPage.nextCursor;

    while (cursor !== null) {
      expect(segments.length).toBeLessThan(32);
      const response = await read(cursor);

      expect(response.status).toBe(200);
      const page = (await response.json()) as Preview;

      segments.push(page.summary);
      cursor = page.nextCursor;
    }
    const expected = notes
      .sort((a, b) => a.noteId.localeCompare(b.noteId))
      .map(
        ({ path, target, content }) =>
          `--- ${path}\n+++ ${target}\n-${content}\n+${content}`,
      )
      .join("\n");

    expect(
      segments.every(
        (segment) =>
          segment.length > 0 &&
          segment.length <= 262_144 &&
          segment.isWellFormed(),
      ),
    ).toBe(true);
    expect(digest(segments.join(""))).toBe(digest(expected));
    await removeProjectMember(fixture.db, { projectId: project.id, userId });
    expect((await read(firstCursor)).status).toBe(404);
  } finally {
    vi.unstubAllEnvs();
    await fixture.stop();
  }
}, 180_000);

it("returns the complete draft for an oversized Brain proposal", async () => {
  fixture = await startMainAndBrainPostgresTestDb({
    databaseName: "inbox_review_brain_preview",
  });
  vi.stubEnv("AUTH_SECRET", "inbox-review-preview-test-secret");

  try {
    const project = await seedProjectRow(fixture.db);

    userId = await seedActiveUser(fixture.db, { role: "admin" });
    await fixture.pool.query(
      "UPDATE projects SET brain_enabled=true WHERE id=$1",
      [project.id],
    );
    const proposal = await createBrainProposal(fixture.db, {
      projectId: project.id,
      kind: "rule",
      evidenceItemIds: [],
      draft: {
        title: "Full draft",
        body: "🙂".repeat(135_000) + " final line",
      },
      blastRadius: "low",
      autonomyDecision: "manual",
      actor: { type: "user", id: userId },
    });
    const url = new URL(
      `http://localhost/api/inbox/reviews/brain/${proposal.id}`,
    );
    const read = () =>
      GET(new Request(url), {
        params: Promise.resolve({ kind: "brain", proposalId: proposal.id }),
      });
    const first = await read();

    expect(first.status).toBe(200);
    const initial = (await first.json()) as Preview;

    expect(initial.nextCursor).toEqual(expect.any(String));
    url.searchParams.set("cursor", initial.nextCursor!);
    const second = await read();

    expect(second.status).toBe(200);
    const final = (await second.json()) as Preview;

    expect(final.nextCursor).toBeNull();
    expect(digest(initial.summary + final.summary)).toBe(
      digest(JSON.stringify(proposal.draft, null, 2)),
    );
  } finally {
    vi.unstubAllEnvs();
    await fixture.stop();
  }
}, 180_000);
