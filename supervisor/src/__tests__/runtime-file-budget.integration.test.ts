import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openHostState } from "../host-state";
import { RuntimeObjectRegistry } from "../runtime-objects";
import {
  DEFAULT_RUNTIME_LIMITS,
  validateRuntimeLimits,
} from "../runtime-limits";

import {
  bootHost,
  cleanupRuntimeRoot,
  completePrompt,
  createEnvelope,
  envelope,
  postJson,
} from "./_fixtures/boot-host";

const LIMITS = validateRuntimeLimits({
  ...DEFAULT_RUNTIME_LIMITS,
  objectLowBytes: 12 * 1024 * 1024,
  objectSoftBytes: 16 * 1024 * 1024,
  objectMaxBytes: 20 * 1024 * 1024,
});

describe("AT-02 aggregate runtime file capacity", () => {
  it("refuses restart without deleting retained bytes that exceed their reservation", () => {
    const root = mkdtempSync(join(tmpdir(), "maister-file-overrun-"));
    const stateDir = join(root, "state");
    const state = openHostState({ stateDir, limits: LIMITS });
    const file = join(root, "captured.log");

    state.reserveRuntimeFile(
      {
        fileId: "retained-log",
        privatePath: file,
        temporaryPath: null,
        kind: "log",
        walletId: null,
        capacityBytes: 100,
        writtenBytes: 0,
        sealed: false,
      },
      { kind: "regular" },
    );
    state.close();
    writeFileSync(file, Buffer.alloc(101, 120));
    try {
      expect(() => openHostState({ stateDir, limits: LIMITS })).toThrow(
        /runtime file startup inventory failed/,
      );
      expect(readFileSync(file).length).toBe(101);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("latches readiness unavailable on a real private-directory write failure and retains the upload promise", async () => {
    const root = mkdtempSync(join(tmpdir(), "maister-file-permissions-"));
    const state = openHostState({
      stateDir: join(root, "state"),
      limits: LIMITS,
    });
    const objectRoot = join(root, "state", "runtime-objects");
    const objects = new RuntimeObjectRegistry(state, objectRoot);
    const objectId = randomUUID();
    const assignmentId = randomUUID();
    const bytes = Buffer.from("retained promise");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    try {
      await objects.reserve({
        runId: "storage-failure",
        assignmentId,
        assignmentEpoch: 1,
        payload: {
          objectId,
          kind: "capability_instructions",
          logicalName: "instructions.md",
          mimeType: "text/markdown",
          sizeBytes: bytes.length,
          sha256,
          generation: 1,
          retentionClass: "run",
        },
      });
      chmodSync(objectRoot, 0o500);
      await expect(
        objects.upload({
          objectId,
          assignmentId,
          assignmentEpoch: 1,
          generation: 1,
          sizeBytes: bytes.length,
          sha256,
          chunks: (async function* () {
            yield bytes;
          })(),
        }),
      ).rejects.toMatchObject({ code: "EACCES" });
      expect(state.runtimeStorageAvailable()).toBe(false);
      expect(state.runtimeFileBudget().chargedBytes).toBe(2 * bytes.length);
      expect(state.getRuntimeObject(objectId)?.state).toBe("pending");
    } finally {
      chmodSync(objectRoot, 0o700);
      state.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("funds concurrent producers with every valid output binding at its maximum byte size", async () => {
    const envNames = [
      "MAISTER_OUTPUT_FILE",
      "MAISTER_PLAN_DOCUMENT_FILE",
      "MAISTER_PLAN_REVIEW_FILE",
    ] as const;
    const sizeBytes = 25 * 1024 * 1024;
    const host = await bootHost({
      fixtureArgs: [
        "--hang",
        "--lines",
        "0",
        ...envNames.flatMap((name) => [
          "--write-env-bytes",
          name,
          String(sizeBytes),
        ]),
      ],
    });
    const sessions: Array<{
      runId: string;
      sessionId: string;
      objectIds: string[];
    }> = [];
    const digest = createHash("sha256");

    for (let offset = 0; offset < sizeBytes; offset += 65536)
      digest.update(Buffer.alloc(65536, 120));
    const sha256 = digest.digest("hex");

    try {
      for (let index = 0; index < 2; index += 1) {
        const runId = `maximum-file-output-${index}`;
        const outputObjects = envNames.map((envName, ordinal) => ({
          objectId: randomUUID(),
          envName,
          kind: "evidence",
          logicalName: `output-${ordinal}.bin`,
          mimeType: "application/octet-stream",
          generation: 1,
          retentionClass: "run",
        }));
        const created = await postJson(
          `${host.url}/sessions`,
          await createEnvelope(host, { runId }, { outputObjects }),
        );

        expect(created.status).toBe(201);
        sessions.push({
          runId,
          sessionId: String(created.body.sessionId),
          objectIds: outputObjects.map((o) => o.objectId),
        });
      }
      expect(
        host.hostState.runtimeFileBudget().chargedBytes,
      ).toBeGreaterThanOrEqual(2 * (8 + 3 * 50) * 1024 * 1024);
      for (const session of sessions)
        for (const objectId of session.objectIds)
          expect(
            host.hostState.getRuntimeFile(`object:${objectId}`),
          ).toMatchObject({
            capacityBytes: 2 * sizeBytes,
            sealed: false,
          });
      const completed = await Promise.all(
        sessions.map((s) =>
          completePrompt(
            host,
            s.sessionId,
            envelope(
              "session.prompt",
              { hostKey: host.hostState.hostKey, runId: s.runId },
              { stepId: "maximum-output", prompt: "write bounded outputs" },
            ),
          ),
        ),
      );

      expect(completed.map((result) => result.status)).toEqual([200, 200]);
      for (const session of sessions)
        for (const objectId of session.objectIds) {
          expect(host.hostState.getRuntimeObject(objectId)).toMatchObject({
            state: "available",
            sizeBytes,
            sha256,
          });
          expect(
            host.hostState.getRuntimeFile(`object:${objectId}`),
          ).toMatchObject({
            capacityBytes: 2 * sizeBytes,
            writtenBytes: 2 * sizeBytes,
            sealed: true,
          });
        }
      expect(host.hostState.runtimeStorageAvailable()).toBe(true);
    } finally {
      await host.stop();
      await cleanupRuntimeRoot(host.runtimeRoot);
    }
  });

  it("preserves both real producers' paused output and terminal credits when runtime files reach the soft quota", async () => {
    const limits = validateRuntimeLimits({
      ...LIMITS,
      objectLowBytes: 18 * 1024 * 1024,
      objectSoftBytes: 20 * 1024 * 1024,
      objectMaxBytes: 24 * 1024 * 1024,
    });
    const host = await bootHost({ limits, fixtureArgs: ["--hang"] });
    const sessions: Array<{
      sessionId: string;
      runId: string;
      promptId: string;
    }> = [];

    try {
      for (let index = 0; index < 2; index += 1) {
        const runId = `file-saturation-${index}`;
        const created = await postJson(
          `${host.url}/sessions`,
          await createEnvelope(host, { runId }),
        );

        expect(created.status).toBe(201);
        sessions.push({
          sessionId: String(created.body.sessionId),
          runId,
          promptId: "",
        });
      }
      for (const session of sessions) {
        const prompt = envelope(
          "session.prompt",
          { hostKey: host.hostState.hostKey, runId: session.runId },
          {
            stepId: "file-pressure",
            prompt: `fixture-output:${JSON.stringify({ frameBytes: 65536, frames: 128 })}`,
          },
        );

        session.promptId = prompt.command.id;
        expect(
          (
            await postJson(
              `${host.url}/sessions/${session.sessionId}/prompts`,
              prompt,
            )
          ).status,
        ).toBe(202);
      }
      await expect
        .poll(
          () =>
            sessions.every(
              (s) => host.registry.get(s.sessionId)?.record.outputPaused,
            ),
          { timeout: 10000 },
        )
        .toBe(true);
      expect(host.hostState.runtimeFileBudget().pressured).toBe(true);
      expect(
        host.hostState.runtimeFileBudget().chargedBytes,
      ).toBeLessThanOrEqual(limits.objectMaxBytes);
      const checkpoints = await Promise.all(
        sessions.map((s) =>
          postJson(
            `${host.url}/sessions/${s.sessionId}/checkpoint`,
            envelope("session.checkpoint", {
              hostKey: host.hostState.hostKey,
              runId: s.runId,
            }),
          ),
        ),
      );

      expect(checkpoints.map((r) => r.status)).toEqual([200, 200]);
      for (const session of sessions) {
        await expect
          .poll(() => host.hostState.getReceipt(session.promptId)?.phase, {
            timeout: 10000,
          })
          .toBe("rejected");
        const rows: ReturnType<typeof host.hostState.runtimeEventsAfter> = [];
        let cursor: string | null = null;

        for (;;) {
          const page = host.hostState.runtimeEventsAfter(
            host.hostState.getRuntimeEventStreamId(),
            cursor,
          );

          if (page.length === 0) break;
          rows.push(...page);
          cursor = page.at(-1)!.sequence;
        }
        const segment = rows.find(
          (r) =>
            r.envelope.hostSessionId === session.sessionId &&
            r.envelope.eventType === "runtime_object.available" &&
            typeof r.envelope.payload === "object" &&
            r.envelope.payload !== null &&
            "stdoutSegment" in r.envelope.payload,
        );

        expect(segment).toBeDefined();
        const payload = segment!.envelope.payload as {
          objectId: string;
          sha256: string;
          sizeBytes: number;
        };
        const object = host.hostState.getRuntimeObject(payload.objectId)!;

        expect(
          createHash("sha256")
            .update(readFileSync(object.privatePath))
            .digest("hex"),
        ).toBe(payload.sha256);
        expect(payload.sizeBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
        expect(
          host.hostState.getRuntimeFile(`spool:${session.sessionId}`)
            ?.capacityBytes,
        ).toBe(0);
      }
      expect(host.hostState.runtimeStorageAvailable()).toBe(true);
      expect(
        host.hostState.runtimeFileBudget().chargedBytes,
      ).toBeLessThanOrEqual(limits.objectMaxBytes);
    } finally {
      await host.stop();
      await cleanupRuntimeRoot(host.runtimeRoot);
    }
  });

  it("inventories orphan objects and released-workspace logs before admitting work after restart", () => {
    const root = mkdtempSync(join(tmpdir(), "maister-file-inventory-"));
    const stateDir = join(root, "state");
    const runDir = join(root, "run");
    const objectDir = join(stateDir, "runtime-objects");
    let state = openHostState({ stateDir, limits: LIMITS });

    try {
      state.insertWorkspace({
        id: randomUUID(),
        runId: "old-run",
        projectSlug: "test",
        kind: "scratch",
        path: root,
        realPath: root,
        repoPath: null,
        runDir,
        contextMounts: null,
        adoptedAt: new Date().toISOString(),
        releasedAt: new Date().toISOString(),
      });
      state.close();
      mkdirSync(objectDir, { recursive: true });
      mkdirSync(runDir);
      const objectBytes = Buffer.alloc(8 * 1024 * 1024, 97);
      const logBytes = Buffer.alloc(8 * 1024 * 1024, 98);

      writeFileSync(join(objectDir, "interrupted.partial"), objectBytes);
      writeFileSync(join(runDir, "old-session.log"), logBytes);
      state = openHostState({ stateDir, limits: LIMITS });
      expect(state.runtimeFileBudget()).toMatchObject({
        chargedBytes: objectBytes.length + logBytes.length,
        writtenBytes: objectBytes.length + logBytes.length,
        pressured: true,
      });
      // Native byte comparison avoids enumerating millions of Buffer indices.
      expect(
        readFileSync(join(objectDir, "interrupted.partial")).equals(
          objectBytes,
        ),
      ).toBe(true);
      expect(
        readFileSync(join(runDir, "old-session.log")).equals(logBytes),
      ).toBe(true);
      state.close();
      state = openHostState({ stateDir, limits: LIMITS });
      expect(state.runtimeFileBudget().chargedBytes).toBe(16 * 1024 * 1024);
    } finally {
      state.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes upload writers and frees capacity only after the owned bytes are unlinked", async () => {
    const root = mkdtempSync(join(tmpdir(), "maister-file-writer-"));
    const state = openHostState({
      stateDir: join(root, "state"),
      limits: LIMITS,
    });
    const objects = new RuntimeObjectRegistry(
      state,
      join(root, "state", "runtime-objects"),
    );
    const bytes = Buffer.alloc(8 * 1024 * 1024, 120);
    const objectId = randomUUID();
    const assignmentId = randomUUID();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let release: () => void = () => {};
    let started: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const binding = {
      objectId,
      assignmentId,
      assignmentEpoch: 1,
      generation: 1,
      sizeBytes: bytes.length,
      sha256,
    };

    try {
      await objects.reserve({
        runId: "file-writer",
        assignmentId,
        assignmentEpoch: 1,
        payload: {
          objectId,
          kind: "capability_instructions",
          logicalName: "instructions.md",
          mimeType: "text/markdown",
          sizeBytes: bytes.length,
          sha256,
          generation: 1,
          retentionClass: "run",
        },
      });
      const upload = objects.upload({
        ...binding,
        chunks: (async function* () {
          yield bytes.subarray(0, 65536);
          started();
          await barrier;
          yield bytes.subarray(65536);
        })(),
      });

      await ready;
      try {
        expect(state.runtimeFileBudget().writtenBytes).toBe(65536);
        await expect(objects.remove(binding)).rejects.toMatchObject({
          reason: "command_in_progress",
        });
        expect(state.getRuntimeObject(objectId)?.state).toBe("pending");
        await expect(
          objects.upload({
            ...binding,
            chunks: (async function* () {
              yield bytes;
            })(),
          }),
        ).rejects.toMatchObject({ reason: "command_in_progress" });
      } finally {
        release();
        await upload;
      }
      expect(state.runtimeFileBudget()).toMatchObject({
        chargedBytes: bytes.length,
        writtenBytes: bytes.length,
        pressured: false,
      });
      await objects.remove(binding);
      expect(state.runtimeFileBudget()).toMatchObject({
        chargedBytes: 0,
        writtenBytes: 0,
      });
    } finally {
      state.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reserves capture/teardown bytes before spawn and refuses the next producer without an ACP effect", async () => {
    const host = await bootHost({
      limits: LIMITS,
      fixtureArgs: ["--hang", "--lines", "0"],
    });

    try {
      for (let index = 0; index < 2; index += 1) {
        const created = await postJson(
          `${host.url}/sessions`,
          await createEnvelope(host, { runId: `file-quota-${index}` }),
        );

        expect(created.status).toBe(201);
      }
      const command = await createEnvelope(host, {
        runId: "file-quota-refused",
      });
      const refused = await postJson(`${host.url}/sessions`, command);

      expect(refused.status).toBe(503);
      expect(refused.body.details.reason).toBe("runtime_storage_pressure");
      expect(host.registry.size()).toBe(2);
      expect(host.hostState.getReceipt(command.command.id)).toBeNull();
    } finally {
      await host.stop();
      await cleanupRuntimeRoot(host.runtimeRoot);
    }
  });

  it("charges pending upload and temporary-copy capacity across restart without requiring file bytes to exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "maister-file-budget-"));
    const stateDir = join(root, "state");
    let state = openHostState({ stateDir, limits: LIMITS });
    const objectRoot = join(stateDir, "runtime-objects");
    const assignmentId = randomUUID();
    const payload = {
      objectId: randomUUID(),
      kind: "capability_instructions" as const,
      logicalName: "large.md",
      mimeType: "text/markdown",
      sizeBytes: 10 * 1024 * 1024,
      sha256: createHash("sha256").update("declared-content").digest("hex"),
      generation: 1,
      retentionClass: "run" as const,
    };

    try {
      await new RuntimeObjectRegistry(state, objectRoot).reserve({
        runId: "file-budget",
        assignmentId,
        assignmentEpoch: 1,
        payload,
      });
      state.close();
      state = openHostState({ stateDir, limits: LIMITS });
      await expect(
        new RuntimeObjectRegistry(state, objectRoot).reserve({
          runId: "file-budget",
          assignmentId,
          assignmentEpoch: 1,
          payload: {
            ...payload,
            objectId: randomUUID(),
            logicalName: "refused.md",
            sizeBytes: 1,
          },
        }),
      ).rejects.toMatchObject({ reason: "runtime_storage_pressure" });
      expect(state.getRuntimeObject(payload.objectId)).toMatchObject({
        state: "pending",
        sizeBytes: payload.sizeBytes,
      });
    } finally {
      state.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
