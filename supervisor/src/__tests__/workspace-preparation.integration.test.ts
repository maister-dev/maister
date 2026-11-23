import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  createBody,
  envelope,
  postJson,
  type BootedHost,
} from "./_fixtures/boot-host";

const roots: string[] = [];
const hosts: BootedHost[] = [];

async function sealInput(
  host: BootedHost,
  owner: WorkspacePrepareReceipt["owner"],
  kind: "capability_profile" | "capability_instructions",
  content: string,
): Promise<{ objectId: string; sha256: string }> {
  const objectId = randomUUID();
  const sha256 = createHash("sha256").update(content).digest("hex");
  const fence = {
    hostKey: owner.hostKey,
    runId: owner.runId,
    assignmentId: owner.assignmentId,
    assignmentEpoch: owner.assignmentEpoch,
  };
  const result = await postJson(
    host.url + "/runtime-objects",
    envelope("runtime_object.reserve", fence, {
      objectId,
      kind,
      logicalName:
        kind === "capability_profile"
          ? "workspace-inputs.json"
          : "instructions.md",
      mimeType:
        kind === "capability_profile" ? "application/json" : "text/markdown",
      sizeBytes: Buffer.byteLength(content),
      sha256,
      generation: 1,
      retentionClass: "run",
    }),
  );
  expect(result.status).toBe(201);
  const upload = await fetch(
    `${host.url}/runtime-objects/${objectId}/content`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(Buffer.byteLength(content)),
        "content-digest": `sha-256=:${Buffer.from(sha256, "hex").toString("base64")}:`,
        "x-maister-command-id": randomUUID(),
        "x-maister-command-issued-at": new Date().toISOString(),
        "x-maister-assignment-id": owner.assignmentId,
        "x-maister-assignment-epoch": String(owner.assignmentEpoch),
        "x-maister-object-generation": "1",
        "x-maister-sha256": sha256,
      },
      body: content,
    },
  );
  expect(upload.status).toBe(200);
  await upload.body?.cancel();
  return { objectId, sha256 };
}

it("C-07 materializes the exact sealed input manifest under its workspace generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "stage-c-workspace-inputs-"));
  roots.push(root);
  const host = await bootHost({
    runtimeRoot: root,
    fixture: "mock-acp-record-newsession.mjs",
  });
  hosts.push(host);
  const inputDigest = "8".repeat(64);
  const prepared = await prepareAndRead(host, {
    mode: "emptyDirectory",
    inputDigest,
  });
  if (prepared.phase !== "completed")
    throw new Error("workspace preparation did not complete");
  const { handle, generation } = prepared.result.workspace;
  const premature = await postJson(
    host.url + "/sessions",
    envelope("session.create", prepared.owner, createBody(handle)),
  );
  expect(premature).toMatchObject({
    status: 409,
    body: { details: { reason: "workspace_preparation_pending" } },
  });
  expect(host.registry.list()).toEqual([]);
  const bytes = "# frozen instructions\n";
  const sealed = await sealInput(
    host,
    prepared.owner,
    "capability_instructions",
    bytes,
  );
  const manifest = await sealInput(
    host,
    prepared.owner,
    "capability_profile",
    JSON.stringify({
      version: 1,
      workspaceInputDigest: inputDigest,
      files: [{ path: "instructions.md", ...sealed }],
    }),
  );
  const commandId = randomUUID();
  const request = {
    workspaceProtocol: 1,
    command: {
      id: commandId,
      kind: "workspace.materialize",
      issuedAt: new Date().toISOString(),
    },
    owner: prepared.owner,
    payload: {
      generation,
      manifestDigest: manifest.sha256,
      objects: [manifest, sealed],
    },
  };
  const route = `/v1/workspaces/${handle}/materialization`;
  const tampered = randomUUID();
  const tamperedRequest = {
    ...request,
    command: { ...request.command, id: tampered },
    payload: {
      ...request.payload,
      objects: [manifest, { ...sealed, sha256: "0".repeat(64) }],
    },
  };
  expect((await addressedRequest(host, route, tamperedRequest)).status).toBe(
    202,
  );
  await vi.waitFor(async () => {
    const response = await addressedRequest(host, `/v1/commands/${tampered}`);
    expect(await response.json()).toMatchObject({
      phase: "rejected",
      refusal: { details: { reason: "workspace_rejected" } },
    });
  });
  expect(
    host.hostState.getWorkspaceExecutionState(handle)?.materializationDigest,
  ).toBeNull();
  const accepted = await addressedRequest(host, route, request);
  expect(accepted.status).toBe(202);
  await accepted.body?.cancel();
  const receipt = await vi.waitFor(async () => {
    const response = await addressedRequest(host, `/v1/commands/${commandId}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      phase: "completed",
      operationId: "stageCMaterialize",
      result: {
        generation,
        inputGeneration: 1,
        manifestDigest: manifest.sha256,
      },
    });
    return body;
  });
  const workspace = host.hostState.getWorkspace(handle);
  if (!workspace) throw new Error("prepared workspace does not exist");
  const file = join(
    workspace.runDir,
    "inputs",
    manifest.sha256,
    "instructions.md",
  );
  expect(await readFile(file, "utf8")).toBe(bytes);
  expect((await stat(file)).mode & 0o222).toBe(0);
  const replay = await addressedRequest(host, route, request);
  expect(replay.status).toBe(202);
  expect(
    await (await addressedRequest(host, `/v1/commands/${commandId}`)).json(),
  ).toEqual(receipt);
  await chmod(file, 0o600);
  await writeFile(file, "# tampered after materialization");
  await chmod(file, 0o444);
  const changedInput = await postJson(
    host.url + "/sessions",
    envelope("session.create", prepared.owner, createBody(handle)),
  );
  expect(changedInput).toMatchObject({
    status: 409,
    body: { details: { reason: "workspace_input_changed" } },
  });
  await chmod(file, 0o600);
  await writeFile(file, bytes);
  await chmod(file, 0o444);
  vi.stubEnv("MAISTER_API_BASE_URL", "https://workspace-web.example.test");
  const scopedToken = `mai_${"a".repeat(43)}`;
  const wrongWeb = await postJson(
    host.url + "/sessions",
    envelope(
      "session.create",
      prepared.owner,
      createBody(handle, {
        mcpServers: [
          {
            name: "maister",
            transport: "stdio",
            platformOrigin: "maister_facade",
            env: {
              MAISTER_API_BASE_URL: "https://another-web.example.test",
              MAISTER_PROJECT_TOKEN: scopedToken,
            },
          },
        ],
      }),
    ),
  );
  expect(wrongWeb).toMatchObject({
    status: 409,
    body: { details: { reason: "workspace_rejected" } },
  });
  expect(host.registry.list()).toEqual([]);
  const record = join(root, "newsession-record.json");
  const configuredFacade = join(root, "fixture-facade");
  vi.stubEnv("MAISTER_MCP_FACADE_COMMAND", configuredFacade);
  vi.stubEnv("MOCK_ACP_NEWSESSION_RECORD_PATH", record);
  vi.stubEnv("UNRELATED_MCP_TOKEN", "fixture-private-value");
  const spawned = await postJson(
    host.url + "/sessions",
    envelope(
      "session.create",
      prepared.owner,
      createBody(handle, {
        mcpServers: [
          {
            name: "maister",
            transport: "stdio",
            platformOrigin: "maister_facade",
            command: "/manager/unused-facade",
            args: ["--manager-path"],
            env: {
              MAISTER_API_BASE_URL: "https://workspace-web.example.test",
              MAISTER_PROJECT_TOKEN: scopedToken,
              MAISTER_MCP_TOOLSET: "project-run",
              UNRELATED_MCP_TOKEN: "env:UNRELATED_MCP_TOKEN",
            },
          },
        ],
      }),
    ),
  );
  expect(spawned.status).toBe(201);
  expect(JSON.parse(await readFile(record, "utf8"))).toMatchObject({
    cwd: workspace.path,
    mcpServers: [
      {
        name: "maister",
        command: configuredFacade,
        args: ["--stdio"],
        env: [
          {
            name: "MAISTER_API_BASE_URL",
            value: "https://workspace-web.example.test",
          },
          { name: "MAISTER_PROJECT_TOKEN", value: scopedToken },
          { name: "MAISTER_MCP_TOOLSET", value: "project-run" },
        ],
      },
    ],
  });
}, 30_000);

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
