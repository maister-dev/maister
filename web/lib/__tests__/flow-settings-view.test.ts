import type { AiCodingSettings, JudgeSettings } from "@/lib/config.schema";
import type { EnforcementSnapshotEntry } from "@/lib/db/schema";

import { describe, expect, it } from "vitest";

import { buildSettingsView } from "@/lib/flows/settings-view";

// ---------------------------------------------------------------------------
// CONTRACT under test — `web/lib/flows/settings-view.ts` (M11c Phase 4.1).
//
// The pure view-model that BOTH the run-detail query (lib/queries/run.ts) and
// the server panel (components/board/panels/flow-settings-panel.tsx) consume,
// so the panel stays pure-render. It maps the run's pinned-manifest nodes +
// the resolved agent (+ an optional persisted enforcement_snapshot keyed by
// nodeId for refused/launched runs) into per-node capability-class verdicts via
// `evaluateNodeEnforcement` (web/lib/flows/enforcement.ts).
//
//   export interface SettingsClassView {
//     class: EnforcementSnapshotEntry["class"];   // "mcps" | ... | "workspaceAccess"
//     verdict: EnforcementSnapshotEntry["verdict"]; // "enforced" | "instructed" | "refused"
//   }
//   export interface SettingsNodeView {
//     nodeId: string;
//     nodeType: "ai_coding" | "judge";   // only capability-bearing types appear
//     classes: SettingsClassView[];      // [] when the node declares nothing
//   }
//   export interface SettingsViewNode {
//     id: string;
//     type: string;                       // manifest node `type`
//     settings?: AiCodingSettings | JudgeSettings | unknown;
//   }
//   export function buildSettingsView(
//     nodes: SettingsViewNode[],
//     agent: "claude" | "codex",
//     snapshotByNode?: Record<string, EnforcementSnapshotEntry[]>,
//   ): SettingsNodeView[];
//
// Decisions documented inline:
//  - cli/check/human nodes are EXCLUDED from the view entirely (no capability
//    classes exist for them).
//  - an ai_coding/judge node with no settings is PRESENT with classes: []  —
//    so the panel can still show "no constrained capabilities" for it.
//  - when `snapshotByNode[nodeId]` is provided, the view uses the RECORDED
//    verdicts (the launch/first-attempt audit), NOT a re-evaluation — a run
//    refused at launch still shows `refused` though the node never executed.
// ---------------------------------------------------------------------------

// Mirror of the implementor's expected element shape; declared locally so the
// callbacks stay strict-typed while `@/lib/flows/settings-view` is missing (RED).
type ClassView = {
  class: EnforcementSnapshotEntry["class"];
  verdict: EnforcementSnapshotEntry["verdict"];
};
type NodeView = {
  nodeId: string;
  nodeType: "ai_coding" | "judge";
  classes: ClassView[];
};

type ViewNode = {
  id: string;
  type: "ai_coding" | "judge" | "cli" | "check" | "human";
  settings?: AiCodingSettings | JudgeSettings;
};

function aiNode(id: string, settings: AiCodingSettings): ViewNode {
  return { id, type: "ai_coding", settings };
}

function find(view: NodeView[], nodeId: string): NodeView | undefined {
  return view.find((n) => n.nodeId === nodeId);
}

function classOf(
  node: NodeView,
  cls: ClassView["class"],
): ClassView | undefined {
  return node.classes.find((c) => c.class === cls);
}

// ---------------------------------------------------------------------------
// 1. All-`instruct` ai_coding node → every declared class verdict `instructed`.
// ---------------------------------------------------------------------------

describe("buildSettingsView — all-instruct ai_coding node", () => {
  it("tags every declared class `instructed`, none `refused`", () => {
    const node = aiNode("implement", {
      enforcement: {
        mcps: "instruct",
        tools: "instruct",
        skills: "instruct",
        restrictions: "instruct",
        permissionMode: "instruct",
        workspaceAccess: "instruct",
      },
    } as AiCodingSettings);

    const view = buildSettingsView([node], "claude") as NodeView[];
    const v = find(view, "implement");

    expect(v).toBeDefined();
    expect(v!.nodeType).toBe("ai_coding");
    expect(v!.classes.length).toBe(6);
    for (const c of v!.classes) {
      expect(c.verdict).toBe("instructed");
    }
    expect(v!.classes.some((c) => c.verdict === "refused")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hooks capability class (M40, ADR-104) — the 7th class. Declared by the data
// field `settings.hooks` (→ instructed) or by an explicit `enforcement.hooks`.
// ---------------------------------------------------------------------------

describe("buildSettingsView — hooks capability class (M40)", () => {
  it("a node declaring settings.hooks tags the `hooks` class instructed", () => {
    const node = aiNode("guarded", {
      hooks: { repetition: { max: 5 } },
    } as AiCodingSettings);

    const view = buildSettingsView([node], "claude") as NodeView[];

    expect(classOf(find(view, "guarded")!, "hooks")).toEqual({
      class: "hooks",
      verdict: "instructed",
    });
  });

  it("enforcement.hooks: strict → refused (the frozen table cannot enforce it)", () => {
    const node = aiNode("guarded", {
      enforcement: { hooks: "strict" },
    } as AiCodingSettings);

    const view = buildSettingsView([node], "claude") as NodeView[];

    expect(classOf(find(view, "guarded")!, "hooks")?.verdict).toBe("refused");
  });

  it("enforcement.hooks: off omits the hooks class", () => {
    const node = aiNode("guarded", {
      hooks: { repetition: { max: 5 } },
      enforcement: { hooks: "off" },
    } as AiCodingSettings);

    const view = buildSettingsView([node], "claude") as NodeView[];

    expect(classOf(find(view, "guarded")!, "hooks")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. strict mcps against the real all-instructed table → `mcps` refused.
// ---------------------------------------------------------------------------

describe("buildSettingsView — strict class against all-instructed table", () => {
  it("marks `mcps` verdict `refused` (declared strict, capability instructed)", () => {
    const node = aiNode("implement", {
      enforcement: { mcps: "strict" },
    } as AiCodingSettings);

    const view = buildSettingsView([node], "claude") as NodeView[];
    const v = find(view, "implement");

    expect(v).toBeDefined();
    const mcps = classOf(v!, "mcps");

    expect(mcps).toBeDefined();
    expect(mcps!.verdict).toBe("refused");
  });
});

// ---------------------------------------------------------------------------
// 3. cli/check/human nodes are excluded from the view.
// ---------------------------------------------------------------------------

describe("buildSettingsView — non-capability nodes excluded", () => {
  it("omits cli, check, and human nodes entirely", () => {
    const nodes: ViewNode[] = [
      { id: "lint", type: "cli" },
      { id: "tests", type: "check" },
      { id: "review", type: "human" },
      aiNode("implement", {
        enforcement: { mcps: "instruct" },
      } as AiCodingSettings),
    ];

    const view = buildSettingsView(nodes, "claude") as NodeView[];

    expect(view.map((n) => n.nodeId)).toEqual(["implement"]);
    expect(find(view, "lint")).toBeUndefined();
    expect(find(view, "tests")).toBeUndefined();
    expect(find(view, "review")).toBeUndefined();
  });

  it("includes judge nodes (capability-bearing)", () => {
    const nodes: ViewNode[] = [
      {
        id: "verdict",
        type: "judge",
        settings: { enforcement: { tools: "strict" } } as JudgeSettings,
      },
    ];

    const view = buildSettingsView(nodes, "claude") as NodeView[];
    const v = find(view, "verdict");

    expect(v).toBeDefined();
    expect(v!.nodeType).toBe("judge");
    expect(classOf(v!, "tools")?.verdict).toBe("refused");
  });
});

// ---------------------------------------------------------------------------
// 4. Settings-less ai_coding/judge node → present with empty classes.
//    (Decision: present-with-[] so the panel can render "no constrained
//    capabilities", rather than dropping the node.)
// ---------------------------------------------------------------------------

describe("buildSettingsView — settings-less capability node", () => {
  it("keeps an ai_coding node with no settings, classes: []", () => {
    const nodes: ViewNode[] = [{ id: "bare", type: "ai_coding" }];

    const view = buildSettingsView(nodes, "claude") as NodeView[];
    const v = find(view, "bare");

    expect(v).toBeDefined();
    expect(v!.nodeType).toBe("ai_coding");
    expect(v!.classes).toEqual([]);
  });

  it("a node that declares only `off` classes → present with classes: []", () => {
    const node = aiNode("implement", {
      enforcement: { mcps: "off", tools: "off" },
    } as AiCodingSettings);

    const view = buildSettingsView([node], "claude") as NodeView[];
    const v = find(view, "implement");

    expect(v).toBeDefined();
    expect(v!.classes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Persisted enforcement_snapshot wins over re-evaluation.
//    A run refused at launch carries the recorded verdicts even though the
//    settings (if re-evaluated) would resolve the same — the view must reflect
//    the SNAPSHOT, proving it threads the audit record for executed/refused runs.
//
//    Decision documented: `snapshotByNode` is keyed by nodeId and holds the
//    EnforcementSnapshotEntry[] persisted in node_attempts.enforcement_snapshot.
//    When present for a node, buildSettingsView projects {class, verdict} from
//    those entries (the recorded truth) instead of calling the evaluator.
// ---------------------------------------------------------------------------

describe("buildSettingsView — persisted snapshot reflects recorded verdicts", () => {
  it("uses the snapshot's recorded `refused` verdict for a refused-at-launch run", () => {
    // The node's live settings declare mcps strict (would evaluate to refused),
    // but we assert the SNAPSHOT is the source — make the snapshot carry a
    // verdict the evaluator could not produce from settings alone to prove it.
    const node = aiNode("implement", {
      enforcement: { tools: "instruct" },
    } as AiCodingSettings);

    const snapshotByNode: Record<string, EnforcementSnapshotEntry[]> = {
      implement: [
        {
          class: "mcps",
          declared: "strict",
          capability: "instructed",
          verdict: "refused",
        },
        {
          class: "tools",
          declared: "instruct",
          capability: "instructed",
          verdict: "instructed",
        },
      ],
    };

    const view = buildSettingsView(
      [node],
      "claude",
      snapshotByNode,
    ) as NodeView[];
    const v = find(view, "implement");

    expect(v).toBeDefined();
    // Snapshot drove the classes — mcps:refused is present even though the live
    // settings only declare tools:instruct.
    expect(classOf(v!, "mcps")?.verdict).toBe("refused");
    expect(classOf(v!, "tools")?.verdict).toBe("instructed");
  });

  it("falls back to live evaluation for nodes absent from the snapshot map", () => {
    const node = aiNode("implement", {
      enforcement: { skills: "strict" },
    } as AiCodingSettings);

    const view = buildSettingsView([node], "claude", {}) as NodeView[];
    const v = find(view, "implement");

    expect(v).toBeDefined();
    expect(classOf(v!, "skills")?.verdict).toBe("refused");
  });
});

// ---------------------------------------------------------------------------
// 6. SECRET-LEAK GUARD (skill: server-only-secrets).
//    The view is built from settings + an executor object carrying env secrets.
//    The settings schema carries NO secret fields, and the view must NOT carry
//    executor env at all. Serialize the produced view and assert it contains no
//    token/key/secret substring (case-insensitive).
// ---------------------------------------------------------------------------

describe("buildSettingsView — no secret leakage into the view-model", () => {
  it("serialized view matches NEITHER /token/i NOR /key/i NOR /secret/i", () => {
    // Executor carrying env secrets — the panel/query has access to this object
    // server-side but the view-model must never absorb it.
    const executorEnv = {
      ANTHROPIC_AUTH_TOKEN: "sk-secret-abcdef",
      API_KEY: "xyz-keymaterial",
      MY_SECRET: "do-not-leak",
    };

    void executorEnv; // present to mirror the real call-site; never passed into the view.

    const node = aiNode("implement", {
      mcps: ["github"],
      enforcement: { mcps: "strict", tools: "instruct" },
    } as AiCodingSettings);

    const view = buildSettingsView([node], "claude") as NodeView[];
    const serialized = JSON.stringify(view);

    expect(serialized).not.toMatch(/token/i);
    expect(serialized).not.toMatch(/key/i);
    expect(serialized).not.toMatch(/secret/i);

    // And the secret values themselves are absent.
    expect(serialized).not.toContain("sk-secret-abcdef");
    expect(serialized).not.toContain("xyz-keymaterial");
    expect(serialized).not.toContain("do-not-leak");
  });
});
