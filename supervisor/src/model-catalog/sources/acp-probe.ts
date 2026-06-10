import type { Logger } from "pino";
import type {
  ReadableStream as NodeReadableStream,
  WritableStream as NodeWritableStream,
} from "node:stream/web";
import type {
  ExecutorAgent,
  RunnerLaunch,
  StartSessionRequest,
} from "../../types";

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Readable,
  Writable,
  type Readable as NodeReadable,
  type Writable as NodeWritable,
} from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import { provisionRunnerLaunch } from "../../runner-provisioner";
import { buildChildEnv } from "../../spawn";
import {
  ACP_PROBE_TIMEOUT_MS,
  type ModelCatalogDraft,
  type ModelEntry,
  type ModelSource,
  type ResolveContext,
} from "../types";

const BINARY_BY_AGENT: Record<ExecutorAgent, string> = {
  claude: "claude-agent-acp",
  codex: "codex-acp",
};

// A2 active probe (ADR-073 primary source). Spawns the already-trusted adapter
// binary in an isolated tmp cwd, drives a promptless ACP handshake
// (initialize → session/new, ~0 tokens), reads NewSessionResponse.models, and
// SIGTERMs the child on EVERY exit path (deferred-release — success, reject,
// parse error, timeout). CCR-routed drafts are the CCR source's job, so the
// probe declines them. openai_compatible (codex) cannot be provisioned for a
// direct spawn → the probe degrades to status:"skipped".
export type AcpProbeOptions = {
  spawnImpl?: typeof nodeSpawn;
  binaryOverride?: string;
  preArgs?: string[];
  timeoutMs?: number;
};

const noopClient: acp.Client = {
  async sessionUpdate() {
    /* probe never prompts — ignore any updates */
  },
  async requestPermission() {
    return { outcome: { outcome: "cancelled" } };
  },
};

function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`acp probe timed out after ${ms}ms`)),
      ms,
    );

    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createAcpProbeSource(opts: AcpProbeOptions = {}): ModelSource {
  const spawnImpl = opts.spawnImpl ?? nodeSpawn;
  const timeoutMs = opts.timeoutMs ?? ACP_PROBE_TIMEOUT_MS;

  async function readModels(
    binary: string,
    args: string[],
    childEnv: NodeJS.ProcessEnv,
    cwd: string,
  ): Promise<acp.ModelInfo[]> {
    const child: ChildProcess = spawnImpl(binary, args, {
      cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "ignore"],
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          child.off("spawn", onSpawn);
          reject(err);
        };
        const onSpawn = () => {
          child.off("error", onError);
          resolve();
        };

        child.once("error", onError);
        child.once("spawn", onSpawn);
      });

      if (!child.stdin || !child.stdout) {
        throw new Error("probe child has no stdio");
      }

      const stream = acp.ndJsonStream(
        Writable.toWeb(
          child.stdin as NodeWritable,
        ) as unknown as NodeWritableStream<Uint8Array>,
        Readable.toWeb(
          child.stdout as NodeReadable,
        ) as unknown as NodeReadableStream<Uint8Array>,
      );
      const connection = new acp.ClientSideConnection(() => noopClient, stream);
      const probe = (async () => {
        await connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: {} },
        });
        const resp = await connection.newSession({ cwd, mcpServers: [] });

        return resp.models?.availableModels ?? [];
      })();

      // On timeout the `probe` promise loses the race but keeps running; once
      // the child is SIGTERMed its stdio closes and `probe` rejects. Swallow
      // that late rejection so it can never surface as an unhandled rejection.
      probe.catch(() => {});

      return await withTimeout(timeoutMs, probe);
    } finally {
      // Deferred-release: SIGTERM on every exit path (success, reject, parse
      // error, timeout). "Log and continue" is forbidden (ADR-073). The SDK's
      // ClientSideConnection exposes no explicit close() — killing the child
      // closes its stdio, which ends the ndJsonStream and the connection's
      // read loop.
      try {
        child.kill("SIGTERM");
      } catch {
        /* child already gone */
      }
    }
  }

  return {
    kind: "acp_probe",
    supports: (draft: ModelCatalogDraft) => draft.router !== "ccr",
    resolve: async (draft: ModelCatalogDraft, ctx: ResolveContext) => {
      const logger: Logger = ctx.logger;
      const runner: RunnerLaunch = {
        version: 1,
        runnerId: "model-probe",
        adapter: draft.adapter,
        capabilityAgent: draft.adapter,
        model: "model-probe",
        provider: draft.provider,
        permissionPolicy: "default",
      };

      let executor;

      try {
        executor = provisionRunnerLaunch(runner).executor;
      } catch (err) {
        // openai_compatible throws "requires Codex profile materialization";
        // a missing env-ref throws EXECUTOR_UNAVAILABLE. Both degrade to a
        // best-effort skip — the curated/provider sources still answer.
        return {
          models: [],
          status: {
            kind: "acp_probe" as const,
            status: "skipped" as const,
            reason: errorMessage(err),
          },
        };
      }

      const cwd = await mkdtemp(join(tmpdir(), "maister-model-probe-"));
      const binary = opts.binaryOverride ?? BINARY_BY_AGENT[draft.adapter];
      const synthRequest: StartSessionRequest = {
        runId: "model-probe",
        projectSlug: "model-probe",
        worktreePath: cwd,
        stepId: "probe",
        executor,
      };
      const childEnv = buildChildEnv(synthRequest, { ccrLayer: {} });
      const args = [...(opts.preArgs ?? [])];

      try {
        const available = await readModels(binary, args, childEnv, cwd);
        const models: ModelEntry[] = available.map((m) => ({
          id: m.modelId,
          ...(m.name ? { displayName: m.name } : {}),
          origins: ["acp_probe" as const],
        }));

        logger.info(
          { source: "acp_probe", status: "ok", count: models.length },
          "model-catalog probe ok",
        );

        return {
          models,
          status: {
            kind: "acp_probe" as const,
            status: "ok" as const,
            count: models.length,
          },
        };
      } catch (err) {
        logger.info(
          { source: "acp_probe", status: "error" },
          "model-catalog probe error",
        );

        return {
          models: [],
          status: {
            kind: "acp_probe" as const,
            status: "error" as const,
            reason: errorMessage(err),
          },
        };
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}
