import type { MaisterCapabilitiesConfig } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it } from "vitest";

import {
  capabilityInputsFromConfig,
  upsertCapabilitiesFromConfig,
} from "@/lib/capabilities/catalog";
import { isMaisterError, MaisterError } from "@/lib/errors";

type InsertCall = {
  values: Record<string, unknown>;
  conflictTarget: readonly unknown[];
  conflictSet: Record<string, unknown>;
};

type UpdateCall = {
  set: Record<string, unknown>;
};

function emptyCapabilities(): MaisterCapabilitiesConfig {
  return {
    mcps: [],
    skills: [],
    rules: [],
    restrictions: [],
    settings: [],
    tools: [],
    agent_definitions: [],
    env_profiles: [],
  };
}

function makeMockDb() {
  const insertCalls: InsertCall[] = [];
  const updateCalls: UpdateCall[] = [];

  function makeTx() {
    return {
      // assertConfigDoesNotOverwriteAuthoredRecord reads the existing row before
      // each upsert; no fixture here is authored, so an empty result lets the
      // guard pass through to the insert/disable paths under test.
      select: (_columns: unknown) => ({
        from: (_table: unknown) => ({
          where: (_where: unknown) => ({
            limit: (_n: number) => Promise.resolve([]),
          }),
        }),
      }),
      insert: (_table: unknown) => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoUpdate: (oc: {
            target: readonly unknown[];
            set: Record<string, unknown>;
          }) => ({
            returning: () => {
              insertCalls.push({
                values,
                conflictTarget: oc.target,
                conflictSet: oc.set,
              });

              return Promise.resolve([{ id: values.id as string }]);
            },
          }),
        }),
      }),
      update: (_table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (_where: unknown) => {
            updateCalls.push({ set });

            return Promise.resolve([]);
          },
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

describe("capabilityInputsFromConfig", () => {
  it("normalizes project and platform capabilities without env secret values", () => {
    const inputs = capabilityInputsFromConfig({
      ...emptyCapabilities(),
      mcps: [
        {
          id: "project-github",
          kind: "mcp",
          source: "project",
          command: "github-mcp",
          env: { GITHUB_TOKEN: "raw-token" },
          agents: ["claude", "codex"],
          enforceability: "enforced",
          selected_by_default: true,
        },
      ],
      platformMcps: [
        {
          id: "platform-fs",
          kind: "mcp",
          source: "platform",
          command: "filesystem-mcp",
          agents: ["claude", "codex"],
          enforceability: "enforced",
          selected_by_default: true,
        },
      ],
    });

    expect(
      inputs.map((i) => `${i.source}:${i.kind}:${i.capabilityRefId}`),
    ).toEqual(["platform:mcp:platform-fs", "project:mcp:project-github"]);
    expect(inputs[1].material).toMatchObject({
      command: "github-mcp",
      envKeys: ["GITHUB_TOKEN"],
    });
    expect(JSON.stringify(inputs)).not.toContain("raw-token");
  });

  it("omits the mcp config blob from material — config can carry secret values (ISSUE 2)", () => {
    const inputs = capabilityInputsFromConfig({
      ...emptyCapabilities(),
      mcps: [
        {
          id: "github",
          kind: "mcp",
          source: "project",
          command: "github-mcp",
          config: {
            token: "CFG_SECRET_value",
            nested: { auth: "CFG_SECRET_value" },
          },
          agents: ["claude"],
          enforceability: "enforced",
          selected_by_default: true,
        },
      ],
    });

    const gh = inputs.find((i) => i.capabilityRefId === "github");

    expect(gh).toBeDefined();
    expect("config" in (gh!.material as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(inputs)).not.toContain("CFG_SECRET_value");
  });

  it("rejects duplicate ids in the same source/kind scope", () => {
    expect(() =>
      capabilityInputsFromConfig({
        ...emptyCapabilities(),
        mcps: [
          {
            id: "github",
            kind: "mcp",
            source: "project",
            command: "a",
            agents: ["claude"],
            enforceability: "enforced",
            selected_by_default: true,
          },
          {
            id: "github",
            kind: "mcp",
            source: "project",
            command: "b",
            agents: ["codex"],
            enforceability: "enforced",
            selected_by_default: true,
          },
        ],
      }),
    ).toThrow(/Duplicate capability id/);
  });

  it("allows the same ref id across platform and project scopes", () => {
    const inputs = capabilityInputsFromConfig({
      ...emptyCapabilities(),
      mcps: [
        {
          id: "github",
          kind: "mcp",
          source: "project",
          command: "project-github-mcp",
          agents: ["claude"],
          enforceability: "enforced",
          selected_by_default: true,
        },
      ],
      platformMcps: [
        {
          id: "github",
          kind: "mcp",
          source: "platform",
          command: "platform-github-mcp",
          agents: ["codex"],
          enforceability: "enforced",
          selected_by_default: true,
        },
      ],
    });

    expect(
      inputs.map((i) => `${i.source}:${i.kind}:${i.capabilityRefId}`),
    ).toEqual(["platform:mcp:github", "project:mcp:github"]);
  });
});

describe("upsertCapabilitiesFromConfig", () => {
  it("upserts selectable records and clears every source/kind scope", async () => {
    const { db, insertCalls, updateCalls } = makeMockDb();

    const result = await upsertCapabilitiesFromConfig({
      projectId: randomUUID(),
      config: {
        ...emptyCapabilities(),
        skills: [
          {
            id: "aif-implement",
            kind: "skill",
            source: "git",
            path: ".agents/skills/aif-implement",
            agents: ["claude", "codex"],
            enforceability: "instructed",
            selected_by_default: true,
          },
          {
            id: "flow-review",
            kind: "skill",
            source: "flow-package",
            path: ".maister/flows/review/SKILL.md",
            agents: ["claude"],
            enforceability: "instructed",
            selected_by_default: false,
          },
        ],
      },
      platformMcps: [
        {
          id: "github",
          kind: "mcp",
          source: "platform",
          command: "github-mcp",
          agents: ["claude", "codex"],
          enforceability: "enforced",
          selected_by_default: true,
        },
      ],
      db,
    });

    expect(result.upsertedCount).toBe(3);
    expect(result.disabledScopes).toBe(24);
    expect(insertCalls[0].values).toMatchObject({
      capabilityRefId: "github",
      kind: "mcp",
      source: "platform",
      selectable: true,
    });
    expect(
      insertCalls.map(
        (call) =>
          `${call.values.source}:${call.values.kind}:${call.values.capabilityRefId}`,
      ),
    ).toEqual([
      "platform:mcp:github",
      "project:skill:aif-implement",
      "flow-package:skill:flow-review",
    ]);
    expect(
      insertCalls.every(
        (call) =>
          call.conflictSet.disabledAt === null &&
          call.conflictSet.selectable === true &&
          call.conflictTarget.length === 4,
      ),
    ).toBe(true);
    expect(updateCalls).toHaveLength(24);
    expect(
      updateCalls.every(
        (call) =>
          call.set.selectable === false && call.set.disabledAt instanceof Date,
      ),
    ).toBe(true);
  });

  it("does not log raw env values", async () => {
    const { db } = makeMockDb();
    const { logger, sink } = captureLogger();
    const sentinel = "secret-canary";

    await upsertCapabilitiesFromConfig({
      projectId: randomUUID(),
      config: emptyCapabilities(),
      platformMcps: [
        {
          id: "github",
          kind: "mcp",
          source: "platform",
          command: "github-mcp",
          env: { GITHUB_TOKEN: sentinel },
          agents: ["claude", "codex"],
          enforceability: "enforced",
          selected_by_default: true,
        },
      ],
      db,
      logger,
    });

    expect(sink.lines.join("")).not.toContain(sentinel);
  });

  it("throws CONFIG for duplicate capability ids", async () => {
    const { db } = makeMockDb();
    let caught: unknown;

    try {
      await upsertCapabilitiesFromConfig({
        projectId: randomUUID(),
        config: {
          ...emptyCapabilities(),
          rules: [
            {
              id: "r",
              kind: "rule",
              source: "project",
              content: "one",
              agents: ["claude"],
              enforceability: "instructed",
              selected_by_default: true,
            },
            {
              id: "r",
              kind: "rule",
              source: "project",
              content: "two",
              agents: ["codex"],
              enforceability: "instructed",
              selected_by_default: true,
            },
          ],
        },
        db,
      });
    } catch (err) {
      caught = err;
    }

    expect(isMaisterError(caught)).toBe(true);
    expect((caught as MaisterError).code).toBe("CONFIG");
  });
});
