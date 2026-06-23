import type {
  AiCodingSettings,
  JudgeSettings,
  EnforcementMode,
  CapabilityAgent,
} from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import {
  ENFORCEABILITY_BY_AGENT,
  evaluateNodeEnforcement,
  assertNodeLaunchable,
  type CapabilityClass,
} from "@/lib/flows/enforcement";
import { flowYamlV1Schema } from "@/lib/config.schema";
import { isMaisterError } from "@/lib/errors";

// Parse node settings through the REAL manifest schema (the production path),
// not a hand-built object literal — so the sparse-enforcement-map behavior is
// exercised end-to-end. A bare object literal skips Zod and cannot catch a
// regression that re-introduces per-key `instruct` defaults.
function parsedAiCodingSettings(
  settings: Record<string, unknown>,
): AiCodingSettings | undefined {
  const manifest = flowYamlV1Schema.parse({
    schemaVersion: 1,
    name: "g",
    nodes: [
      {
        id: "implement",
        type: "ai_coding",
        action: { prompt: "/x" },
        transitions: { success: "done" },
        settings,
      },
    ],
  });
  const node = manifest.nodes?.[0];

  return node && node.type === "ai_coding" ? node.settings : undefined;
}

// FROZEN SPEC encoding — docs/system-analytics/flow-settings.md (M11c) +
// ADR-032. These tests are the executable mirror of the two frozen tables:
// `ENFORCEABILITY_BY_AGENT` (all-`instructed`) and the
// `evaluateNodeEnforcement` truth table. They MUST NOT drift from the doc.

const ALL_CLASSES: CapabilityClass[] = [
  "mcps",
  "tools",
  "skills",
  "restrictions",
  "permissionMode",
  "workspaceAccess",
  "hooks",
];

type Capability = "enforced" | "instructed" | "unsupported";
type Verdict = "enforced" | "instructed" | "refused";
type Table = Record<CapabilityAgent, Record<CapabilityClass, Capability>>;

// The per-class entry `evaluateNodeEnforcement` returns. Declared here so the
// callbacks below stay strict-typed even while `@/lib/flows/enforcement` is
// still missing (RED). This MUST match the implementor's return-element shape.
type EnforcementEntry = {
  class: CapabilityClass;
  declared: EnforcementMode;
  capability: Capability;
  verdict: Verdict;
};

// ---------------------------------------------------------------------------
// 1. ENFORCEABILITY_BY_AGENT frozen — every cell instructed, no `enforced`.
// ---------------------------------------------------------------------------

describe("ENFORCEABILITY_BY_AGENT — conservative all-adapter table", () => {
  it("is value-for-value `instructed` for all adapters × all 7 classes", () => {
    const expected: Table = {
      claude: {
        mcps: "instructed",
        tools: "instructed",
        skills: "instructed",
        restrictions: "instructed",
        permissionMode: "instructed",
        workspaceAccess: "instructed",
        hooks: "instructed",
      },
      codex: {
        mcps: "instructed",
        tools: "instructed",
        skills: "instructed",
        restrictions: "instructed",
        permissionMode: "instructed",
        workspaceAccess: "instructed",
        hooks: "instructed",
      },
      gemini: {
        mcps: "instructed",
        tools: "instructed",
        skills: "instructed",
        restrictions: "instructed",
        permissionMode: "instructed",
        workspaceAccess: "instructed",
        hooks: "instructed",
      },
      opencode: {
        mcps: "instructed",
        tools: "instructed",
        skills: "instructed",
        restrictions: "instructed",
        permissionMode: "instructed",
        workspaceAccess: "instructed",
        hooks: "instructed",
      },
      mimo: {
        mcps: "instructed",
        tools: "instructed",
        skills: "instructed",
        restrictions: "instructed",
        permissionMode: "instructed",
        workspaceAccess: "instructed",
        hooks: "instructed",
      },
    };

    expect(ENFORCEABILITY_BY_AGENT).toEqual(expected);
  });

  it("contains NO `enforced` cell (the M11c silent-escape-hatch invariant)", () => {
    for (const agent of [
      "claude",
      "codex",
      "gemini",
      "opencode",
      "mimo",
    ] as const) {
      for (const cls of ALL_CLASSES) {
        expect(ENFORCEABILITY_BY_AGENT[agent][cls]).not.toBe("enforced");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 1b. hooks capability class (ADR-104, M40) — 7th class, all `instructed`.
// ---------------------------------------------------------------------------

describe("hooks capability class — enforcement (ADR-104)", () => {
  // NB: the per-agent `hooks=instructed` cells are already pinned by the
  // full-table `toEqual` above; this block only covers hooks-specific behavior.
  it("evaluateNodeEnforcement reports a refused verdict for strict hooks", () => {
    const result = evaluateNodeEnforcement(
      { enforcement: { hooks: "strict" } } as AiCodingSettings,
      "claude",
    );
    const hooksEntry = result.find(
      (e: EnforcementEntry) => e.class === "hooks",
    );

    expect(hooksEntry).toEqual({
      class: "hooks",
      declared: "strict",
      capability: "instructed",
      verdict: "refused",
    });
  });

  it("a strict hooks declaration is refused at launch (CONFIG)", () => {
    expect(() =>
      assertNodeLaunchable(
        {
          id: "n1",
          type: "ai_coding",
          settings: {
            enforcement: { hooks: "strict" },
          } as AiCodingSettings,
        },
        "claude",
      ),
    ).toThrow(/hooks/);
  });

  it("a hooks data field with no explicit intent → instructed (not refused)", () => {
    const result = evaluateNodeEnforcement(
      { hooks: { repetition: { max: 5 } } } as AiCodingSettings,
      "claude",
    );
    const hooksEntry = result.find(
      (e: EnforcementEntry) => e.class === "hooks",
    );

    expect(hooksEntry?.verdict).toBe("instructed");
  });
});

// ---------------------------------------------------------------------------
// 2. evaluateNodeEnforcement — truth table for every (declared × capability).
// ---------------------------------------------------------------------------

// A table that injects an `enforced` cell so the strict×enforced and
// strict×unsupported rows of the frozen truth table can be exercised (the
// real M11c table has no `enforced` cell). `permissionMode` is enforced for
// `claude` only; `mcps` is unsupported for `claude`; everything else mirrors
// the conservative real table.
const injectedTable: Table = {
  claude: {
    mcps: "unsupported",
    tools: "instructed",
    skills: "instructed",
    restrictions: "instructed",
    permissionMode: "enforced",
    workspaceAccess: "instructed",
    hooks: "instructed",
  },
  codex: {
    mcps: "instructed",
    tools: "instructed",
    skills: "instructed",
    restrictions: "instructed",
    permissionMode: "instructed",
    workspaceAccess: "instructed",
    hooks: "instructed",
  },
  gemini: {
    mcps: "instructed",
    tools: "instructed",
    skills: "instructed",
    restrictions: "instructed",
    permissionMode: "instructed",
    workspaceAccess: "instructed",
    hooks: "instructed",
  },
  opencode: {
    mcps: "instructed",
    tools: "instructed",
    skills: "instructed",
    restrictions: "instructed",
    permissionMode: "instructed",
    workspaceAccess: "instructed",
    hooks: "instructed",
  },
  mimo: {
    mcps: "instructed",
    tools: "instructed",
    skills: "instructed",
    restrictions: "instructed",
    permissionMode: "instructed",
    workspaceAccess: "instructed",
    hooks: "instructed",
  },
};

// Build an ai_coding settings object that declares `cls` via the `enforcement`
// map with the given intent. The `enforcement` map is the canonical "declares
// this class" signal per the frozen spec ("the data field is present OR an
// `enforcement` entry is present").
function settingsDeclaring(
  cls: CapabilityClass,
  declared: EnforcementMode,
): AiCodingSettings {
  return { enforcement: { [cls]: declared } } as AiCodingSettings;
}

describe("evaluateNodeEnforcement — FROZEN truth table", () => {
  // | declared  | capability  | verdict     |
  // | off       | (any)       | (omitted)   |
  // | instruct  | enforced    | instructed  |
  // | instruct  | instructed  | instructed  |
  // | instruct  | unsupported | instructed  |
  // | strict    | enforced    | enforced    |
  // | strict    | instructed  | refused     |
  // | strict    | unsupported | refused     |
  const cases: Array<{
    declared: EnforcementMode;
    capability: Capability;
    verdict: Verdict | "OMITTED";
  }> = [
    { declared: "off", capability: "enforced", verdict: "OMITTED" },
    { declared: "off", capability: "instructed", verdict: "OMITTED" },
    { declared: "off", capability: "unsupported", verdict: "OMITTED" },
    { declared: "instruct", capability: "enforced", verdict: "instructed" },
    { declared: "instruct", capability: "instructed", verdict: "instructed" },
    { declared: "instruct", capability: "unsupported", verdict: "instructed" },
    { declared: "strict", capability: "enforced", verdict: "enforced" },
    { declared: "strict", capability: "instructed", verdict: "refused" },
    { declared: "strict", capability: "unsupported", verdict: "refused" },
  ];

  for (const row of cases) {
    it(`declared=${row.declared} × capability=${row.capability} → ${row.verdict}`, () => {
      // Pick an agent+class+table combination that yields the target
      // `capability` cell. permissionMode/claude=enforced, mcps/claude=unsupported,
      // tools/claude=instructed in the injected table.
      let cls: CapabilityClass;
      const agent = "claude" as const;

      if (row.capability === "enforced") cls = "permissionMode";
      else if (row.capability === "unsupported") cls = "mcps";
      else cls = "tools";

      const result = evaluateNodeEnforcement(
        settingsDeclaring(cls, row.declared),
        agent,
        injectedTable,
      );

      const entry = result.find((e: EnforcementEntry) => e.class === cls);

      if (row.verdict === "OMITTED") {
        expect(entry).toBeUndefined();
      } else {
        expect(entry).toBeDefined();
        expect(entry!.declared).toBe(row.declared);
        expect(entry!.capability).toBe(row.capability);
        expect(entry!.verdict).toBe(row.verdict);
      }
    });
  }

  it("with the default (real, all-instructed) table: strict → refused, instruct → instructed", () => {
    const refused = evaluateNodeEnforcement(
      settingsDeclaring("mcps", "strict"),
      "claude",
    );

    expect(refused.find((e: EnforcementEntry) => e.class === "mcps")).toEqual({
      class: "mcps",
      declared: "strict",
      capability: "instructed",
      verdict: "refused",
    });

    const instructed = evaluateNodeEnforcement(
      settingsDeclaring("mcps", "instruct"),
      "claude",
    );

    expect(
      instructed.find((e: EnforcementEntry) => e.class === "mcps")?.verdict,
    ).toBe("instructed");
  });

  it("omits `off` classes from the result entirely", () => {
    const result = evaluateNodeEnforcement(
      { enforcement: { mcps: "off", tools: "strict" } } as AiCodingSettings,
      "claude",
    );

    expect(
      result.find((e: EnforcementEntry) => e.class === "mcps"),
    ).toBeUndefined();
    expect(
      result.find((e: EnforcementEntry) => e.class === "tools"),
    ).toBeDefined();
  });

  it("produces no entry for a class the node does not declare", () => {
    const result = evaluateNodeEnforcement(
      { enforcement: { mcps: "strict" } } as AiCodingSettings,
      "claude",
    );

    // Only `mcps` is declared; the other five classes are absent.
    const declaredClasses = result.map((e: EnforcementEntry) => e.class);

    expect(declaredClasses).toEqual(["mcps"]);
    expect(
      result.find((e: EnforcementEntry) => e.class === "skills"),
    ).toBeUndefined();
    expect(
      result.find((e: EnforcementEntry) => e.class === "workspaceAccess"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. default declared = `instruct` — a class present as DATA but absent from
//    the `enforcement` map resolves to declared="instruct" → instructed.
// ---------------------------------------------------------------------------

describe("evaluateNodeEnforcement — default declared intent", () => {
  it("a class present as a data field with no `enforcement` entry → declared=instruct, verdict=instructed", () => {
    const settings: AiCodingSettings = {
      mcps: ["github"],
    } as AiCodingSettings;

    const result = evaluateNodeEnforcement(settings, "claude");
    const entry = result.find((e: EnforcementEntry) => e.class === "mcps");

    expect(entry).toBeDefined();
    expect(entry!.declared).toBe("instruct");
    expect(entry!.verdict).toBe("instructed");
  });
});

// ---------------------------------------------------------------------------
// 3b. Production parse path — a sparse `enforcement` map parsed through the
//     manifest schema must NOT expand into undeclared classes. This is the
//     regression a bare-object-literal test cannot catch.
// ---------------------------------------------------------------------------

describe("evaluateNodeEnforcement — parsed-manifest sparse map", () => {
  it("enforcement.mcps=strict (parsed) reports ONLY mcps, not six defaulted classes", () => {
    const settings = parsedAiCodingSettings({
      enforcement: { mcps: "strict" },
    });

    // The parse MUST keep the map sparse.
    expect(Object.keys(settings?.enforcement ?? {})).toEqual(["mcps"]);

    const result = evaluateNodeEnforcement(settings, "claude");

    expect(result.map((e: EnforcementEntry) => e.class)).toEqual(["mcps"]);
    expect(result[0].verdict).toBe("refused");
  });

  it("a data field with no enforcement entry (parsed) still defaults to instruct at evaluation", () => {
    const settings = parsedAiCodingSettings({ skills: ["aif-implement"] });
    const result = evaluateNodeEnforcement(settings, "claude");

    expect(result.map((e: EnforcementEntry) => e.class)).toEqual(["skills"]);
    expect(result[0].declared).toBe("instruct");
    expect(result[0].verdict).toBe("instructed");
  });
});

// ---------------------------------------------------------------------------
// 4. assertNodeLaunchable — CONFIG vs EXECUTOR_UNAVAILABLE branch + message.
//    Tested against a NodeDef-shaped {id, type, settings} object (the shape
//    `assertNodeLaunchable` reads). See "Seam decisions" in the report.
// ---------------------------------------------------------------------------

type LaunchableNode = {
  id: string;
  type: "ai_coding" | "judge" | "cli" | "check" | "human" | "orchestrator";
  settings?: AiCodingSettings | JudgeSettings;
};

function aiNode(
  id: string,
  enforcement: Partial<Record<CapabilityClass, EnforcementMode>>,
): LaunchableNode {
  return {
    id,
    type: "ai_coding",
    settings: { enforcement } as AiCodingSettings,
  };
}

describe("assertNodeLaunchable — refusal → typed MaisterError", () => {
  it("strict on a class instructed-for-all-agents → throws MaisterError code=CONFIG (+ node id, class, agent in message)", () => {
    const node = aiNode("implement", { mcps: "strict" });

    let thrown: unknown;

    try {
      assertNodeLaunchable(node, "claude");
    } catch (err) {
      thrown = err;
    }

    expect(isMaisterError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe("CONFIG");
    const message = (thrown as Error).message;

    expect(message).toContain("implement");
    expect(message).toContain("mcps");
    expect(message).toContain("claude");
  });

  it("strict on a class enforced for claude-only, resolved agent codex → code=EXECUTOR_UNAVAILABLE", () => {
    // injectedTable: permissionMode is `enforced` for claude, `instructed` for
    // codex → SOME agent can enforce it, but the resolved agent (codex) cannot.
    const node = aiNode("judgeit", { permissionMode: "strict" });

    let thrown: unknown;

    try {
      assertNodeLaunchable(node, "codex", injectedTable);
    } catch (err) {
      thrown = err;
    }

    expect(isMaisterError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe("EXECUTOR_UNAVAILABLE");
    expect((thrown as Error).message).toContain("judgeit");
    expect((thrown as Error).message).toContain("permissionMode");
  });

  it("same injected table, resolved agent claude (enforced) → does NOT throw", () => {
    const node = aiNode("implement", { permissionMode: "strict" });

    expect(() =>
      assertNodeLaunchable(node, "claude", injectedTable),
    ).not.toThrow();
  });

  it("a node with no strict classes (all instruct/off) → does NOT throw", () => {
    const node = aiNode("implement", {
      mcps: "instruct",
      tools: "off",
      skills: "instruct",
    });

    expect(() => assertNodeLaunchable(node, "claude")).not.toThrow();
  });

  it("a settings-less ai_coding node → does NOT throw (back-compat)", () => {
    const node: LaunchableNode = { id: "bare", type: "ai_coding" };

    expect(() => assertNodeLaunchable(node, "claude")).not.toThrow();
  });

  it("applies to judge nodes too (capability-bearing shape) — strict mcps → CONFIG", () => {
    const node: LaunchableNode = {
      id: "verdict",
      type: "judge",
      settings: { enforcement: { mcps: "strict" } } as JudgeSettings,
    };

    let thrown: unknown;

    try {
      assertNodeLaunchable(node, "claude");
    } catch (err) {
      thrown = err;
    }

    expect(isMaisterError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe("CONFIG");
    expect((thrown as Error).message).toContain("verdict");
  });

  // M37 (ADR-098): orchestrator nodes inherit the ai_coding capability shape, so
  // they go through the same strict-enforcement refusal path.
  it("applies to orchestrator nodes too — strict mcps → CONFIG", () => {
    const node: LaunchableNode = {
      id: "coordinate",
      type: "orchestrator",
      settings: { enforcement: { mcps: "strict" } } as AiCodingSettings,
    };

    let thrown: unknown;

    try {
      assertNodeLaunchable(node, "claude");
    } catch (err) {
      thrown = err;
    }

    expect(isMaisterError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe("CONFIG");
    expect((thrown as Error).message).toContain("coordinate");
  });

  // M37 Phase 11 (ADR-099): path-scoped writes ship INSTRUCTED-only. The
  // `restrictions` class is no exception to the frozen table — a `strict`
  // restrictions declaration is refused at launch (CONFIG, no executor can
  // enforce it), while `restrictions: instruct` (or a plain data list, which
  // defaults to instruct) passes. No new refusal code is needed.
  it("restrictions: strict → CONFIG (path-scope ships instructed-only)", () => {
    const node = aiNode("tester", { restrictions: "strict" });

    let thrown: unknown;

    try {
      assertNodeLaunchable(node, "claude");
    } catch (err) {
      thrown = err;
    }

    expect(isMaisterError(thrown)).toBe(true);
    expect((thrown as { code: string }).code).toBe("CONFIG");
    expect((thrown as Error).message).toContain("tester");
    expect((thrown as Error).message).toContain("restrictions");
  });

  it("restrictions: instruct → does NOT throw (instructed)", () => {
    const node = aiNode("tester", { restrictions: "instruct" });

    expect(() => assertNodeLaunchable(node, "claude")).not.toThrow();
  });

  it("a plain restrictions data list (no enforcement entry) → instructed, does NOT throw", () => {
    const node: LaunchableNode = {
      id: "tester",
      type: "ai_coding",
      settings: { restrictions: ["tests-only"] } as AiCodingSettings,
    };

    expect(() => assertNodeLaunchable(node, "claude")).not.toThrow();
  });
});
