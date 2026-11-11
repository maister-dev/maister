import type { BootHostOptions, BootedHost } from "./_fixtures/boot-host";
import type {
  Invocation,
  ProcessRecord,
} from "../../../web/test-support/process-invocation";

import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import * as sessionOwnership from "../session-process-ownership";
import * as processGroups from "../../../runtime/process-group";
import { terminateSessionProcess, waitForChildExit } from "../execution-fence";
import { inspectProcessGroup } from "../../../runtime/process-group";
import {
  assertInvocationGroupEmpty,
  createInvocation,
  invocationEnvironment,
  registerProcess,
  registerRoot,
  releaseInvocation,
  signalInvocationGroup,
  signalInvocationProcess,
} from "../../../web/test-support/process-invocation";

import {
  bootHost,
  createEnvelope,
  createSession,
  envelope,
  fenceFor,
  postJson,
  silentLogger,
} from "./_fixtures/boot-host";

type OwnedHost = Readonly<{
  host: BootedHost;
  invocation: Invocation;
  groups: Set<number>;
}>;
const owners: OwnedHost[] = [];

async function ownedHost(options: BootHostOptions): Promise<OwnedHost> {
  const evidence = await mkdtemp(join(tmpdir(), "session-ownership-evidence-"));
  const invocation = await createInvocation(evidence);
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), "session-ownership-runtime-"),
  );

  await registerRoot(invocation, runtimeRoot, "supervisor-session-ownership");
  for (const [key, value] of Object.entries(invocationEnvironment(invocation)))
    vi.stubEnv(key, value);
  let host: BootedHost;

  try {
    host = await bootHost({ ...options, runtimeRoot });
  } catch (error) {
    const cleanupFailures = await releaseInvocation(
      invocation,
      "failed session ownership fixture startup",
    );

    throw new AggregateError(
      [error, ...cleanupFailures],
      "Owned session fixture could not start",
    );
  }
  const owner = { host, invocation, groups: new Set<number>() };

  owners.push(owner);

  return owner;
}

async function recordOwnedProcess(
  owner: OwnedHost,
  pid: number,
): Promise<ProcessRecord> {
  const record = await registerProcess(
    owner.invocation,
    {
      role: "fixture",
      caseName: "session-process-ownership",
      rootRole: "supervisor-session-ownership",
      root: owner.host.runtimeRoot,
      bootId: owner.host.hostState.bootId,
      logFile: null,
    },
    pid,
  );

  owner.groups.add(record.identity.pgid);

  return record;
}

afterEach(async () => {
  vi.restoreAllMocks();
  const failures: unknown[] = [];

  for (const owner of owners.splice(0)) {
    for (const cleanup of [
      () => owner.host.stop(),
      async () => {
        for (const group of owner.groups)
          await signalInvocationGroup(owner.invocation, group, "SIGKILL");
        for (const group of owner.groups)
          await assertInvocationGroupEmpty(owner.invocation, group);
      },
      async () =>
        failures.push(
          ...(await releaseInvocation(
            owner.invocation,
            "session process ownership regression",
          )),
        ),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  vi.unstubAllEnvs();
  if (failures.length)
    throw new AggregateError(failures, "Owned session fixture teardown failed");
});

it("keeps an inherited descendant in physical ownership after its adapter exits and refuses scoped inventory until that descendant retires", async () => {
  vi.stubEnv("MAISTER_ACP_HANDSHAKE_TIMEOUT_MS", "5000");
  const logRoot = await mkdtemp(join(tmpdir(), "session-ownership-handshake-"));
  const invocationLog = join(logRoot, "invocations.jsonl");
  const owner = await ownedHost({
    fixture: "inherited-descendant-acp.mjs",
    fixtureArgs: ["--hang-new-session", "--invocation-log", invocationLog],
    killGraceMs: 25,
  });

  await registerRoot(owner.invocation, logRoot, "session-handshake-log");
  const pidFile = join(owner.host.runtimeRoot, "descendant.pid");
  const create = await createEnvelope(
    owner.host,
    { runId: "owned-descendant" },
    {
      executor: {
        agent: "claude",
        model: "fixture",
        env: { MAISTER_DESCENDANT_PID_FILE: pidFile },
      },
    },
  );
  const pending = postJson(`${owner.host.url}/sessions`, create).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

  try {
    await vi.waitFor(
      async () => {
        expect(owner.host.registry.list()[0]?.adapterPid).toBeGreaterThan(0);
        expect(existsSync(pidFile)).toBe(true);
        expect(existsSync(invocationLog)).toBe(true);
        expect(await readFile(invocationLog, "utf8")).toContain(
          '"method":"session/new"',
        );
      },
      { timeout: 4000, interval: 25 },
    );
    const entry = owner.host.registry.get(
      owner.host.registry.list()[0].sessionId,
    )!;
    const gate = await recordOwnedProcess(owner, entry.record.pid);
    const adapter = await recordOwnedProcess(owner, entry.record.adapterPid!);
    const descendant = await recordOwnedProcess(
      owner,
      Number(await readFile(pidFile, "utf8")),
    );

    expect(descendant.identity.pgid).toBe(gate.identity.pgid);
    expect(adapter.identity.pgid).toBe(gate.identity.pgid);
    await signalInvocationProcess(
      owner.invocation,
      adapter.identity,
      "SIGKILL",
    );
    const outcome = await pending;

    if ("error" in outcome) throw outcome.error;
    const response = outcome.value;

    expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(response.body).toMatchObject({
      details: { reason: "session_create_exit_unconfirmed" },
    });
    // Negative control: the former parent/output-only proof succeeds while the
    // inherited descendant remains alive with all stdio closed.
    expect(await waitForChildExit(entry, 2_000)).toBe(true);
    expect(entry.record.terminalPublished).toBe(true);
    expect(await inspectProcessGroup(gate.identity.pgid)).toMatchObject({
      state: "active",
    });
    expect(await terminateSessionProcess(entry, 25, silentLogger)).toBe(
      "process_group_active",
    );
    const refused = await fetch(
      `${owner.host.url}/sessions?runId=owned-descendant`,
    );

    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      details: { reason: "session_process_owner_unconfirmed" },
    });
    expect(
      owner.host.hostState.sessionProcessesForRun("owned-descendant")[0].phase,
    ).toBe("registered");
    await signalInvocationProcess(
      owner.invocation,
      descendant.identity,
      "SIGTERM",
    );
    await assertInvocationGroupEmpty(owner.invocation, gate.identity.pgid);
    const admitted = await fetch(
      `${owner.host.url}/sessions?runId=owned-descendant`,
    );

    expect(admitted.status).toBe(200);
    expect(admitted.headers.get("X-Maister-Session-Ownership-Version")).toBe(
      "1",
    );
    expect(
      owner.host.hostState.sessionProcessesForRun("owned-descendant")[0],
    ).toMatchObject({ phase: "released", retiredAt: expect.any(String) });
    expect(owner.host.hostState.getReceipt(create.command.id)).toMatchObject({
      phase: "rejected",
      body: {
        details: {
          sessionCreateQuiescence: { version: 1, process: "terminated" },
        },
      },
    });
    const terminal = owner.host.hostState
      .runtimeEventsAfter(owner.host.hostState.getRuntimeEventStreamId(), null)
      .filter(
        (event) =>
          event.envelope.eventType === "session.exited" ||
          event.envelope.eventType === "session.crashed",
      );

    expect(terminal).toHaveLength(1);
  } finally {
    await pending;
  }
});

it.each(["within grace", "at deadline"] as const)(
  "DELETE waits for an inherited descendant after the leader exits, then durably replays success (%s)",
  async (retirement) => {
    const owner = await ownedHost({
      fixture: "retiring-descendant-acp.mjs",
      killGraceMs: 2_000,
    });
    const runId = "retiring-descendant";
    const pidFile = join(owner.host.runtimeRoot, "descendant.pid");
    const { sessionId } = await createSession(
      owner.host,
      { runId },
      {
        executor: {
          agent: "claude",
          model: "fixture",
          env: { MAISTER_DESCENDANT_PID_FILE: pidFile },
        },
      },
    );
    const entry = owner.host.registry.get(sessionId)!;
    const leader = await recordOwnedProcess(owner, entry.record.pid);
    const descendant = await recordOwnedProcess(
      owner,
      Number(await readFile(pidFile, "utf8")),
    );
    const inspect = processGroups.inspectProcessGroup;
    let observedLiveDescendant = false;
    let deadlineReached = false;
    const now = performance.now.bind(performance);

    vi.spyOn(performance, "now").mockImplementation(
      () => now() + (deadlineReached ? 2_000 : 0),
    );

    expect(descendant.identity.pgid).toBe(leader.identity.pgid);
    vi.spyOn(processGroups, "inspectProcessGroup").mockImplementation(
      async (...args) => {
        const observation = await inspect(...args);

        if (
          !observedLiveDescendant &&
          args[0] === leader.identity.pgid &&
          observation.state === "active"
        ) {
          expect(
            entry.child.exitCode !== null || entry.child.signalCode !== null,
          ).toBe(true);
          expect(entry.record.terminalPublished).toBe(true);
          observedLiveDescendant = true;
          // Release only after the real OS proof observes the leader/descendant
          // lifetime gap. The former single-probe implementation fails here.
          await signalInvocationProcess(
            owner.invocation,
            descendant.identity,
            "SIGUSR2",
          );
          if (retirement === "at deadline") {
            await assertInvocationGroupEmpty(
              owner.invocation,
              leader.identity.pgid,
            );
            await expect
              .poll(
                () => {
                  try {
                    process.kill(-leader.identity.pgid, 0);

                    return false;
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                      throw error;

                    return true;
                  }
                },
                { timeout: 2_000, interval: 10 },
              )
              .toBe(true);
            // Exhaust the grace after a real active observation and real exit,
            // reproducing retirement during the final observation/delay window.
            deadlineReached = true;
          }
        }

        return observation;
      },
    );
    const command = envelope("session.delete", fenceFor(owner.host, runId));
    const response = await postJson(
      `${owner.host.url}/sessions/${sessionId}`,
      command,
      "DELETE",
    );

    expect(observedLiveDescendant).toBe(true);
    expect(response.status, JSON.stringify(response.body)).toBe(204);
    expect(await inspect(leader.identity.pgid)).toEqual({ state: "retired" });
    expect(owner.host.hostState.getReceipt(command.command.id)).toMatchObject({
      phase: "completed",
      httpStatus: 204,
    });
    expect(owner.host.hostState.sessionProcessesForRun(runId)[0]).toMatchObject(
      {
        phase: "released",
      },
    );
    const replay = await postJson(
      `${owner.host.url}/sessions/${sessionId}`,
      command,
      "DELETE",
    );

    expect(replay.status).toBe(204);
    expect(replay.headers.get("x-maister-command-replayed")).toBe("true");
  },
);

it("DELETE retains ownership and records the group stage when a descendant outlives the grace", async () => {
  const owner = await ownedHost({
    fixture: "retiring-descendant-acp.mjs",
    killGraceMs: 250,
  });
  const runId = "stuck-descendant";
  const pidFile = join(owner.host.runtimeRoot, "descendant.pid");
  const { sessionId } = await createSession(
    owner.host,
    { runId },
    {
      executor: {
        agent: "claude",
        model: "fixture",
        env: { MAISTER_DESCENDANT_PID_FILE: pidFile },
      },
    },
  );
  const entry = owner.host.registry.get(sessionId)!;
  const leader = await recordOwnedProcess(owner, entry.record.pid);

  await recordOwnedProcess(owner, Number(await readFile(pidFile, "utf8")));
  const command = envelope("session.delete", fenceFor(owner.host, runId));
  const started = performance.now();
  const response = await postJson(
    `${owner.host.url}/sessions/${sessionId}`,
    command,
    "DELETE",
  );

  expect(performance.now() - started).toBeGreaterThanOrEqual(250);
  expect(response.status).toBe(503);
  expect(response.body).toMatchObject({
    code: "EXECUTOR_UNAVAILABLE",
    details: {
      reason: "session_delete_exit_unconfirmed",
      stage: "process_group_active",
      sessionId,
      runId,
      killGraceMs: 250,
    },
  });
  expect(entry.child.exitCode !== null || entry.child.signalCode !== null).toBe(
    true,
  );
  expect(entry.record.terminalPublished).toBe(true);
  expect(await inspectProcessGroup(leader.identity.pgid)).toMatchObject({
    state: "active",
  });
  expect(owner.host.hostState.sessionProcessesForRun(runId)[0].phase).toBe(
    "registered",
  );
  expect(owner.host.hostState.getReceipt(command.command.id)?.httpStatus).toBe(
    503,
  );
});

it.each(["protected", "guard-disabled"] as const)(
  "keeps adapter NODE_OPTIONS preloads behind the durable GO barrier (%s control)",
  async (guard) => {
    const owner = await ownedHost({ fixtureArgs: ["--hang"] });
    const marker = join(owner.host.runtimeRoot, "adapter-preload.pid");
    const preload = join(owner.host.runtimeRoot, "adapter-preload.cjs");

    await writeFile(
      preload,
      "require('node:fs').writeFileSync(process.env.MAISTER_GATE_MARKER,String(process.pid));\n",
    );
    const adapterEnv = {
      NODE_OPTIONS: `--require ${preload}`,
      MAISTER_GATE_MARKER: marker,
    };
    const gateEnvironment = sessionOwnership.sessionGateEnvironment;

    if (guard === "guard-disabled")
      vi.spyOn(sessionOwnership, "sessionGateEnvironment").mockImplementation(
        () => ({ ...gateEnvironment(), ...adapterEnv }),
      );
    const registered = owner.host.hostState.registerSessionProcess.bind(
      owner.host.hostState,
    );
    let goHeld = false;
    let allowGo = (): void => {};
    let markerBeforeRegistration = false;

    vi.spyOn(owner.host.hostState, "registerSessionProcess").mockImplementation(
      (input) => {
        markerBeforeRegistration = existsSync(marker);
        registered(input);
        const entry = owner.host.registry.get(input.hostSessionId)!;
        const send = entry.child.send.bind(entry.child);

        vi.spyOn(entry.child, "send").mockImplementation(
          (message, ...arguments_) => {
            if (
              typeof message === "object" &&
              message !== null &&
              "kind" in message &&
              message.kind === "execute"
            ) {
              allowGo = () => {
                send(message, ...arguments_);
              };
              goHeld = true;

              return true;
            }

            return send(message, ...arguments_);
          },
        );
      },
    );
    const command = await createEnvelope(
      owner.host,
      { runId: `preload-${guard}` },
      { executor: { agent: "claude", model: "fixture", env: adapterEnv } },
    );
    const pending = postJson(`${owner.host.url}/sessions`, command).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    try {
      await vi.waitFor(() => expect(goHeld).toBe(true), {
        timeout: 5_000,
        interval: 25,
      });
      const [record] = owner.host.registry.list();
      const gate = await recordOwnedProcess(owner, record.pid);

      expect(owner.host.hostState.pendingSessionProcesses()).toMatchObject([
        {
          commandId: command.command.id,
          processGroup: gate.identity.pgid,
          phase: "registered",
        },
      ]);
      if (guard === "protected") {
        expect(markerBeforeRegistration).toBe(false);
        expect(existsSync(marker)).toBe(false);
      } else {
        expect(Number(await readFile(marker, "utf8"))).toBe(record.pid);
      }
      allowGo();
      allowGo = (): void => {};
      const result = await pending;

      if ("error" in result) throw result.error;
      expect(result.value.status).toBe(201);
      const adapterPid = owner.host.registry.get(record.sessionId)!.record
        .adapterPid!;

      await recordOwnedProcess(owner, adapterPid);
      expect(Number(await readFile(marker, "utf8"))).toBe(adapterPid);
      expect(adapterPid).not.toBe(record.pid);
    } finally {
      allowGo();
      await pending;
    }
  },
);
