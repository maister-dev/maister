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
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, it, vi } from "vitest";

import { EXECUTION_HOST_KEY_HEADER } from "../../../runtime/execution-host-address";
import { WORKSPACE_CONTEXT_INPUT } from "../../../runtime/workspace-context-input";
import { WORKSPACE_TEMPLATE_CONTEXT_NAME } from "../../../runtime/workspace-prepare";
import type {
  PreparedWorkspace,
  WorkspacePrepareInput,
  WorkspacePrepareReceipt,
} from "../../../runtime/workspace-prepare";

import { HOST_STATE_FILE } from "../host-state";

import {
  bootHost,
  completePrompt,
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
  logicalName = kind === "capability_profile" ? "workspace-inputs.json" : "instructions.md",
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
      logicalName,
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

it("C-07/C-08 materializes sealed inputs and executes bounded addressed workloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "stage-c-workspace-inputs-"));
  roots.push(root);
  const contextSource = join(root, "context-source");
  git(root, "init", "-b", "main", contextSource);
  await writeFile(join(contextSource, "context.md"), "# pinned context");
  git(contextSource, "add", "--", "context.md");
  git(contextSource, "commit", "-m", "context");
  const contextRevision = git(contextSource, "rev-parse", "HEAD");
  vi.stubEnv(
    "MAISTER_WORKSPACE_REPOSITORIES",
    JSON.stringify({ "sibling-id": contextSource }),
  );
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
  const skillPath = "bundles/0/skills/pinned-skill/SKILL.md";
  const sealed = await sealInput(
    host,
    prepared.owner,
    "capability_instructions",
    bytes,
  );
  const context = await sealInput(
    host,
    prepared.owner,
    "capability_instructions",
    JSON.stringify([
      {
        stepId: "step-1",
        repositoryId: "sibling-id",
        slug: "sibling",
        ref: "main",
        declaredRef: null,
        commit: contextRevision,
      },
    ]),
  );
  const workload = await sealInput(
    host,
    prepared.owner,
    "capability_instructions",
    JSON.stringify([
      {
        id: "project-check",
        workload: "check",
        command:
          "printf '%s' '\"local check\"'; test -z \"${UNRELATED_MCP_TOKEN:-}\"",
        timeoutMs: 5000,
        structuredOutput: "json",
      },
      {
        id: "long-check",
        workload: "check",
        command: "printf 'partial stdout'; : > .fixture-ready; sleep 15",
        timeoutMs: 20_000,
      },
      {
        id: "templated-check",
        workload: "check",
        command: `printf '%s' '{{ task.title }}-{{ env.UNRELATED_MCP_TOKEN ?? "filtered" }}'; : > .template-started`,
        timeoutMs: 5_000,
      },
      {
        id: "timed-check",
        workload: "check",
        command: "sleep 15",
        timeoutMs: 500,
      },
      {
        id: "invalid-output-check",
        workload: "check",
        command: "printf 'not json'; exit 42",
        timeoutMs: 5000,
        structuredOutput: "json",
      },
      {
        id: "oversized-check",
        workload: "check",
        command: "head -c 4194305 /dev/zero",
        timeoutMs: 5000,
      },
    ]),
  );
  await writeFile(join(contextSource, "context.md"), "# newer context");
  git(contextSource, "add", "--", "context.md");
  git(contextSource, "commit", "-m", "advance context");
  const manifest = await sealInput(
    host,
    prepared.owner,
    "capability_profile",
    JSON.stringify({
      version: 1,
      workspaceInputDigest: inputDigest,
      files: [
        { path: skillPath, ...sealed },
        { path: WORKSPACE_CONTEXT_INPUT, ...context },
        { path: "workload-declarations.json", ...workload },
      ],
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
      objects: [manifest, sealed, context, workload],
    },
  };
  const route = `/v1/workspaces/${handle}/materialization`;
  const tampered = randomUUID();
  const tamperedRequest = {
    ...request,
    command: { ...request.command, id: tampered },
    payload: {
      ...request.payload,
      objects: [
        manifest,
        { ...sealed, sha256: "0".repeat(64) },
        context,
        workload,
      ],
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
  const file = join(workspace.runDir, "inputs", manifest.sha256, skillPath);
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
  const recordedPrompt = join(root, "prompt-record.json");
  const configuredFacade = join(root, "fixture-facade");
  vi.stubEnv("MAISTER_MCP_FACADE_COMMAND", configuredFacade);
  vi.stubEnv("MOCK_ACP_NEWSESSION_RECORD_PATH", record);
  vi.stubEnv("MOCK_ACP_PROMPT_RECORD_PATH", recordedPrompt);
  vi.stubEnv("UNRELATED_MCP_TOKEN", "fixture-private-value");
  const spawned = await postJson(
    host.url + "/sessions",
    envelope(
      "session.create",
      prepared.owner,
      createBody(handle, {
        executor: {
          agent: "claude",
          model: "claude-sonnet-4-6",
          env: {
            MOCK_ACP_NEWSESSION_RECORD_PATH: record,
            MOCK_ACP_PROMPT_RECORD_PATH: recordedPrompt,
            MOCK_ACP_ENV_PROBE: "UNRELATED_MCP_TOKEN",
          },
        },
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
  const mounts = host.registry.get(String(spawned.body.sessionId))?.record
    .contextMounts;
  expect(mounts).toMatchObject([{ slug: "sibling", commit: contextRevision }]);
  const mounted = mounts?.[0]?.path;
  if (!mounted)
    throw new Error("addressed session did not receive its declared sibling");
  expect(await readFile(join(mounted, "context.md"), "utf8")).toBe(
    "# pinned context",
  );
  expect((await stat(join(mounted, "context.md"))).mode & 0o222).toBe(0);
  const prompt = await completePrompt(
    host,
    String(spawned.body.sessionId),
    envelope("session.prompt", prepared.owner, {
      stepId: "step-1",
      prompt: "Follow the packaged skill.",
    }),
  );
  expect(prompt.status).toBe(200);
  expect(await readFile(recordedPrompt, "utf8")).toContain(skillPath);
  const checkCommandId = randomUUID();
  const check = await addressedRequest(
    host,
    `/v1/workspaces/${handle}/commands`,
    {
      workspaceProtocol: 1,
      command: {
        id: checkCommandId,
        kind: "workspace.run",
        issuedAt: new Date().toISOString(),
      },
      owner: prepared.owner,
      payload: {
        generation,
        workload: "check",
        declarationId: "project-check",
        inputGeneration: 1,
        inputDigest: manifest.sha256,
      },
    },
  );
  expect(check.status).toBe(202);
  const checked = await vi.waitFor(async () => {
    const result = await addressedRequest(
      host,
      `/v1/commands/${checkCommandId}`,
    );
    const body = (await result.json()) as {
      result: { objects: Array<{ objectId: string; sha256: string }> };
    };
    expect(body).toMatchObject({
      phase: "completed",
      operationId: "stageCRunWorkload",
      result: {
        generation,
        exitCode: 0,
        processOutcome: "exited",
        quiescence: "proved",
        checkValidity: "valid",
        outputState: "sealed",
      },
    });
    return body.result;
  });
  const checkOutput = await addressedRequest(
    host,
    `/runtime-objects/${checked.objects[0].objectId}/content`,
  );
  expect(await checkOutput.text()).toBe('"local check"');
  const templateContext = await sealInput(
    host,
    prepared.owner,
    "capability_profile",
    JSON.stringify({
      version: 1,
      declarationId: "templated-check",
      values: { task: { title: "a".repeat(40_000) } },
    }),
    WORKSPACE_TEMPLATE_CONTEXT_NAME,
  );
  const rejectedCheck = randomUUID();
  expect((await addressedRequest(host, `/v1/workspaces/${handle}/commands`, {
    workspaceProtocol: 1,
    command: { id: rejectedCheck, kind: "workspace.run", issuedAt: new Date().toISOString() },
    owner: prepared.owner,
    payload: {
      generation,
      workload: "check",
      declarationId: "templated-check",
      inputGeneration: 1,
      inputDigest: manifest.sha256,
      templateContext,
    },
  })).status).toBe(202);
  await vi.waitFor(async () => {
    const receipt = await addressedRequest(host, `/v1/commands/${rejectedCheck}`);
    expect(await receipt.json()).toMatchObject({
      phase: "rejected",
      refusal: { details: { reason: "workspace_template_context_invalid" } },
    });
  });
  await expect(stat(join(workspace.path, ".template-started"))).rejects.toMatchObject({ code: "ENOENT" });
  const longId = randomUUID();
  const runPayload = {
    generation,
    workload: "check",
    declarationId: "long-check",
    inputGeneration: 1,
    inputDigest: manifest.sha256,
  };
  const fencedTarget = randomUUID();
  const stopBeforeDelivery = {
    workspaceProtocol: 1,
    command: {
      id: randomUUID(),
      kind: "workspace.cancel",
      issuedAt: new Date().toISOString(),
    },
    owner: prepared.owner,
    payload: { generation },
  };
  const cancellationPath = `/v1/workspaces/${handle}/commands/${fencedTarget}/cancel`;
  expect((await addressedRequest(host, cancellationPath, stopBeforeDelivery)).status).toBe(202);
  await vi.waitFor(async () => {
    const receipt = await addressedRequest(host, `/v1/commands/${stopBeforeDelivery.command.id}`);
    expect(await receipt.json()).toMatchObject({
      phase: "completed",
      result: { targetCommandId: fencedTarget, quiescence: "proved", objects: [] },
    });
  });
  expect(host.hostState.retireReceipt(stopBeforeDelivery.command.id, {
    expectedRequestSha256: null,
    expectedPhase: "completed",
    assignmentEpoch: prepared.owner.assignmentEpoch,
  })).toMatchObject({ outcome: "retired" });
  const lateWorkRequest = {
    workspaceProtocol: 1,
    command: { id: fencedTarget, kind: "workspace.run", issuedAt: new Date().toISOString() },
    owner: prepared.owner,
    payload: runPayload,
  };
  const lateWork = await addressedRequest(host, `/v1/workspaces/${handle}/commands`, lateWorkRequest);
  expect(lateWork.status).toBe(409);
  expect(await lateWork.json()).toMatchObject({ details: { reason: "workspace_workload_cancelled" } });
  await expect(stat(join(workspace.path, ".fixture-ready"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await addressedRequest(host, cancellationPath, stopBeforeDelivery)).status).toBe(202);

  const longRun = await addressedRequest(
    host,
    `/v1/workspaces/${handle}/commands`,
    {
      workspaceProtocol: 1,
      command: {
        id: longId,
        kind: "workspace.run",
        issuedAt: new Date().toISOString(),
      },
      owner: prepared.owner,
      payload: runPayload,
    },
  );
  expect(longRun.status).toBe(202);
  await vi.waitFor(() => {
    expect(host.hostState.getReceipt(longId)?.body).toMatchObject({
      workspaceProcess: { group: expect.any(Number) },
    });
  });
  await vi.waitFor(async () => {
    expect((await stat(join(workspace.path, ".fixture-ready"))).isFile()).toBe(
      true,
    );
  });
  const cancelId = randomUUID();
  const cancellation = await addressedRequest(
    host,
    `/v1/workspaces/${handle}/commands/${longId}/cancel`,
    {
      workspaceProtocol: 1,
      command: {
        id: cancelId,
        kind: "workspace.cancel",
        issuedAt: new Date().toISOString(),
      },
      owner: prepared.owner,
      payload: { generation },
    },
  );
  expect(cancellation.status).toBe(202);
  await vi.waitFor(async () => {
    const settled = await addressedRequest(host, `/v1/commands/${cancelId}`);
    expect(await settled.json()).toMatchObject({
      phase: "completed",
      operationId: "stageCCancelWorkload",
      result: { targetCommandId: longId, quiescence: "proved" },
    });
  });
  const interrupted = (await (
    await addressedRequest(host, `/v1/commands/${longId}`)
  ).json()) as {
    result: { objects: { objectId: string }[] };
  };
  expect(interrupted).toMatchObject({
    phase: "completed",
    result: { processOutcome: "cancelled", quiescence: "proved" },
  });
  const partial = await addressedRequest(
    host,
    `/runtime-objects/${interrupted.result.objects[0].objectId}/content`,
  );
  expect(await partial.text()).toBe("partial stdout");
  for (const [declarationId, result] of [
    ["timed-check", { processOutcome: "timedOut", exitCode: null }],
    [
      "invalid-output-check",
      { processOutcome: "exited", exitCode: 42, checkValidity: "invalid" },
    ],
    ["oversized-check", { outputState: "truncated" }],
  ] as const) {
    const commandId = randomUUID();
    expect(
      (
        await addressedRequest(host, `/v1/workspaces/${handle}/commands`, {
          workspaceProtocol: 1,
          command: {
            id: commandId,
            kind: "workspace.run",
            issuedAt: new Date().toISOString(),
          },
          owner: prepared.owner,
          payload: { ...runPayload, declarationId },
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(async () => {
      expect(
        await (
          await addressedRequest(host, `/v1/commands/${commandId}`)
        ).json(),
      ).toMatchObject({
        phase: "completed",
        result: { ...result, quiescence: "proved" },
      });
    });
  }
  expect(JSON.parse(await readFile(record, "utf8"))).toMatchObject({
    cwd: workspace.path,
    probePresent: false,
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
  host.hostState.setFence(
    prepared.owner.runId,
    randomUUID(),
    prepared.owner.assignmentEpoch + 1,
  );
  const staleCommandId = randomUUID();
  const stale = await addressedRequest(
    host,
    `/v1/workspaces/${handle}/commands`,
    {
      workspaceProtocol: 1,
      command: {
        id: staleCommandId,
        kind: "workspace.run",
        issuedAt: new Date().toISOString(),
      },
      owner: prepared.owner,
      payload: runPayload,
    },
  );
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    code: "FENCED",
    details: { reason: "assignment_fenced" },
  });
  await host.stop();
  hosts.pop();
  const rebooted = await bootHost({ runtimeRoot: root });
  hosts.push(rebooted);
  expect(rebooted.hostState.bootId).not.toBe(host.hostState.bootId);
  const replayedLateWork = await addressedRequest(rebooted, `/v1/workspaces/${handle}/commands`, lateWorkRequest);
  expect(replayedLateWork.status).toBe(409);
  expect(await replayedLateWork.json()).toMatchObject({ details: { reason: "workspace_workload_cancelled" } });
  expect(rebooted.hostState.getReceipt(staleCommandId)).toBeNull();
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

it("C-09 restores a retained Git checkpoint once without replacing later work on replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "stage-c-git-checkpoint-"));
  roots.push(root);
  const repository = join(root, "sources");
  git(root, "init", "-b", "main", repository);
  await writeFile(join(repository, "input.txt"), "base\n");
  git(repository, "add", "input.txt");
  git(repository, "commit", "-m", "base");
  const commit = git(repository, "rev-parse", "HEAD");
  vi.stubEnv("MAISTER_WORKSPACE_REPOSITORIES", JSON.stringify({ fixture: repository }));
  const host = await bootHost({ runtimeRoot: root });
  hosts.push(host);
  const prepared = await prepareAndRead(host, {
    mode: "ownWorktree", repositoryId: "fixture", commit, inputDigest: "b".repeat(64),
  });
  if (prepared.phase !== "completed") throw new Error("fixture owns no checkout");
  const { handle, generation } = prepared.result.workspace;
  const checkout = host.hostState.getWorkspace(handle);
  if (!checkout) throw new Error("fixture checkout was not retained");
  const file = join(checkout.realPath, "input.txt");
  const untracked = join(checkout.realPath, "untracked.txt");
  const attemptNotes = join(checkout.realPath, "attempt-notes.txt");
  await writeFile(file, "captured tracked bytes\n");
  await writeFile(untracked, "captured untracked bytes\n");
  const checkpointId = randomUUID();
  const checkpoint = await addressedRequest(host, `/v1/workspaces/${handle}/checkpoint`, {
    workspaceProtocol: 1,
    command: { id: checkpointId, kind: "workspace.checkpoint", issuedAt: new Date().toISOString() },
    owner: prepared.owner,
    payload: { generation },
  });
  expect(checkpoint.status).toBe(202);
  const captured = await vi.waitFor(async () => {
    const response = await addressedRequest(host, `/v1/commands/${checkpointId}`);
    const receipt = await response.json() as { result: { tree: string } };
    expect(receipt).toMatchObject({ phase: "completed", result: { generation, checkpointId, tree: expect.stringMatching(/^[0-9a-f]{40}$/) } });
    return receipt;
  });
  expect(git(checkout.realPath, "rev-parse", "HEAD")).toBe(commit);
  expect(git(checkout.realPath, "ls-files", "--", "untracked.txt")).toBe("");
  await writeFile(file, "changed after checkpoint\n");
  await writeFile(untracked, "changed untracked bytes\n");
  await writeFile(attemptNotes, "notes created during the failed attempt\n");
  const restoreId = randomUUID();
  const restore = {
    workspaceProtocol: 1,
    command: { id: restoreId, kind: "workspace.restore", issuedAt: new Date().toISOString() },
    owner: prepared.owner,
    payload: { generation, checkpointId },
  };
  const restorePath = `/v1/workspaces/${handle}/restore`;
  expect((await addressedRequest(host, restorePath, restore)).status).toBe(202);
  await vi.waitFor(async () => {
    const response = await addressedRequest(host, `/v1/commands/${restoreId}`);
    expect(await response.json()).toMatchObject({ phase: "completed", result: captured.result });
  });
  expect(await readFile(file, "utf8")).toBe("captured tracked bytes\n");
  expect(await readFile(untracked, "utf8")).toBe("captured untracked bytes\n");
  expect(await readFile(attemptNotes, "utf8")).toBe("notes created during the failed attempt\n");
  expect(git(checkout.realPath, "ls-files", "--", "untracked.txt")).toBe("");
  await writeFile(file, "later work after restore\n");
  await host.stop();
  hosts.splice(hosts.indexOf(host), 1);
  const restarted = await bootHost({ runtimeRoot: root });
  hosts.push(restarted);
  expect(restarted.hostState.hostKey).toBe(host.hostState.hostKey);
  expect((await addressedRequest(restarted, restorePath, restore)).status).toBe(202);
  const replay = await addressedRequest(restarted, `/v1/commands/${restoreId}`);
  expect(await replay.json()).toMatchObject({ phase: "completed", result: captured.result });
  expect(await readFile(file, "utf8")).toBe("later work after restore\n");
  const other = await prepareAndRead(restarted, {
    mode: "ownWorktree", repositoryId: "fixture", commit, inputDigest: "b".repeat(64),
  });
  if (other.phase !== "completed") throw new Error("foreign fixture owns no checkout");
  const foreignDiff = await addressedRequest(restarted,
    `/v1/workspaces/${other.result.workspace.handle}/diff?generation=${generation}&checkpointId=${checkpointId}`,
  );
  expect(foreignDiff.status).toBe(409);
  expect(await foreignDiff.json()).toMatchObject({ details: { reason: "workspace_diff_range_invalid" } });
}, 30_000);

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
    JSON.stringify({ "fixture-repo": repository, "other-repo": repository }),
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

  execFileSync("git", ["-C", repository, "update-ref", "--stdin"], {
    input: Array.from({ length: 100 }, (_, index) =>
      `create refs/heads/fixture-${String(index).padStart(3, "0")} ${commit}\n`,
    ).join(""),
  });
  const firstPage = await addressedRequest(host, "/v1/repositories/fixture-repo/refs");
  const firstBody = (await firstPage.json()) as { refs: string[]; nextCursor: string | null };
  expect(firstBody.refs).toHaveLength(100);
  if (!firstBody.nextCursor) throw new Error("expected a second approved ref page");
  const suffix = `/refs?cursor=${encodeURIComponent(firstBody.nextCursor)}`;
  const foreignPage = await addressedRequest(host, `/v1/repositories/other-repo${suffix}`);
  expect(foreignPage.status).toBe(409);
  const secondPage = await addressedRequest(host, `/v1/repositories/fixture-repo${suffix}`);
  expect(secondPage.status).toBe(200);
  expect(await secondPage.json()).toEqual({
    refs: ["refs/heads/main"], defaultRef: "refs/heads/main", nextCursor: null,
  });

  await writeFile(join(repository, "input.txt"), "second\n");
  git(repository, "add", "--", "input.txt");
  git(repository, "commit", "-m", "second");
  const current = git(repository, "rev-parse", "HEAD");
  const pinned = await addressedRequest(host, "/v1/repositories/resolve-revision", {
    repositoryId: "fixture-repo", ref: "refs/heads/main", pinnedCommit: commit.slice(0, 12),
  });
  expect(pinned.status).toBe(200);
  expect(await pinned.json()).toMatchObject({ commit: current, pinnedCommit: commit });
  const divergent = await addressedRequest(host, "/v1/repositories/resolve-revision", {
    repositoryId: "fixture-repo", ref: "refs/heads/fixture-000", pinnedCommit: current,
  });
  expect(divergent.status).toBe(409);
  expect(await divergent.json()).toMatchObject({ details: { reason: "source_commit_unavailable" } });
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
  const workspaceQuery = `/v1/workspaces/${workspace.id}`;
  const inspect = (supervisor: BootedHost) =>
    addressedRequest(supervisor, `${workspaceQuery}/status?generation=1`);
  const clean = await inspect(host);
  expect(clean.status).toBe(200);
  expect(await clean.json()).toEqual({
    workspace: receipt.result.workspace,
    workingTree: "clean",
    headState: "detached",
  });
  await writeFile(path, "dirty first workspace\n");

  await host.stop();
  hosts.pop();
  const priorStore = new DatabaseSync(join(host.stateDir, HOST_STATE_FILE));
  try {
    priorStore.exec(`
      DROP TABLE workspace_workload_cancel_fences;
      ALTER TABLE workspace_execution_state DROP COLUMN preparation_mode;
      PRAGMA user_version = 19;
    `);
  } finally {
    priorStore.close();
  }
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
  const dirty = await inspect(rebooted);
  expect(dirty.status).toBe(200);
  expect(await dirty.json()).toEqual({
    workspace: receipt.result.workspace,
    workingTree: "dirty",
    headState: "detached",
  });
  const stale = await addressedRequest(
    rebooted,
    `${workspaceQuery}/status?generation=2`,
  );
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    details: { reason: "stale_workspace_generation" },
  });
  await writeFile(
    join(workspace.realPath, "new-file.txt"),
    "new untracked work\n",
  );
  const response = await addressedRequest(
    rebooted,
    `${workspaceQuery}/diff?generation=1&base=${commit}`,
  );
  expect(response.status).toBe(200);
  const reference = (await response.json()) as {
    generation: number;
    object: { objectId: string; sha256: string };
  };
  expect(reference.generation).toBe(1);
  const patch = await addressedRequest(
    rebooted,
    `/runtime-objects/${reference.object.objectId}/content`,
  );
  const bytes = Buffer.from(await patch.arrayBuffer());
  expect(patch.status).toBe(200);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    reference.object.sha256,
  );
  expect(bytes.toString()).toContain("+dirty first workspace\n");
  expect(bytes.toString()).toContain("+new untracked work\n");
  expect(git(workspace.realPath, "ls-files", "--", "new-file.txt")).toBe("");
  expect(bytes.toString()).not.toContain(root);
  const newer = git(repository, "rev-parse", "HEAD");
  const unrelated = await addressedRequest(
    rebooted,
    `${workspaceQuery}/diff?generation=1&base=${newer}`,
  );
  expect(unrelated.status).toBe(409);
  expect(await unrelated.json()).toMatchObject({
    details: { reason: "workspace_diff_range_invalid" },
  });
  await writeFile(path, "oversized\n".repeat(15_000));
  const oversized = await addressedRequest(
    rebooted,
    `${workspaceQuery}/diff?generation=1&base=${commit}`,
  );
  expect(oversized.status).toBe(409);
  expect(await oversized.json()).toMatchObject({
    details: { reason: "workspace_diff_too_large" },
  });
  await writeFile(path, "dirty first workspace\n");

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

  const logPath = `/v1/workspaces/${second.result.workspace.handle}/log?generation=1&limit=1`;
  async function readLogPage(url: string) {
    const response = await addressedRequest(rebooted, url);
    expect(response.status).toBe(200);
    const reference = (await response.json()) as {
      generation: number;
      object: { objectId: string; sha256: string };
    };
    expect(reference.generation).toBe(1);
    const content = await addressedRequest(
      rebooted,
      `/runtime-objects/${reference.object.objectId}/content`,
    );
    expect(content.status).toBe(200);
    const bytes = Buffer.from(await content.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      reference.object.sha256,
    );

    return JSON.parse(bytes.toString("utf8")) as { nextCursor: string | null };
  }

  const firstLogPage = await readLogPage(logPath);
  expect(firstLogPage).toMatchObject({
    head: freshCommit,
    commits: [{ commit: freshCommit, subject: "second" }],
    nextCursor: expect.any(String),
  });
  if (firstLogPage.nextCursor === null)
    throw new Error("expected a second Git log page");
  const cursor = encodeURIComponent(firstLogPage.nextCursor);
  expect(await readLogPage(`${logPath}&cursor=${cursor}`)).toMatchObject({
    head: freshCommit,
    commits: [{ commit, subject: "first" }],
    nextCursor: null,
  });
  const foreignLogPage = await addressedRequest(
    rebooted,
    `${workspaceQuery}/log?generation=1&cursor=${cursor}`,
  );
  expect(foreignLogPage.status).toBe(409);
  expect(await foreignLogPage.json()).toMatchObject({
    details: { reason: "workspace_log_cursor_invalid" },
  });
  const secondCheckout = rebooted.hostState.getWorkspace(second.result.workspace.handle);
  if (!secondCheckout) throw new Error("second checkout was not retained");
  const messagePath = join(root, "long-commit-message.txt");
  await writeFile(messagePath, `${"a".repeat(70_000)}\n`);
  git(secondCheckout.realPath, "commit", "--allow-empty", "-F", messagePath);
  const priorHeadPage = await addressedRequest(rebooted, `${logPath}&cursor=${cursor}`);
  expect(priorHeadPage.status).toBe(409);
  expect(await priorHeadPage.json()).toMatchObject({
    details: { reason: "workspace_log_cursor_invalid" },
  });
  const oversizedLog = await addressedRequest(rebooted, logPath);
  expect(oversizedLog.status).toBe(409);
  expect(await oversizedLog.json()).toMatchObject({
    details: { reason: "workspace_log_too_large" },
  });
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
