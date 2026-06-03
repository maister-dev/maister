import type { MaisterYamlV2 } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { isMaisterError, MaisterError } from "@/lib/errors";
import { upsertExecutorsFromConfig } from "@/lib/executors";

type InsertCall = {
  values: Record<string, unknown>;
  conflictSet: Record<string, unknown>;
};

type UpdateCall = {
  set: Record<string, unknown>;
};

function makeMockDb(
  opts: { flowUpdateAffectedRows?: Record<string, number> } = {},
) {
  const insertCalls: InsertCall[] = [];
  const updateCalls: UpdateCall[] = [];

  function makeTx() {
    return {
      insert: (_table: unknown) => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: (oc: { set: Record<string, unknown> }) => ({
            returning: () => {
              insertCalls.push({ values, conflictSet: oc.set });
              const id = (values.id as string | undefined) ?? randomUUID();

              return Promise.resolve([{ id }]);
            },
          }),
        }),
      }),
      update: (_table: unknown) => ({
        set: (s: Record<string, unknown>) => ({
          where: (_w: unknown) => ({
            returning: () => {
              updateCalls.push({ set: s });
              // Map override id back to the corresponding flow.id is too much
              // for a unit mock — just key the affected count off of how many
              // updates have run so far.
              const flowIndex = updateCalls.length - 1;
              const flowsAffected =
                opts.flowUpdateAffectedRows?.[`flow${flowIndex}`] ?? 0;

              return Promise.resolve(
                Array.from({ length: flowsAffected }, () => ({
                  id: randomUUID(),
                })),
              );
            },
          }),
        }),
      }),
    };
  }

  return {
    db: {
      transaction: async (fn: (tx: ReturnType<typeof makeTx>) => unknown) =>
        fn(makeTx()),
    },
    insertCalls,
    updateCalls,
  };
}

function captureLogger(): { logger: pino.Logger; sink: { lines: string[] } } {
  const sink = { lines: [] as string[] };
  const stream = new Writable({
    write(chunk, _enc, cb) {
      sink.lines.push(chunk.toString());
      cb();
    },
  });
  const logger = pino({ level: "trace" }, stream);

  return { logger, sink };
}

function baseConfig(over: Partial<MaisterYamlV2> = {}): MaisterYamlV2 {
  const defaults: MaisterYamlV2 = {
    schemaVersion: 2,
    project: {
      name: "p",
      repo_path: "/repos/p",
      main_branch: "main",
      branch_prefix: "maister/",
    },
    executors: [
      { id: "claude-sonnet", agent: "claude", model: "claude-sonnet-4-6" },
    ],
    default_executor: "claude-sonnet",
    capabilities: {
      mcps: [],
      skills: [],
      rules: [],
      restrictions: [],
      settings: [],
      tools: [],
      agent_definitions: [],
      env_profiles: [],
    },
    flow_roles: [],
    capability_imports: [],
    flows: [],
  };

  return {
    ...defaults,
    ...over,
    capabilities: over.capabilities ?? defaults.capabilities,
  };
}

describe("upsertExecutorsFromConfig (unit)", () => {
  it("throws CONFIG when executors[] is empty", async () => {
    const { db } = makeMockDb();
    const cfg = baseConfig({ executors: [] as never });
    const projectId = randomUUID();

    let caught: unknown;

    try {
      await upsertExecutorsFromConfig({ projectId, config: cfg, db });
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as MaisterError).code).toBe("CONFIG");
    expect((caught as MaisterError).message).toMatch(/empty/);
  });

  it("upserts a single claude executor and returns defaultExecutorId", async () => {
    const { db, insertCalls, updateCalls } = makeMockDb();
    const cfg = baseConfig();
    const projectId = randomUUID();

    const result = await upsertExecutorsFromConfig({
      projectId,
      config: cfg,
      db,
    });

    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].values.executorRefId).toBe("claude-sonnet");
    expect(insertCalls[0].values.agent).toBe("claude");
    expect(insertCalls[0].values.router).toBeNull();
    expect(updateCalls).toHaveLength(0);
    expect(result.executorIdByRef["claude-sonnet"]).toBeDefined();
    expect(result.defaultExecutorId).toBe(
      result.executorIdByRef["claude-sonnet"],
    );
  });

  it("upserts two executors and applies one flow override", async () => {
    const { db, insertCalls, updateCalls } = makeMockDb({
      flowUpdateAffectedRows: { flow0: 1 },
    });
    const cfg = baseConfig({
      executors: [
        { id: "claude-sonnet", agent: "claude", model: "claude-sonnet-4-6" },
        { id: "codex-default", agent: "codex", model: "gpt-5-codex" },
      ],
      flows: [
        {
          id: "bugfix",
          source: "github.com/x/y",
          version: "v1.0.0",
          executor_override: "codex-default",
        },
      ],
    });
    const projectId = randomUUID();

    const result = await upsertExecutorsFromConfig({
      projectId,
      config: cfg,
      db,
    });

    expect(insertCalls).toHaveLength(2);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].set.executorOverrideId).toBe(
      result.executorIdByRef["codex-default"],
    );
  });

  it("persists router=ccr on the executor row", async () => {
    const { db, insertCalls } = makeMockDb();
    const cfg = baseConfig({
      executors: [
        {
          id: "claude-glm",
          agent: "claude",
          model: "glm-4.6",
          env: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic" },
          router: "ccr",
        },
      ],
      default_executor: "claude-glm",
    });
    const projectId = randomUUID();

    await upsertExecutorsFromConfig({ projectId, config: cfg, db });

    expect(insertCalls[0].values.router).toBe("ccr");
    expect(insertCalls[0].values.env).toEqual({
      ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic",
    });
    expect(insertCalls[0].conflictSet.router).toBe("ccr");
  });

  it("WARN logs when flow row does not yet exist (zero-row update)", async () => {
    const { db } = makeMockDb({ flowUpdateAffectedRows: { flow0: 0 } });
    const { logger, sink } = captureLogger();
    const cfg = baseConfig({
      executors: [
        { id: "claude-sonnet", agent: "claude", model: "claude-sonnet-4-6" },
      ],
      flows: [
        {
          id: "ghostflow",
          source: "github.com/x/y",
          version: "v1.0.0",
          executor_override: "claude-sonnet",
        },
      ],
    });

    await upsertExecutorsFromConfig({
      projectId: randomUUID(),
      config: cfg,
      db,
      logger,
    });

    const joined = sink.lines.join("");

    expect(joined).toMatch(/flow row not yet installed/);
  });

  it("does not leak env values to logs", async () => {
    const SENTINEL = "sk-LEAK-canary-XYZ";
    const { db } = makeMockDb();
    const { logger, sink } = captureLogger();
    const cfg = baseConfig({
      executors: [
        {
          id: "claude-x",
          agent: "claude",
          model: "claude-sonnet-4-6",
          env: { ANTHROPIC_AUTH_TOKEN: SENTINEL },
        },
      ],
      default_executor: "claude-x",
    });

    await upsertExecutorsFromConfig({
      projectId: randomUUID(),
      config: cfg,
      db,
      logger,
    });

    const joined = sink.lines.join("");

    expect(joined).not.toContain(SENTINEL);
    // hasEnv flag still emitted
    expect(joined).toMatch(/"hasEnv":true/);
  });

  it("throws CONFIG when default_executor refers to a non-existent executor", async () => {
    // Note: loadProjectConfig() already validates this at YAML-load time;
    // this is the defense-in-depth assertion inside upsertExecutorsFromConfig.
    const { db } = makeMockDb();
    const cfg: MaisterYamlV2 = {
      schemaVersion: 2,
      project: {
        name: "p",
        repo_path: "/repos/p",
        main_branch: "main",
        branch_prefix: "maister/",
      },
      executors: [
        { id: "claude-x", agent: "claude", model: "claude-sonnet-4-6" },
      ],
      default_executor: "nope-doesnt-exist",
      capabilities: {
        mcps: [],
        skills: [],
        rules: [],
        restrictions: [],
        settings: [],
        tools: [],
        agent_definitions: [],
        env_profiles: [],
      },
      flow_roles: [],
      capability_imports: [],
      flows: [],
    };

    let caught: unknown;

    try {
      await upsertExecutorsFromConfig({
        projectId: randomUUID(),
        config: cfg,
        db,
      });
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as MaisterError).code).toBe("CONFIG");
  });

  it("throws CONFIG when flow.executor_override does not match a known executor", async () => {
    const { db } = makeMockDb();
    const cfg = baseConfig({
      executors: [
        { id: "claude-sonnet", agent: "claude", model: "claude-sonnet-4-6" },
      ],
      flows: [
        {
          id: "bugfix",
          source: "github.com/x/y",
          version: "v1.0.0",
          executor_override: "phantom-executor",
        },
      ],
    });

    let caught: unknown;

    try {
      await upsertExecutorsFromConfig({
        projectId: randomUUID(),
        config: cfg,
        db,
      });
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as MaisterError).code).toBe("CONFIG");
  });
});
