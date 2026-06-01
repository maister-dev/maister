import type {
  AiCodingSettings,
  JudgeSettings,
  EnforcementMode,
} from "@/lib/config.schema";

import { describe, expect, it } from "vitest";

import {
  ENFORCEABILITY_BY_AGENT,
  evaluateNodeEnforcement,
  assertNodeLaunchable,
  type CapabilityClass,
} from "@/lib/flows/enforcement";
import { isMaisterError } from "@/lib/errors";

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
];

type Capability = "enforced" | "instructed" | "unsupported";
type Verdict = "enforced" | "instructed" | "refused";
type Table = Record<"claude" | "codex", Record<CapabilityClass, Capability>>;

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

describe("ENFORCEABILITY_BY_AGENT — FROZEN M11c table (all instructed)", () => {
  it("is value-for-value `instructed` for both agents × all 6 classes", () => {
    const expected: Table = {
      claude: {
        mcps: "instructed",
        tools: "instructed",
        skills: "instructed",
        restrictions: "instructed",
        permissionMode: "instructed",
        workspaceAccess: "instructed",
      },
      codex: {
        mcps: "instructed",
        tools: "instructed",
        skills: "instructed",
        restrictions: "instructed",
        permissionMode: "instructed",
        workspaceAccess: "instructed",
      },
    };

    expect(ENFORCEABILITY_BY_AGENT).toEqual(expected);
  });

  it("contains NO `enforced` cell (the M11c silent-escape-hatch invariant)", () => {
    for (const agent of ["claude", "codex"] as const) {
      for (const cls of ALL_CLASSES) {
        expect(ENFORCEABILITY_BY_AGENT[agent][cls]).not.toBe("enforced");
      }
    }
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
  },
  codex: {
    mcps: "instructed",
    tools: "instructed",
    skills: "instructed",
    restrictions: "instructed",
    permissionMode: "instructed",
    workspaceAccess: "instructed",
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
// 4. assertNodeLaunchable — CONFIG vs EXECUTOR_UNAVAILABLE branch + message.
//    Tested against a NodeDef-shaped {id, type, settings} object (the shape
//    `assertNodeLaunchable` reads). See "Seam decisions" in the report.
// ---------------------------------------------------------------------------

type LaunchableNode = {
  id: string;
  type: "ai_coding" | "judge" | "cli" | "check" | "human";
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
});
