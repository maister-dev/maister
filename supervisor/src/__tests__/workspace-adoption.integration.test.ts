// ADR-166 T2.3 — workspace adoption + handle-based create (W1–W13).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  bootHost,
  cleanupRuntimeRoot,
  envelope,
  FIXTURES_DIR,
  postJson,
  type BootedHost,
} from "./_fixtures/boot-host";

const booted: BootedHost[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const host of booted.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await cleanupRuntimeRoot(root);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

type Lab = {
  host: BootedHost;
  root: string;
  wtRoot: string;
  repo: string;
  worktree: string;
  runId: string;
};

async function lab(): Promise<Lab> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eh-adopt-")));

  roots.push(root);
  const wtRoot = join(root, "worktrees");
  const repo = join(root, "repos", "demo");

  await mkdir(wtRoot, { recursive: true });
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const runId = `run-${randomUUID().slice(0, 8)}`;
  const worktree = join(wtRoot, "demo", runId);

  await mkdir(join(wtRoot, "demo"), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", `wt-${runId}`, worktree);

  const host = await bootHost({
    runtimeRoot: root,
    workspaceRoots: [wtRoot],
    fixtureArgs: ["--hang"],
  });

  booted.push(host);

  return { host, root, wtRoot, repo, worktree, runId };
}

function adoptBody(
  l: Lab,
  payload: Record<string, unknown>,
  commandId?: string,
) {
  return envelope(
    "workspace.adopt",
    {
      hostKey: l.host.hostState.hostKey,
      runId: (payload.runId as string) ?? l.runId,
    },
    payload,
    commandId,
  );
}

async function adopt(l: Lab, payload: Record<string, unknown>) {
  return postJson(`${l.host.url}/workspaces/adopt`, adoptBody(l, payload));
}

describe("workspace adoption", () => {
  it("W1: a valid git_worktree adopts; re-adoption returns the same id with replayed:true", async () => {
    const l = await lab();
    const payload = {
      runId: l.runId,
      projectSlug: "demo",
      kind: "git_worktree",
      path: l.worktree,
      repoPath: l.repo,
    };
    const first = await adopt(l, payload);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ kind: "git_worktree", replayed: false });
    expect(first.body.executionWorkspaceId).toMatch(/^ws_[0-9a-f]{32}$/);

    const again = await adopt(l, payload);

    expect(again.body).toEqual({ ...first.body, replayed: true });
  });

  it("W2: a repo_checkout at an arbitrary location adopts", async () => {
    const l = await lab();
    const res = await adopt(l, {
      runId: l.runId,
      projectSlug: "demo",
      kind: "repo_checkout",
      path: l.repo,
      repoPath: l.repo,
    });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("repo_checkout");
  });

  it("W3: a plain directory under the roots adopts", async () => {
    const l = await lab();
    const dir = join(l.wtRoot, "plain");

    await mkdir(dir);
    const res = await adopt(l, {
      runId: l.runId,
      projectSlug: "demo",
      kind: "directory",
      path: dir,
    });

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("directory");
  });

  it("W4: the same path adopted by two runs yields two handles", async () => {
    const l = await lab();
    const dir = join(l.wtRoot, "shared");

    await mkdir(dir);
    const a = await adopt(l, {
      runId: l.runId,
      projectSlug: "demo",
      kind: "directory",
      path: dir,
    });
    const b = await adopt(l, {
      runId: `${l.runId}-b`,
      projectSlug: "demo",
      kind: "directory",
      path: dir,
    });

    expect(a.body.executionWorkspaceId).not.toBe(b.body.executionWorkspaceId);
  });

  it("W5: the rejection matrix names the rule token per case", async () => {
    const l = await lab();
    const outside = await realpath(
      await mkdtemp(join(tmpdir(), "eh-outside-")),
    );

    roots.push(outside);
    const outsideRepo = join(outside, "repo-b");

    await mkdir(outsideRepo);
    git(outsideRepo, "init", "-q", "-b", "main");
    const linked = join(l.wtRoot, "linked");

    await symlink(outside, linked);
    const missingRepoWorktree = join(l.wtRoot, "not-a-worktree");

    await mkdir(missingRepoWorktree);

    const cases: Array<[string, Record<string, unknown>]> = [
      ["relative_path", { kind: "directory", path: "relative/dir" }],
      ["parent_segment", { kind: "directory", path: `${l.wtRoot}/../x` }],
      ["not_found", { kind: "directory", path: join(l.wtRoot, "missing") }],
      ["outside_roots", { kind: "directory", path: outside }],
      ["symlink_escape", { kind: "directory", path: linked }],
      [
        "gitdir_mismatch",
        { kind: "git_worktree", path: l.worktree, repoPath: outsideRepo },
      ],
      [
        "not_a_repo",
        { kind: "git_worktree", path: l.worktree, repoPath: l.wtRoot },
      ],
      [
        "repo_path_mismatch",
        { kind: "repo_checkout", path: l.repo, repoPath: outsideRepo },
      ],
      // A linked worktree (`.git` FILE) is never a repo root.
      [
        "not_a_repo",
        { kind: "repo_checkout", path: l.worktree, repoPath: l.worktree },
      ],
      ["inside_state_dir", { kind: "directory", path: l.host.stateDir }],
    ];

    for (const [rule, payload] of cases) {
      const res = await adopt(l, {
        runId: l.runId,
        projectSlug: "demo",
        ...payload,
      });

      expect(res.status, rule).toBe(409);
      expect(res.body.code, rule).toBe("PRECONDITION");
      expect(res.body.details, rule).toEqual({
        reason: "workspace_rejected",
        rule,
      });
    }
  });

  it("W6: create with an unknown handle is unknown_workspace; with a released handle is workspace_released", async () => {
    const l = await lab();
    const create = (executionWorkspaceId: string) =>
      postJson(
        `${l.host.url}/sessions`,
        envelope(
          "session.create",
          { hostKey: l.host.hostState.hostKey, runId: l.runId },
          {
            executionWorkspaceId,
            stepId: "step-1",
            executor: { agent: "claude", model: "claude-sonnet-4-6" },
          },
        ),
      );
    const unknown = await create(`ws_${"0".repeat(32)}`);

    expect(unknown.body.details.reason).toBe("unknown_workspace");

    const adopted = await adopt(l, {
      runId: l.runId,
      projectSlug: "demo",
      kind: "git_worktree",
      path: l.worktree,
      repoPath: l.repo,
    });
    const id = adopted.body.executionWorkspaceId as string;
    const release = await postJson(
      `${l.host.url}/workspaces/${id}`,
      envelope(
        "workspace.release",
        { hostKey: l.host.hostState.hostKey, runId: l.runId },
        {},
      ),
      "DELETE",
    );

    expect(release.body).toEqual({ released: true });
    const released = await create(id);

    expect(released.body.details.reason).toBe("workspace_released");
  });

  it("W7: a handle-form create derives cwd, step log, confinement roots, and the mounts from the handle", async () => {
    const l = await lab();
    const mountDir = join(l.root, "ctx", "api");

    await mkdir(mountDir, { recursive: true });
    git(mountDir, "init", "-q", "-b", "main");
    const mounts = [
      {
        slug: "api",
        path: mountDir,
        ref: "main",
        commit: "0123456789abcdef",
      },
    ];
    const recordPath = join(l.root, "handle.json");
    const adopted = await adopt(l, {
      runId: l.runId,
      projectSlug: "demo",
      kind: "git_worktree",
      path: l.worktree,
      repoPath: l.repo,
      contextMounts: mounts,
    });
    const handleHost = await bootHost({
      runtimeRoot: l.root,
      workspaceRoots: [l.wtRoot],
      fixture: "mock-acp-record-newsession.mjs",
      hostState: l.host.hostState,
    });

    // Shared-state consumers must stop before the fixture that owns the store.
    booted.unshift(handleHost);
    process.env.MOCK_ACP_NEWSESSION_RECORD_PATH = recordPath;
    const handle = await postJson(
      `${handleHost.url}/sessions`,
      envelope(
        "session.create",
        { hostKey: l.host.hostState.hostKey, runId: l.runId },
        {
          executionWorkspaceId: adopted.body.executionWorkspaceId,
          stepId: "plan",
          executor: { agent: "claude", model: "claude-sonnet-4-6" },
        },
      ),
    );

    expect(handle.status).toBe(201);
    delete process.env.MOCK_ACP_NEWSESSION_RECORD_PATH;
    const record = handleHost.registry.get(handle.body.sessionId)!.record;
    const runDir = join(l.root, ".maister", "demo", "runs", l.runId);

    // The adapter was spawned in the adopted worktree ...
    expect(JSON.parse(await readFile(recordPath, "utf8")).cwd).toBe(l.worktree);
    // ... and every session-bound path came from the handle, not the body.
    expect(record.worktreePath).toBe(l.worktree);
    expect(record.repoPath).toBe(l.repo);
    expect(record.confineRoot).toBeUndefined();
    expect(record.contextMounts).toEqual(mounts);
    expect(record.logPath).toBe(join(runDir, "plan.log"));
    expect(record.executionWorkspaceId).toBe(adopted.body.executionWorkspaceId);
    expect(record.runId).toBe(l.runId);
    expect(record.projectSlug).toBe("demo");
  });

  it("W8: legacy capabilityProfilePath is rejected before session creation", async () => {
    const l = await lab();
    const adopted = await adopt(l, {
      runId: l.runId,
      projectSlug: "demo",
      kind: "git_worktree",
      path: l.worktree,
      repoPath: l.repo,
    });
    const res = await postJson(
      `${l.host.url}/sessions`,
      envelope(
        "session.create",
        { hostKey: l.host.hostState.hostKey, runId: l.runId },
        {
          executionWorkspaceId: adopted.body.executionWorkspaceId,
          stepId: "plan",
          executor: { agent: "claude", model: "claude-sonnet-4-6" },
          capabilityProfilePath: join(l.repo, "profile.json"),
        },
      ),
    );

    expect(res.status).toBe(409);
    expect(res.body.details).toEqual({
      reason: "legacy_field",
      field: "capabilityProfilePath",
    });
  });

  it("W9: handles survive an in-process restart and GET /workspaces/:id never returns a path", async () => {
    const l = await lab();
    const adopted = await adopt(l, {
      runId: l.runId,
      projectSlug: "demo",
      kind: "git_worktree",
      path: l.worktree,
      repoPath: l.repo,
    });
    const id = adopted.body.executionWorkspaceId as string;
    const stateDir = l.host.stateDir;

    await l.host.stop();
    booted.splice(booted.indexOf(l.host), 1);
    const restarted = await bootHost({
      runtimeRoot: l.root,
      stateDir,
      workspaceRoots: [l.wtRoot],
      fixtureArgs: ["--hang"],
    });

    booted.push(restarted);
    const res = await fetch(`${restarted.url}/workspaces/${id}`);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      executionWorkspaceId: id,
      runId: l.runId,
      projectSlug: "demo",
      kind: "git_worktree",
      adoptedAt: expect.any(String),
      releasedAt: null,
    });
    expect(text).not.toContain(l.worktree);
    expect(text).not.toContain(l.repo);
    expect(FIXTURES_DIR).toBeTruthy();
  });

  it("W10: a released handle is history — re-adopting the same path mints a NEW active handle", async () => {
    const l = await lab();
    const payload = {
      runId: l.runId,
      projectSlug: "demo",
      kind: "git_worktree",
      path: l.worktree,
      repoPath: l.repo,
    };
    const first = await adopt(l, payload);
    const oldId = first.body.executionWorkspaceId as string;
    const release = await postJson(
      `${l.host.url}/workspaces/${oldId}`,
      envelope(
        "workspace.release",
        { hostKey: l.host.hostState.hostKey, runId: l.runId },
        {},
      ),
      "DELETE",
    );

    expect(release.body).toEqual({ released: true });

    const again = await adopt(l, payload);

    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(false);
    expect(again.body.executionWorkspaceId).toMatch(/^ws_[0-9a-f]{32}$/);
    expect(again.body.executionWorkspaceId).not.toBe(oldId);

    const old = (await (
      await fetch(`${l.host.url}/workspaces/${oldId}`)
    ).json()) as { releasedAt: string | null };
    const fresh = (await (
      await fetch(`${l.host.url}/workspaces/${again.body.executionWorkspaceId}`)
    ).json()) as { releasedAt: string | null };

    expect(old.releasedAt).toEqual(expect.any(String));
    expect(fresh.releasedAt).toBeNull();
    // The new handle is the one a re-adoption finds from now on.
    expect((await adopt(l, payload)).body).toEqual({
      ...again.body,
      replayed: true,
    });
  });

  it("W11: every context mount is validated as a git checkout — the rejection matrix names the rule and the mount", async () => {
    const l = await lab();
    const plain = join(l.wtRoot, "plain-mount");

    await mkdir(plain);

    const cases: Array<[string, string]> = [
      ["relative_path", "relative/mount"],
      ["parent_segment", `${l.wtRoot}/../mount`],
      ["not_found", join(l.wtRoot, "missing-mount")],
      ["inside_state_dir", l.host.stateDir],
      ["not_a_repo", plain],
    ];

    for (const [rule, path] of cases) {
      const res = await adopt(l, {
        runId: l.runId,
        projectSlug: "demo",
        kind: "git_worktree",
        path: l.worktree,
        repoPath: l.repo,
        contextMounts: [
          { slug: "api", path, ref: "main", commit: "0123456789abcdef" },
        ],
      });

      expect(res.status, rule).toBe(409);
      expect(res.body.code, rule).toBe("PRECONDITION");
      expect(res.body.details, rule).toEqual({
        reason: "workspace_rejected",
        rule,
        mount: "api",
      });
    }
  });

  it("W12: an accepted mount is stored by realpath, in either checkout shape (a detached linked worktree behind a symlink, or a repo root)", async () => {
    const l = await lab();
    const mounts = join(l.root, "mounts");
    const detached = join(mounts, "api-detached");
    const link = join(mounts, "api-link");

    await mkdir(mounts, { recursive: true });
    git(l.repo, "worktree", "add", "-q", "--detach", detached);
    await symlink(detached, link);

    const res = await adopt(l, {
      runId: l.runId,
      projectSlug: "demo",
      kind: "git_worktree",
      path: l.worktree,
      repoPath: l.repo,
      contextMounts: [
        { slug: "api", path: link, ref: "main", commit: "0123456789abcdef" },
        { slug: "lib", path: l.repo, ref: "main", commit: "0123456789abcdef" },
      ],
    });

    expect(res.status).toBe(200);

    const stored = l.host.hostState.getWorkspace(
      res.body.executionWorkspaceId as string,
    )?.contextMounts as Array<{ slug: string; path: string }>;

    expect(stored.map((m) => [m.slug, m.path])).toEqual([
      ["api", detached],
      ["lib", l.repo],
    ]);
  });

  it("W13: inside_state_dir compares the REALPATH of the state dir — a symlinked state dir cannot be adopted through its real path", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "eh-adopt-")));

    roots.push(root);
    const realStateRoot = join(root, "real-state");
    const linkRoot = join(root, "link-state");

    await mkdir(realStateRoot);
    await symlink(realStateRoot, linkRoot);

    const host = await bootHost({
      runtimeRoot: root,
      stateDir: join(linkRoot, "execution-host"),
      workspaceRoots: [root],
      fixtureArgs: ["--hang"],
    });

    booted.push(host);
    const res = await postJson(
      `${host.url}/workspaces/adopt`,
      envelope(
        "workspace.adopt",
        { hostKey: host.hostState.hostKey, runId: "run-x" },
        {
          runId: "run-x",
          projectSlug: "demo",
          kind: "directory",
          path: join(realStateRoot, "execution-host"),
        },
      ),
    );

    expect(res.status).toBe(409);
    expect(res.body.details).toEqual({
      reason: "workspace_rejected",
      rule: "inside_state_dir",
    });
  });
});
