import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { EXECUTION_HOST_KEY_HEADER } from "../../../runtime/execution-host-address";
import type {
  PreparedWorkspace,
  WorkspacePrepareInput,
  WorkspacePrepareReceipt,
} from "../../../runtime/workspace-prepare";

import {
  bootHost,
  cleanupRuntimeRoot,
  type BootedHost,
} from "./_fixtures/boot-host";

const roots: string[] = [];
const hosts: BootedHost[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const host of hosts.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await cleanupRuntimeRoot(root);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "user.name=Stage C",
      "-c",
      "user.email=stage-c@example.test",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function addressedRequest(
  host: BootedHost,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(host.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      [EXECUTION_HOST_KEY_HEADER]: host.hostState.hostKey,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

it("C-06 observes an approved Git ref and replays pinned workspace preparation across a host restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "stage-c-workspace-host-"));
  roots.push(root);
  const repository = join(root, "source");
  git(root, "init", "-b", "main", repository);
  await writeFile(join(repository, "input.txt"), "first\n");
  git(repository, "add", "--", "input.txt");
  git(repository, "commit", "-m", "first");
  const commit = git(repository, "rev-parse", "HEAD");
  vi.stubEnv(
    "MAISTER_WORKSPACE_REPOSITORIES",
    JSON.stringify({ "fixture-repo": repository }),
  );
  const host = await bootHost({ runtimeRoot: root });
  hosts.push(host);
  const observed = await addressedRequest(
    host,
    "/v1/repositories/resolve-revision",
    {
      repositoryId: "fixture-repo",
      ref: "refs/heads/main",
    },
  );
  expect(observed.status).toBe(200);
  expect(await observed.json()).toEqual({
    repositoryId: "fixture-repo",
    ref: "refs/heads/main",
    commit,
  });
  const listed = await addressedRequest(
    host,
    "/v1/repositories/fixture-repo/refs",
  );
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({
    refs: ["refs/heads/main"],
    defaultRef: "refs/heads/main",
    nextCursor: null,
  });

  await writeFile(join(repository, "input.txt"), "second\n");
  git(repository, "add", "--", "input.txt");
  git(repository, "commit", "-m", "second");
  const inputDigest = "1".repeat(64);
  const command = {
    workspaceProtocol: 1,
    command: {
      id: randomUUID(),
      kind: "workspace.prepare",
      issuedAt: new Date().toISOString(),
    },
    owner: {
      kind: "assignment",
      hostKey: host.hostState.hostKey,
      assignmentId: randomUUID(),
      assignmentEpoch: 1,
      runId: randomUUID(),
    },
    payload: {
      mode: "ownWorktree",
      repositoryId: "fixture-repo",
      commit,
      inputDigest,
    },
  };
  const accepted = await addressedRequest(
    host,
    "/v1/workspaces/prepare",
    command,
  );
  const receiptPath = `/v1/commands/${command.command.id}`;
  expect(accepted.status).toBe(202);
  expect(accepted.headers.get("location")).toBe(receiptPath);
  await accepted.body?.cancel();

  const receipt = await vi.waitFor(
    async () => {
      const response = await addressedRequest(host, receiptPath);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { result: PreparedWorkspace };
      expect(body).toMatchObject({
        phase: "completed",
        owner: command.owner,
        target: { kind: "prepare" },
        result: {
          inputDigest,
          workspace: {
            observedCommit: commit,
            generation: 1,
            mode: "ownWorktree",
          },
        },
      });
      return body;
    },
    { timeout: 10_000 },
  );
  const workspace = host.hostState.getWorkspace(
    receipt.result.workspace.handle,
  );
  if (!workspace) throw new Error("receipt has no owned workspace");
  const path = join(workspace.realPath, "input.txt");
  expect(await readFile(path, "utf8")).toBe("first\n");
  await writeFile(path, "dirty first workspace\n");

  await host.stop();
  hosts.pop();
  const rebooted = await bootHost({ runtimeRoot: root });
  hosts.push(rebooted);
  expect(rebooted.hostState.bootId).not.toBe(host.hostState.bootId);
  const replay = await addressedRequest(
    rebooted,
    "/v1/workspaces/prepare",
    command,
  );
  expect(replay.status).toBe(202);
  expect(await replay.json()).toEqual({
    commandId: command.command.id,
    state: "accepted",
  });
  expect(await (await addressedRequest(rebooted, receiptPath)).json()).toEqual(
    receipt,
  );
  expect(await readFile(path, "utf8")).toBe("dirty first workspace\n");

  const conflicting = await addressedRequest(
    rebooted,
    "/v1/workspaces/prepare",
    {
      ...command,
      payload: {
        ...command.payload,
        commit: git(repository, "rev-parse", "HEAD"),
      },
    },
  );
  expect(conflicting.status).toBe(409);
  expect(await conflicting.json()).toMatchObject({
    code: "CONFLICT",
    details: { reason: "command_digest_mismatch" },
  });

  const freshCommit = git(repository, "rev-parse", "HEAD");
  const second = await prepareAndRead(rebooted, {
    mode: "ownWorktree",
    repositoryId: "fixture-repo",
    commit: freshCommit,
    inputDigest,
  });
  expect(second.phase).toBe("completed");
  if (second.phase !== "completed")
    throw new Error("second workspace unavailable");
  expect(second.result.workspace.observedCommit).toBe(freshCommit);
  expect(second.result.workspace.handle).not.toBe(
    receipt.result.workspace.handle,
  );
  expect(await readFile(path, "utf8")).toBe("dirty first workspace\n");
}, 30_000);

async function prepareAndRead(
  host: BootedHost,
  payload: WorkspacePrepareInput,
): Promise<WorkspacePrepareReceipt> {
  const id = randomUUID();
  const response = await addressedRequest(host, "/v1/workspaces/prepare", {
    workspaceProtocol: 1,
    command: {
      id,
      kind: "workspace.prepare",
      issuedAt: new Date().toISOString(),
    },
    owner: {
      kind: "assignment",
      hostKey: host.hostState.hostKey,
      runId: randomUUID(),
      assignmentId: randomUUID(),
      assignmentEpoch: 1,
    },
    payload,
  });
  expect(response.status).toBe(202);
  await response.body?.cancel();

  return vi.waitFor(
    async () => {
      const record = await addressedRequest(host, `/v1/commands/${id}`);
      expect(record.status).toBe(200);
      const receipt = (await record.json()) as WorkspacePrepareReceipt;
      expect(receipt.phase).not.toBe("accepted");
      return receipt;
    },
    { timeout: 10_000 },
  );
}

it("C-06 creates the declared workspace modes and refuses a stale root, missing commit and escaped directory alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "stage-c-workspace-modes-"));
  const outside = await mkdtemp(join(tmpdir(), "stage-c-workspace-outside-"));
  roots.push(root, outside);
  const source = join(root, "source");
  const directory = join(root, "approved-directory");
  const alias = join(root, "escaped-directory");
  await mkdir(directory);
  await symlink(outside, alias);
  git(root, "init", "-b", "main", source);
  git(source, "commit", "--allow-empty", "-m", "base");
  const commit = git(source, "rev-parse", "HEAD");
  const inputDigest = "7".repeat(64);
  vi.stubEnv("MAISTER_WORKSPACE_REPOSITORIES", JSON.stringify({ source }));
  vi.stubEnv(
    "MAISTER_WORKSPACE_DIRECTORIES",
    JSON.stringify({ directory, alias }),
  );
  const host = await bootHost({ runtimeRoot: root });
  hosts.push(host);
  const own = await prepareAndRead(host, {
    mode: "ownWorktree",
    repositoryId: "source",
    commit,
    inputDigest,
  });
  if (own.phase !== "completed") throw new Error("root workspace failed");
  const parent = own.result.workspace;

  const shared = await prepareAndRead(host, {
    mode: "sharedWorktree",
    parentHandle: parent.handle,
    parentGeneration: parent.generation,
    inputDigest,
  });
  if (shared.phase !== "completed") throw new Error("shared workspace failed");
  expect(
    host.hostState.getWorkspace(shared.result.workspace.handle)?.realPath,
  ).toBe(host.hostState.getWorkspace(parent.handle)?.realPath);
  expect(
    await prepareAndRead(host, {
      mode: "sharedWorktree",
      parentHandle: parent.handle,
      parentGeneration: parent.generation + 1,
      inputDigest,
    }),
  ).toMatchObject({
    phase: "rejected",
    refusal: { details: { reason: "workspace_rejected" } },
  });
  expect(
    await prepareAndRead(host, {
      mode: "readOnlyCheckout",
      repositoryId: "source",
      commit,
      inputDigest,
    }),
  ).toMatchObject({
    phase: "completed",
    result: { workspace: { mode: "readOnlyCheckout", observedCommit: commit } },
  });
  expect(
    await prepareAndRead(host, { mode: "emptyDirectory", inputDigest }),
  ).toMatchObject({
    phase: "completed",
    result: { workspace: { mode: "emptyDirectory", observedCommit: null } },
  });
  expect(
    await prepareAndRead(host, {
      mode: "directory",
      directoryProfileId: "directory",
      inputDigest,
    }),
  ).toMatchObject({
    phase: "completed",
    result: { workspace: { mode: "directory", observedCommit: null } },
  });
  expect(
    await prepareAndRead(host, {
      mode: "directory",
      directoryProfileId: "directory",
      inputDigest,
    }),
  ).toMatchObject({
    phase: "rejected",
    refusal: { details: { reason: "workspace_rejected" } },
  });
  expect(
    await prepareAndRead(host, {
      mode: "directory",
      directoryProfileId: "alias",
      inputDigest,
    }),
  ).toMatchObject({
    phase: "rejected",
    refusal: { details: { reason: "workspace_rejected" } },
  });
  expect(
    await prepareAndRead(host, {
      mode: "ownWorktree",
      repositoryId: "source",
      commit: "a".repeat(40),
      inputDigest,
    }),
  ).toMatchObject({
    phase: "rejected",
    refusal: { details: { reason: "source_commit_unavailable" } },
  });
}, 30_000);
