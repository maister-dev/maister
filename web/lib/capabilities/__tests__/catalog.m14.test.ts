/**
 * T1.2 — capabilityInputsFromConfig: agent_definition + env_profile kinds (M14)
 *
 * Tests:
 *  (a) agent_definition and env_profile kinds are emitted with correct fields;
 *      env_profile env values are REDACTED to key-names only in material.
 *  (b) R-SYM for env_profile: SET / CLEAR / idempotent-reset.
 */
import type { MaisterCapabilitiesConfig } from "@/lib/config.schema";

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  capabilityInputsFromConfig,
  upsertCapabilitiesFromConfig,
} from "@/lib/capabilities/catalog";

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

type InsertCall = {
  values: Record<string, unknown>;
  conflictTarget: readonly unknown[];
  conflictSet: Record<string, unknown>;
};

type UpdateCall = {
  set: Record<string, unknown>;
  whereArgs?: unknown;
};

function makeMockDb() {
  const insertCalls: InsertCall[] = [];
  const updateCalls: UpdateCall[] = [];

  // Track which DB rows exist so we can simulate disable-on-remove.
  const rows: Array<{
    projectId: string;
    source: string;
    kind: string;
    capabilityRefId: string;
    disabledAt: Date | null;
    selectable: boolean;
  }> = [];

  function makeTx() {
    return {
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
              // Upsert: update or insert in the in-memory rows array.
              const existing = rows.find(
                (r) =>
                  r.projectId === values.projectId &&
                  r.source === values.source &&
                  r.kind === values.kind &&
                  r.capabilityRefId === values.capabilityRefId,
              );

              if (existing) {
                existing.disabledAt = null;
                existing.selectable = true;
              } else {
                rows.push({
                  projectId: values.projectId as string,
                  source: values.source as string,
                  kind: values.kind as string,
                  capabilityRefId: values.capabilityRefId as string,
                  disabledAt: null,
                  selectable: true,
                });
              }

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
    rows,
  };
}

// ─── (a) emission + redaction ─────────────────────────────────────────────────

describe("capabilityInputsFromConfig — M14 new kinds", () => {
  it("emits agent_definition records with kind='agent_definition'", () => {
    const inputs = capabilityInputsFromConfig({
      ...emptyCapabilities(),
      agent_definitions: [
        {
          id: "my-agent",
          kind: "agent_definition",
          source: "project",
          agents: ["claude"],
          enforceability: "instructed",
          selected_by_default: true,
        },
      ],
    });

    const agentDefInputs = inputs.filter((i) => i.kind === "agent_definition");

    expect(agentDefInputs).toHaveLength(1);
    expect(agentDefInputs[0]).toMatchObject({
      capabilityRefId: "my-agent",
      kind: "agent_definition",
      source: "project",
      enforceability: "instructed",
      selectedByDefault: true,
    });
  });

  it("emits env_profile records with kind='env_profile'", () => {
    const inputs = capabilityInputsFromConfig({
      ...emptyCapabilities(),
      env_profiles: [
        {
          id: "prod-keys",
          kind: "env_profile",
          source: "project",
          agents: ["claude"],
          enforceability: "instructed",
          selected_by_default: false,
          env: { ANTHROPIC_AUTH_TOKEN: "secret", OPENAI_KEY: "also-secret" },
        },
      ],
    });

    const envProfileInputs = inputs.filter((i) => i.kind === "env_profile");

    expect(envProfileInputs).toHaveLength(1);
    expect(envProfileInputs[0]).toMatchObject({
      capabilityRefId: "prod-keys",
      kind: "env_profile",
      source: "project",
    });
  });

  it("REDACTS env values — material contains only key names, not values", () => {
    const inputs = capabilityInputsFromConfig({
      ...emptyCapabilities(),
      env_profiles: [
        {
          id: "secrets",
          kind: "env_profile",
          source: "project",
          agents: ["claude"],
          enforceability: "instructed",
          selected_by_default: false,
          env: {
            ANTHROPIC_AUTH_TOKEN: "real-secret-value",
            OPENAI_KEY: "other-secret",
          },
        },
      ],
    });

    const record = inputs.find((i) => i.kind === "env_profile");

    expect(record).toBeDefined();
    // envKeys should be the key names only (sorted)
    expect(record!.material).toMatchObject({
      envKeys: ["ANTHROPIC_AUTH_TOKEN", "OPENAI_KEY"],
    });
    // The secret values must NOT appear anywhere in the serialized record
    expect(JSON.stringify(record)).not.toContain("real-secret-value");
    expect(JSON.stringify(record)).not.toContain("other-secret");
  });

  it("env_profile with no env key produces empty envKeys", () => {
    const inputs = capabilityInputsFromConfig({
      ...emptyCapabilities(),
      env_profiles: [
        {
          id: "no-env",
          kind: "env_profile",
          source: "project",
          agents: ["claude"],
          enforceability: "instructed",
          selected_by_default: true,
        },
      ],
    });

    const record = inputs.find((i) => i.kind === "env_profile");

    expect(record!.material).toMatchObject({ envKeys: [] });
  });
});

// ─── (b) R-SYM: SET / CLEAR / idempotent-reset ────────────────────────────────

describe("upsertCapabilitiesFromConfig — env_profile R-SYM (M14)", () => {
  it("SET: adding an env_profile creates a capability record", async () => {
    const { db, insertCalls } = makeMockDb();
    const projectId = randomUUID();

    await upsertCapabilitiesFromConfig({
      projectId,
      config: {
        ...emptyCapabilities(),
        env_profiles: [
          {
            id: "prod-keys",
            kind: "env_profile",
            source: "project",
            agents: ["claude"],
            enforceability: "instructed",
            selected_by_default: false,
            env: { MY_KEY: "val" },
          },
        ],
      },
      db,
    });

    const envProfileInserts = insertCalls.filter(
      (c) => c.values.kind === "env_profile",
    );

    expect(envProfileInserts).toHaveLength(1);
    expect(envProfileInserts[0].values).toMatchObject({
      capabilityRefId: "prod-keys",
      kind: "env_profile",
      disabledAt: null,
      selectable: true,
    });
    // env value must not be stored
    expect(JSON.stringify(envProfileInserts[0].values)).not.toContain("val");
  });

  it("CLEAR: removing env_profile on next upsert sets disabledAt", async () => {
    const { db, insertCalls, updateCalls } = makeMockDb();
    const projectId = randomUUID();

    // First upsert: with env_profile
    await upsertCapabilitiesFromConfig({
      projectId,
      config: {
        ...emptyCapabilities(),
        env_profiles: [
          {
            id: "prod-keys",
            kind: "env_profile",
            source: "project",
            agents: ["claude"],
            enforceability: "instructed",
            selected_by_default: false,
          },
        ],
      },
      db,
    });

    const insertCountBefore = insertCalls.length;
    const updateCountBefore = updateCalls.length;

    // Second upsert: env_profile removed
    await upsertCapabilitiesFromConfig({
      projectId,
      config: emptyCapabilities(),
      db,
    });

    // env_profile must NOT be re-upserted on CLEAR (it is absent from config).
    // This would still pass if the disable loop ran but re-upserted env_profile —
    // asserting zero inserts for the kind proves the entry was truly removed.
    const envProfileInsertsDuringClear = insertCalls
      .slice(insertCountBefore)
      .filter((c) => c.values.kind === "env_profile");

    expect(envProfileInsertsDuringClear).toHaveLength(0);

    // The disable sweep must have fired at least one update with disabledAt set
    // (the env_profile scope, along with other (source×kind) combinations).
    const disableUpdates = updateCalls
      .slice(updateCountBefore)
      .filter((c) => c.set.disabledAt instanceof Date);

    expect(disableUpdates.length).toBeGreaterThan(0);
  });

  it("idempotent-reset: re-adding env_profile re-enables it (disabledAt=null)", async () => {
    const { db, insertCalls } = makeMockDb();
    const projectId = randomUUID();

    // Add
    await upsertCapabilitiesFromConfig({
      projectId,
      config: {
        ...emptyCapabilities(),
        env_profiles: [
          {
            id: "prod-keys",
            kind: "env_profile",
            source: "project",
            agents: ["claude"],
            enforceability: "instructed",
            selected_by_default: false,
          },
        ],
      },
      db,
    });

    // Remove
    await upsertCapabilitiesFromConfig({
      projectId,
      config: emptyCapabilities(),
      db,
    });

    // Re-add
    await upsertCapabilitiesFromConfig({
      projectId,
      config: {
        ...emptyCapabilities(),
        env_profiles: [
          {
            id: "prod-keys",
            kind: "env_profile",
            source: "project",
            agents: ["claude"],
            enforceability: "instructed",
            selected_by_default: false,
          },
        ],
      },
      db,
    });

    const envProfileInserts = insertCalls.filter(
      (c) => c.values.kind === "env_profile",
    );

    // Should have been inserted/re-upserted, with disabledAt=null on each upsert
    expect(envProfileInserts.length).toBeGreaterThanOrEqual(1);
    expect(
      envProfileInserts.every((c) => c.conflictSet.disabledAt === null),
    ).toBe(true);
  });
});
