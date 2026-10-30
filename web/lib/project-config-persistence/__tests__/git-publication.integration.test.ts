import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import * as gitModule from "../git";
import { git, gitResult } from "../git";
import {
  previewProjectConfiguration,
  confirmProjectConfiguration,
} from "../service";
import { cleanupConfigOperation, pruneConfigReviews } from "../cleanup";
import { recoverProjectConfigurations } from "../reconcile";
import {
  findConfigOperation,
  insertConfigReview,
  transitionConfigOperation,
} from "../store";

import { projects, users } from "@/lib/db/schema";
import {
  startMainPostgresTestDb,
  type StartedPostgresTestDb,
} from "@/test-support/pg-container";

let database: StartedPostgresTestDb;
let root: string;
const actorUserId = randomUUID();
const priorWorktrees = process.env.MAISTER_WORKTREES_ROOT;

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  getDb: () => database.db,
}));

beforeAll(async () => {
  database = await startMainPostgresTestDb({
    databaseName: "config_git_publication",
  });
  root = await mkdtemp(join(tmpdir(), "config-git-publication-"));
  process.env.MAISTER_WORKTREES_ROOT = join(root, "private");
  await database.db.insert(users).values({
    id: actorUserId,
    email: `${actorUserId}@example.invalid`,
    role: "admin",
    accountStatus: "active",
    mustChangePassword: false,
  });
}, 180_000);

afterAll(async () => {
  if (priorWorktrees === undefined) delete process.env.MAISTER_WORKTREES_ROOT;
  else process.env.MAISTER_WORKTREES_ROOT = priorWorktrees;
  await database?.stop();
  await rm(root, { recursive: true, force: true });
});

async function seed(): Promise<{ projectId: string; repo: string }> {
  const projectId = randomUUID();
  const repo = join(root, projectId);

  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Config Test"]);
  await git(repo, ["config", "user.email", "config@example.invalid"]);
  await database.db.insert(projects).values({
    id: projectId,
    slug: `p-${projectId}`,
    name: "Runtime",
    repoPath: repo,
    taskKey: `CP${projectId.slice(0, 8).toUpperCase()}`,
  });

  return { projectId, repo };
}

async function ready(projectId: string): Promise<string> {
  const preview = await previewProjectConfiguration(
    database.db,
    projectId,
    actorUserId,
  );

  expect(preview.kind).toBe("ready");
  if (preview.kind !== "ready")
    throw new Error("Expected a confirmable review");

  return preview.previewId;
}

const authorized = async (): Promise<void> => {};

it("IT-CPC-01/02: unborn first save, repeated save, no-op and replay publish only the reviewed manifest", async () => {
  const { projectId, repo } = await seed();
  const id = await ready(projectId);
  const identity = { id, projectId, actorUserId };
  const first = await confirmProjectConfiguration(
    database.db,
    identity,
    authorized,
  );

  expect(first.state).toBe("committed");
  expect(first.committedSha).toMatch(/^[a-f0-9]{40}$/u);
  expect((await git(repo, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
  expect(await git(repo, ["status", "--porcelain=v1"])).toBe("");
  expect(
    await confirmProjectConfiguration(database.db, identity, authorized),
  ).toMatchObject({ state: "committed", committedSha: first.committedSha });
  expect(
    (await previewProjectConfiguration(database.db, projectId, actorUserId))
      .kind,
  ).toBe("noop");
  await database.db
    .update(projects)
    .set({ name: "Updated runtime", defaultRunnerId: "runner-new" })
    .where(eq(projects.id, projectId));
  const secondId = await ready(projectId);
  const second = await confirmProjectConfiguration(
    database.db,
    { ...identity, id: secondId },
    authorized,
  );

  expect(second.committedSha).not.toBe(first.committedSha);
  expect((await git(repo, ["rev-parse", "HEAD^"])).trim()).toBe(
    first.committedSha,
  );
  expect(
    await git(repo, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "HEAD",
    ]),
  ).toBe("maister.yaml\n");
  expect(await readFile(join(repo, "maister.yaml"), "utf8")).toContain(
    "runner-new",
  );
  expect(await git(repo, ["status", "--porcelain=v1"])).toBe("");
});

it.each([
  [
    "additional path",
    "printf unrelated > unrelated.txt\ngit add -- unrelated.txt\n",
  ],
  [
    "changed manifest",
    "printf '\\n# hook change\\n' >> maister.yaml\ngit add -- maister.yaml\n",
  ],
  ["hook failure", "exit 1\n"],
  ["missing signer", "exit 0\n"],
])(
  "IT-CPC-08: %s cannot publish or contaminate the user's index",
  async (_label, hook) => {
    const { projectId, repo } = await seed();
    // Keep the policy directory outside the tracked/untracked project surface.
    const privateHooks = join(root, `hooks-${projectId}`);

    await mkdir(privateHooks);
    await writeFile(join(privateHooks, "pre-commit"), `#!/bin/sh\n${hook}`, {
      mode: 0o700,
    });
    await git(repo, ["config", "core.hooksPath", privateHooks]);
    if (_label === "missing signer") {
      await git(repo, ["config", "commit.gpgSign", "true"]);
      await git(repo, ["config", "gpg.program", join(root, "unavailable-gpg")]);
    }
    const id = await ready(projectId);

    await expect(
      confirmProjectConfiguration(
        database.db,
        { id, projectId, actorUserId },
        authorized,
      ),
    ).rejects.toMatchObject({ details: { reason: "commit_failed" } });
    expect(await git(repo, ["ls-files", "--stage", "-z"])).toBe("");
    expect(await git(repo, ["status", "--porcelain=v1"])).toBe("");
    expect(
      await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(
        () => "",
      ),
    ).toBe("");
  },
);

it("IT-CPC-05/09: staged/user edits, DB revision and Git policy changes invalidate review without effects", async () => {
  const { projectId, repo } = await seed();
  const id = await ready(projectId);

  await writeFile(join(repo, "operator.txt"), "keep me\n");
  await git(repo, ["add", "--", "operator.txt"]);
  const index = await readFile(join(repo, ".git", "index"));

  await expect(
    confirmProjectConfiguration(
      database.db,
      { id, projectId, actorUserId },
      authorized,
    ),
  ).rejects.toMatchObject({ code: "PRECONDITION" });
  expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
  expect(await readFile(join(repo, "operator.txt"), "utf8")).toBe("keep me\n");
  const other = await seed();
  const staleId = await ready(other.projectId);

  await database.db
    .update(projects)
    .set({ name: "Concurrent" })
    .where(eq(projects.id, other.projectId));
  await expect(
    confirmProjectConfiguration(
      database.db,
      { id: staleId, projectId: other.projectId, actorUserId },
      authorized,
    ),
  ).rejects.toMatchObject({ details: { reason: "stale_preview" } });
  expect(await git(other.repo, ["status", "--porcelain=v1"])).toBe("");
  const policyId = await ready(other.projectId);

  await git(other.repo, ["config", "user.email", "changed@example.invalid"]);
  await expect(
    confirmProjectConfiguration(
      database.db,
      { id: policyId, projectId: other.projectId, actorUserId },
      authorized,
    ),
  ).rejects.toMatchObject({ details: { reason: "stale_preview" } });
});

async function rejectReceipt(
  operationId: string,
  state: string,
): Promise<() => Promise<void>> {
  await database.pool.query(
    `CREATE FUNCTION config_test_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${operationId}' AND NEW.state = '${state}' THEN RAISE EXCEPTION 'injected receipt outage' USING ERRCODE='08006'; END IF; RETURN NEW; END; $$`,
  );
  await database.pool.query(
    "CREATE TRIGGER config_test_receipt_fault BEFORE UPDATE ON project_config_persist_operations FOR EACH ROW EXECUTE FUNCTION config_test_receipt_fault()",
  );

  return async () => {
    await database.pool.query(
      "DROP TRIGGER config_test_receipt_fault ON project_config_persist_operations",
    );
    await database.pool.query("DROP FUNCTION config_test_receipt_fault()");
  };
}

it("IT-CPC-08/09: lost prepared receipt adopts the private SHA without another commit", async () => {
  const { projectId, repo } = await seed();
  const id = await ready(projectId);
  const identity = { id, projectId, actorUserId };
  const restore = await rejectReceipt(id, "prepared");

  try {
    await expect(
      confirmProjectConfiguration(database.db, identity, authorized),
    ).rejects.toBeDefined();
  } finally {
    await restore();
  }
  const prepared = (
    await git(repo, ["rev-parse", `refs/maister/config-persist/${id}`])
  ).trim();

  expect(await git(repo, ["ls-files", "--stage", "-z"])).toBe("");
  expect(await recoverProjectConfigurations(database.db)).toEqual({
    inspected: 1,
    committed: 1,
    retained: 0,
  });
  const recovered = await findConfigOperation(database.db, identity);

  expect(recovered).toMatchObject({
    state: "committed",
    preparedSha: prepared,
    committedSha: prepared,
  });
  expect((await git(repo, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
});

it("IT-CPC-08/09: lost final receipt reconciles the published ancestor after archive/revocation without resetting later work", async () => {
  const { projectId, repo } = await seed();
  const id = await ready(projectId);
  const identity = { id, projectId, actorUserId };
  const restore = await rejectReceipt(id, "committed");

  try {
    await expect(
      confirmProjectConfiguration(database.db, identity, authorized),
    ).rejects.toBeDefined();
  } finally {
    await restore();
  }
  const published = (await git(repo, ["rev-parse", "HEAD"])).trim();

  await writeFile(join(repo, "later.txt"), "operator's later commit\n");
  await git(repo, ["add", "--", "later.txt"]);
  await git(repo, ["commit", "-m", "later operator work"]);
  const later = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const index = await readFile(join(repo, ".git", "index"));

  await database.db
    .update(projects)
    .set({ archivedAt: new Date() })
    .where(eq(projects.id, projectId));
  const original = await findConfigOperation(database.db, identity);

  if (!original) throw new Error("Missing accepted fixture operation");
  for (let index = 1; index <= 51; index += 1) {
    const unavailableProject = randomUUID();
    const unavailableRepo = join(root, `unavailable-${unavailableProject}`);

    await database.db.insert(projects).values({
      id: unavailableProject,
      slug: `unavailable-${unavailableProject}`,
      name: "Runtime",
      repoPath: unavailableRepo,
      taskKey: `UP${unavailableProject.slice(0, 8).toUpperCase()}`,
    });
    const poison = {
      id: `00000000-0000-1000-8000-${index.toString(16).padStart(12, "0")}`,
      projectId: unavailableProject,
      actorUserId,
    };

    await insertConfigReview(database.db, poison, {
      ...original.snapshot,
      projectId: unavailableProject,
      registeredRepoPath: unavailableRepo,
      repository: {
        ...original.snapshot.repository,
        repoPath: unavailableRepo,
        commonDirectory: `${unavailableRepo}/.git`,
      },
      contentDirectory: join(root, `unavailable-output-${unavailableProject}`),
    });
    await transitionConfigOperation(
      database.db,
      poison,
      { state: "previewed", ownerToken: null },
      {
        state: "preparing",
        acceptedAt: new Date(),
        ownerToken: randomUUID(),
        ownerProcessId: process.pid,
      },
    );
  }
  expect(await recoverProjectConfigurations(database.db)).toEqual({
    inspected: 52,
    committed: 1,
    retained: 51,
  });
  expect(await recoverProjectConfigurations(database.db)).toEqual({
    inspected: 51,
    committed: 0,
    retained: 51,
  });
  const recovered = await findConfigOperation(database.db, identity);

  expect(recovered).toMatchObject({
    state: "committed",
    committedSha: published,
  });
  expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(later);
  expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
});

it.each([false, true])(
  "IT-CPC-08: forward recovery of an exact partial publication protects later operator edits (%s)",
  async (operatorEdit) => {
    const { projectId, repo } = await seed();
    const hooks = join(root, `partial-hooks-${projectId}`);
    const marker = join(root, `partial-once-${projectId}`);

    await mkdir(hooks);
    const script = `#!${process.execPath}\nconst fs=require('node:fs');const cp=require('node:child_process');const input=fs.readFileSync(0,'utf8');const line=input.split('\\n').find(l=>l.endsWith(' refs/heads/main'));if(process.argv[2]==='prepared'&&line&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'once');const [old,next]=line.split(' ');const env={...process.env};delete env.GIT_DIR;delete env.GIT_INDEX_FILE;delete env.GIT_WORK_TREE;cp.execFileSync('git',['-C',${JSON.stringify(repo)},'read-tree','-m','-u',old==='0'.repeat(40)?'4b825dc642cb6eb9a060e54bf8d69288fbee4904':old,next],{env});process.exit(1);}\n`;

    await writeFile(join(hooks, "reference-transaction"), script, {
      mode: 0o700,
    });
    await git(repo, ["config", "core.hooksPath", hooks]);
    const id = await ready(projectId);
    const identity = { id, projectId, actorUserId };

    await expect(
      confirmProjectConfiguration(database.db, identity, authorized),
    ).rejects.toMatchObject({ details: { reason: "recovery_required" } });
    const proposed = await readFile(join(repo, "maister.yaml"), "utf8");
    const index = await readFile(join(repo, ".git", "index"));

    if (operatorEdit) {
      await writeFile(
        join(repo, "maister.yaml"),
        `${proposed}# preserve my edit\n`,
      );
      await expect(
        confirmProjectConfiguration(database.db, identity, authorized),
      ).rejects.toMatchObject({ details: { reason: "recovery_required" } });
      expect(await readFile(join(repo, "maister.yaml"), "utf8")).toBe(
        `${proposed}# preserve my edit\n`,
      );
      expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
      await writeFile(join(repo, "maister.yaml"), proposed);
    }
    const recovered = await confirmProjectConfiguration(
      database.db,
      identity,
      authorized,
    );

    expect(recovered.state).toBe("committed");
    expect((await git(repo, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
    expect(await git(repo, ["status", "--porcelain=v1"])).toBe("");
  },
);

it.each(["database-path", "symlink-target"])(
  "IT-CPC-05: confirmation refuses repository relocation (%s)",
  async (relocation) => {
    const { projectId, repo } = await seed();
    const other = await seed();
    const alias = join(root, `repo-alias-${projectId}`);

    await symlink(repo, alias);
    await database.db
      .update(projects)
      .set({ repoPath: alias })
      .where(eq(projects.id, projectId));
    const id = await ready(projectId);

    if (relocation === "database-path") {
      const otherAlias = join(root, `other-alias-${projectId}`);

      await symlink(other.repo, otherAlias);
      await database.db
        .update(projects)
        .set({ repoPath: otherAlias })
        .where(eq(projects.id, projectId));
    } else {
      await unlink(alias);
      await symlink(other.repo, alias);
    }
    await expect(
      confirmProjectConfiguration(
        database.db,
        { id, projectId, actorUserId },
        authorized,
      ),
    ).rejects.toMatchObject({ details: { reason: "stale_preview" } });
    expect(await git(repo, ["ls-files", "--stage", "-z"])).toBe("");
    expect(await git(other.repo, ["ls-files", "--stage", "-z"])).toBe("");
  },
);

it("IT-CPC-03/07: source identifier collisions are blocked by the registration validation contract", async () => {
  const { projectId, repo } = await seed();
  const source =
    "schemaVersion: 2\nproject:\n  name: Runtime\nflows:\n  - id: duplicate\n    source: file:///source\n    version: v1\n  - id: duplicate\n    source: file:///source\n    version: v1\n";

  await writeFile(join(repo, "maister.yaml"), source);
  await git(repo, ["add", "--", "maister.yaml"]);
  await git(repo, ["commit", "-m", "operator source"]);
  const index = await readFile(join(repo, ".git", "index"));
  const preview = await previewProjectConfiguration(
    database.db,
    projectId,
    actorUserId,
  );

  expect(preview).toMatchObject({
    kind: "blocked",
    reason: "manifest_invalid",
    status: { exportState: "blocked" },
  });
  expect(await readFile(join(repo, "maister.yaml"), "utf8")).toBe(source);
  expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
});

it("IT-CPC-05: an operator edit at the locked publication seam preserves the edit and requires a fresh review", async () => {
  const { projectId, repo } = await seed();
  const source = "schemaVersion: 2\nproject:\n  name: Before\nflows: []\n";

  await writeFile(join(repo, "maister.yaml"), source);
  await git(repo, ["add", "--", "maister.yaml"]);
  await git(repo, ["commit", "-m", "original source"]);
  const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const hooks = join(root, `editor-hooks-${projectId}`);
  const marker = join(root, `editor-once-${projectId}`);
  const edited = `${source}# operator edit at the seam\n`;

  await mkdir(hooks);
  await writeFile(
    join(hooks, "reference-transaction"),
    `#!${process.execPath}\nconst fs=require('node:fs');const input=fs.readFileSync(0,'utf8');if(process.argv[2]==='prepared'&&input.split('\\n').some(line=>line.endsWith(' refs/heads/main'))&&!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'once');fs.writeFileSync(${JSON.stringify(join(repo, "maister.yaml"))},${JSON.stringify(edited)}); }\n`,
    { mode: 0o700 },
  );
  await git(repo, ["config", "core.hooksPath", hooks]);
  const id = await ready(projectId);
  const index = await readFile(join(repo, ".git", "index"));
  const identity = { id, projectId, actorUserId };

  await expect(
    confirmProjectConfiguration(database.db, identity, authorized),
  ).rejects.toMatchObject({ details: { reason: "stale_preview" } });
  expect(await findConfigOperation(database.db, identity)).toMatchObject({
    state: "stale",
  });
  expect(await readFile(join(repo, "maister.yaml"), "utf8")).toBe(edited);
  expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
  expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(head);
  await git(repo, ["add", "--", "maister.yaml"]);
  await git(repo, ["commit", "-m", "preserve operator edit"]);
  const fresh = await previewProjectConfiguration(
    database.db,
    projectId,
    actorUserId,
  );

  expect(fresh.kind).toBe("ready");
  if (fresh.kind === "ready") expect(fresh.previewId).not.toBe(id);
});

it("IT-CPC-05/09: no-op locator repair checks repository relocation in its transaction", async () => {
  const { projectId, repo } = await seed();
  const other = await seed();

  await writeFile(
    join(repo, "maister.yaml"),
    "schemaVersion: 2\nproject:\n  name: Runtime\nflows: []\n",
  );
  await git(repo, ["add", "--", "maister.yaml"]);
  await git(repo, ["commit", "-m", "manual configuration"]);
  const index = await readFile(join(repo, ".git", "index"));

  await database.pool.query(
    `CREATE FUNCTION config_noop_relocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.project_id='${projectId}' THEN UPDATE projects SET repo_path=(SELECT repo_path || '/.' FROM projects WHERE id='${other.projectId}') WHERE id='${projectId}'; END IF; RETURN NEW; END; $$`,
  );
  await database.pool.query(
    "CREATE TRIGGER config_noop_relocation BEFORE INSERT ON project_config_persist_operations FOR EACH ROW EXECUTE FUNCTION config_noop_relocation()",
  );
  try {
    await expect(
      previewProjectConfiguration(database.db, projectId, actorUserId),
    ).rejects.toMatchObject({ details: { reason: "stale_preview" } });
    const project = await database.pool.query<{
      maister_yaml_path: string | null;
    }>("SELECT maister_yaml_path FROM projects WHERE id=$1", [projectId]);

    expect(project.rows[0]?.maister_yaml_path).toBeNull();
    expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
    expect(await git(other.repo, ["ls-files", "--stage", "-z"])).toBe("");
  } finally {
    await database.pool.query(
      "DROP TRIGGER config_noop_relocation ON project_config_persist_operations",
    );
    await database.pool.query("DROP FUNCTION config_noop_relocation()");
  }
});

it("IT-CPC-10: signalled Git after a private commit retains the same SHA for recovery", async () => {
  const { projectId, repo } = await seed();
  const hooks = join(root, `signal-hooks-${projectId}`);

  await mkdir(hooks);
  await writeFile(
    join(hooks, "post-commit"),
    '#!/bin/sh\nkill -KILL "$PPID"\n',
    { mode: 0o700 },
  );
  await git(repo, ["config", "core.hooksPath", hooks]);
  const id = await ready(projectId);
  const identity = { id, projectId, actorUserId };

  await expect(
    confirmProjectConfiguration(database.db, identity, authorized),
  ).rejects.toMatchObject({ code: "EXECUTOR_UNAVAILABLE" });
  const interrupted = await findConfigOperation(database.db, identity);

  expect(interrupted).toMatchObject({
    state: "recovery_required",
    committedSha: null,
  });
  if (!interrupted) throw new Error("Missing interrupted fixture operation");
  const sha = (
    await git(join(interrupted.snapshot.contentDirectory, "worktree"), [
      "rev-parse",
      "HEAD",
    ])
  ).trim();
  const recovered = await confirmProjectConfiguration(
    database.db,
    identity,
    authorized,
  );

  expect(recovered).toMatchObject({ state: "committed", committedSha: sha });
  expect((await git(repo, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
});

it("IT-CPC-10: private cleanup retains unknown output, retries partial removal, and prunes expired unused reviews", async () => {
  const { projectId, repo } = await seed();
  const id = await ready(projectId);
  const identity = { id, projectId, actorUserId };
  const receipt = await confirmProjectConfiguration(
    database.db,
    identity,
    authorized,
  );
  const unexpected = join(receipt.snapshot.contentDirectory, "operator-note");

  await writeFile(unexpected, "preserve this evidence\n");
  await cleanupConfigOperation(database.db, receipt, authorized);
  expect(await findConfigOperation(database.db, identity)).toMatchObject({
    state: "committed",
    cleanupState: "retained",
    cleanupReason: "unexpected_private_content",
  });
  expect(await readFile(unexpected, "utf8")).toBe("preserve this evidence\n");
  await unlink(unexpected);
  // A previous cleanup can have removed a verified file before an I/O failure.
  await unlink(join(receipt.snapshot.contentDirectory, "after"));
  await cleanupConfigOperation(database.db, receipt, authorized);
  expect(await findConfigOperation(database.db, identity)).toMatchObject({
    state: "committed",
    cleanupState: "complete",
    cleanupReason: null,
  });
  await expect(
    readFile(join(receipt.snapshot.contentDirectory, "operation.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(
    receipt.committedSha,
  );

  await database.db
    .update(projects)
    .set({ name: "Unused review" })
    .where(eq(projects.id, projectId));
  const expiredId = await ready(projectId);
  // Expiry is immutable: insert a reviewed snapshot with an already-expired timestamp.
  const preview = (await findConfigOperation(database.db, {
    ...identity,
    id: expiredId,
  }))!;
  const expiredCopy = randomUUID();

  await database.pool.query(
    `INSERT INTO project_config_persist_operations (id,project_id,actor_user_id,repository_key,snapshot,snapshot_digest,expires_at) SELECT $1,project_id,actor_user_id,repository_key,snapshot,snapshot_digest,now()-interval '1 second' FROM project_config_persist_operations WHERE id=$2`,
    [expiredCopy, expiredId],
  );
  await pruneConfigReviews(database.db);
  expect(
    await findConfigOperation(database.db, { ...identity, id: expiredCopy }),
  ).toMatchObject({
    state: "stale",
    errorReason: "preview_expired",
    cleanupState: "retained",
  });
  // The copied row cannot authorize removal of the original operation's directory.
  expect(
    await readFile(
      join(preview.snapshot.contentDirectory, "operation.json"),
      "utf8",
    ),
  ).toContain(expiredId);
  expect(
    await findConfigOperation(database.db, { ...identity, id: expiredId }),
  ).toMatchObject({ state: "previewed", cleanupState: "pending" });
});

it("IT-CPC-10: expiry removes only an unused owned review and cannot publish it", async () => {
  const { projectId, repo } = await seed();
  let expiredId: string;

  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - 11 * 60_000);
  try {
    expiredId = await ready(projectId);
  } finally {
    vi.useRealTimers();
  }
  const identity = { id: expiredId, projectId, actorUserId };
  const reviewed = (await findConfigOperation(database.db, identity))!;

  await pruneConfigReviews(database.db);
  expect(await findConfigOperation(database.db, identity)).toMatchObject({
    state: "stale",
    errorReason: "preview_expired",
    cleanupState: "complete",
  });
  await expect(
    readFile(join(reviewed.snapshot.contentDirectory, "operation.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    await confirmProjectConfiguration(database.db, identity, authorized),
  ).toMatchObject({ state: "stale", committedSha: null });
  expect(
    (await gitResult(repo, ["rev-parse", "--verify", "HEAD"])).code,
  ).not.toBe(0);
});

it("IT-CPC-04: explicitly disabled Git hooks preserve normal commit policy", async () => {
  const { projectId, repo } = await seed();

  await git(repo, ["config", "core.hooksPath", "/dev/null"]);
  const id = await ready(projectId);

  expect(
    await confirmProjectConfiguration(
      database.db,
      { id, projectId, actorUserId },
      authorized,
    ),
  ).toMatchObject({ state: "committed" });
  expect(await git(repo, ["status", "--porcelain=v1"])).toBe("");
});

it("IT-CPC-04: a linked pre-commit hook does not redirect other reviewed hooks", async () => {
  const { projectId, repo } = await seed();
  const hooks = join(root, `hooks-${projectId}`);
  const shared = join(root, `shared-${projectId}`);
  const marker = join(root, `hook-observed-${projectId}`);

  await mkdir(hooks);
  await mkdir(shared);
  await writeFile(
    join(shared, "pre-commit"),
    `#!/bin/sh\necho pre >> '${marker}'\n`,
    { mode: 0o700 },
  );
  await symlink(join(shared, "pre-commit"), join(hooks, "pre-commit"));
  await writeFile(
    join(hooks, "commit-msg"),
    `#!/bin/sh\necho message >> '${marker}'\n`,
    { mode: 0o700 },
  );
  await git(repo, ["config", "core.hooksPath", hooks]);
  const id = await ready(projectId);

  expect(
    await confirmProjectConfiguration(
      database.db,
      { id, projectId, actorUserId },
      authorized,
    ),
  ).toMatchObject({ state: "committed" });
  expect(await readFile(marker, "utf8")).toBe("pre\nmessage\n");
});

it("IT-CPC-08/09: staging at the read-tree seam cannot publish against a changed caller index", async () => {
  const { projectId, repo } = await seed();

  await writeFile(join(repo, "README.md"), "baseline\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "baseline"]);
  const before = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const id = await ready(projectId);
  const canonicalRepo = await realpath(repo);
  const originalGit = gitModule.git;
  let staged = false;
  const seam = vi
    .spyOn(gitModule, "git")
    .mockImplementation(async (cwd, args) => {
      if (
        !staged &&
        cwd === canonicalRepo &&
        args[0] === "read-tree" &&
        args.includes("-u")
      ) {
        staged = true;
        await writeFile(join(repo, "operator.txt"), "staged by the operator\n");
        await originalGit(repo, ["add", "operator.txt"]);
      }

      return originalGit(cwd, args);
    });

  let failure: unknown;

  try {
    await confirmProjectConfiguration(
      database.db,
      { id, projectId, actorUserId },
      authorized,
    );
  } catch (error) {
    failure = error;
  } finally {
    seam.mockRestore();
  }
  expect(
    staged,
    "the real operator stage must execute at the intended seam",
  ).toBe(true);
  expect(failure).toMatchObject({ details: { reason: "recovery_required" } });
  expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(before);
  expect(await readFile(join(repo, "operator.txt"), "utf8")).toBe(
    "staged by the operator\n",
  );
  expect(await git(repo, ["diff", "--cached", "--name-only"])).toContain(
    "operator.txt",
  );
});

it("IT-CPC-04/07: a non-UTF-8 manifest is refused instead of silently changing unrelated comment bytes", async () => {
  const { projectId, repo } = await seed();
  const source = Buffer.concat([
    Buffer.from("# original comment "),
    Buffer.from([0xff]),
    Buffer.from("\nschemaVersion: 2\nproject:\n  name: Existing\n"),
  ]);

  await writeFile(join(repo, "maister.yaml"), source);
  await git(repo, ["add", "maister.yaml"]);
  await git(repo, ["commit", "-m", "existing encoded source"]);
  const before = (await git(repo, ["rev-parse", "HEAD"])).trim();

  await expect(
    previewProjectConfiguration(database.db, projectId, actorUserId),
  ).rejects.toMatchObject({
    code: "PRECONDITION",
    details: { reason: "unsupported_checkout" },
  });
  expect(await readFile(join(repo, "maister.yaml"))).toEqual(source);
  expect((await git(repo, ["rev-parse", "HEAD"])).trim()).toBe(before);
  expect(await git(repo, ["status", "--porcelain=v1"])).toBe("");
});
