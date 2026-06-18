import type { PlatformRunnerProvider } from "@/lib/db/schema";
import type {
  SupervisorDiagnostics,
  SupervisorDiagnosticsStatus,
} from "@/lib/supervisor-client";

import { describe, expect, it } from "vitest";

import {
  type AdapterId,
  type ProviderKind,
  PROVIDER_KINDS,
} from "@/lib/acp-runners/adapter-support";
import {
  summarizeAdapterReadiness,
  type RunnerReadinessRow,
} from "@/lib/acp-runners/readiness-summary";

type DiagAdapter = SupervisorDiagnostics["adapters"][number];

function diagAdapter(
  id: AdapterId,
  available: boolean,
  smokeStatus: DiagAdapter["smoke"]["status"] = "ok",
): DiagAdapter {
  return {
    id,
    binary: id,
    source: "path",
    path: null,
    available,
    version: null,
    error: null,
    smoke: {
      status: smokeStatus,
      reason: null,
      checkedAt: null,
      protocolVersion: null,
    },
  };
}

function readyDiag(adapters: DiagAdapter[]): SupervisorDiagnosticsStatus {
  return {
    kind: "ready",
    diagnostics: {
      status: "ready",
      version: "1.0.0",
      checkedAt: "2026-06-13T00:00:00.000Z",
      adapters,
      sidecars: [],
      envRefs: [],
    },
  };
}

function runner(
  adapter: AdapterId,
  enabled: boolean,
  readinessStatus: RunnerReadinessRow["readinessStatus"],
  readinessReasons: string[] | null = null,
  overrides: Partial<RunnerReadinessRow> = {},
): RunnerReadinessRow {
  return {
    id: `${adapter}-runner`,
    adapter,
    capabilityAgent: adapter,
    model: `${adapter}-model`,
    provider: { kind: "anthropic" },
    enabled,
    readinessStatus,
    readinessReasons,
    ...overrides,
  };
}

function findAdapter(
  result: ReturnType<typeof summarizeAdapterReadiness>,
  adapter: AdapterId,
) {
  const entry = result.find((item) => item.adapter === adapter);

  if (!entry) throw new Error(`no summary for ${adapter}`);

  return entry;
}

describe("summarizeAdapterReadiness", () => {
  it("returns one entry per supported adapter", () => {
    const result = summarizeAdapterReadiness({
      runners: [],
      diagnostics: null,
    });

    expect(result.map((item) => item.adapter)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
      "mimo",
    ]);
  });

  it("is green when the binary is available and an enabled runner is Ready", () => {
    const result = summarizeAdapterReadiness({
      runners: [runner("claude", true, "Ready")],
      diagnostics: readyDiag([diagAdapter("claude", true)]),
    });

    expect(findAdapter(result, "claude")).toMatchObject({
      state: "green",
      cause: "ready",
      detail: null,
    });
  });

  it("is amber 'no_runner' when available with no runners configured", () => {
    const result = summarizeAdapterReadiness({
      runners: [],
      diagnostics: readyDiag([diagAdapter("codex", true)]),
    });

    expect(findAdapter(result, "codex")).toMatchObject({
      state: "amber",
      cause: "no_runner",
    });
  });

  it("is amber 'all_disabled' when the only runner is disabled", () => {
    const result = summarizeAdapterReadiness({
      runners: [runner("gemini", false, "Ready")],
      diagnostics: readyDiag([diagAdapter("gemini", true)]),
    });

    expect(findAdapter(result, "gemini")).toMatchObject({
      state: "amber",
      cause: "all_disabled",
    });
  });

  it("is amber 'not_ready' and surfaces the first blocking reason", () => {
    const result = summarizeAdapterReadiness({
      runners: [
        runner("opencode", true, "NotReady", [
          "env ref is missing: OPENCODE_KEY",
        ]),
      ],
      diagnostics: readyDiag([diagAdapter("opencode", true)]),
    });

    expect(findAdapter(result, "opencode")).toMatchObject({
      state: "amber",
      cause: "not_ready",
      detail: "env ref is missing: OPENCODE_KEY",
    });
  });

  it("hides an adapter whose binary is unavailable even if a runner reads Ready", () => {
    const result = summarizeAdapterReadiness({
      runners: [runner("mimo", true, "Ready")],
      diagnostics: readyDiag([diagAdapter("mimo", false)]),
    });

    expect(findAdapter(result, "mimo")).toMatchObject({
      state: "hidden",
      cause: "binary_unavailable",
    });
  });

  it("hides an adapter missing from the diagnostics adapter list", () => {
    const result = summarizeAdapterReadiness({
      runners: [],
      diagnostics: readyDiag([diagAdapter("claude", true)]),
    });

    expect(findAdapter(result, "mimo").state).toBe("hidden");
  });

  describe("when supervisor diagnostics are unavailable", () => {
    const down: SupervisorDiagnosticsStatus = {
      kind: "unavailable",
      reason: "network",
      message: "supervisor down",
    };

    it("shows configured adapters as amber with the supervisor reason", () => {
      const result = summarizeAdapterReadiness({
        runners: [runner("claude", true, "Ready")],
        diagnostics: down,
      });

      expect(findAdapter(result, "claude")).toMatchObject({
        state: "amber",
        cause: "diagnostics_unavailable",
        detail: "network",
      });
    });

    it("hides adapters with no configured runner", () => {
      const result = summarizeAdapterReadiness({
        runners: [runner("claude", true, "Ready")],
        diagnostics: down,
      });

      expect(findAdapter(result, "codex").state).toBe("hidden");
    });

    it("treats a null diagnostics value like unavailable (no reason)", () => {
      const result = summarizeAdapterReadiness({
        runners: [runner("codex", true, "Ready")],
        diagnostics: null,
      });

      expect(findAdapter(result, "codex")).toMatchObject({
        state: "amber",
        cause: "diagnostics_unavailable",
        detail: null,
      });
    });
  });
});

// The exact, complete key set a RailRunnerDTO is allowed to carry to the client.
// Any other key (especially a secret-bearing provider ref) is a redaction leak.
const SAFE_RUNNER_DTO_KEYS = [
  "capabilityAgent",
  "enabled",
  "firstReason",
  "id",
  "model",
  "providerKind",
  "readinessStatus",
].sort();

const PROVIDER_SECRET_KEYS = [
  "provider",
  "authToken",
  "apiKey",
  "baseUrl",
  "projectId",
  "location",
  "wireApi",
] as const;

// Every secret-bearing provider variant, each paired with a supporting adapter
// and carrying `env:` secret refs in ALL of its secret fields. The redaction
// boundary must hold for the WHOLE union, not a sample — so the sweep below
// exercises each one, and the guard test fails if a new secret-bearing kind is
// added without an entry here.
const SECRET_BEARING_RUNNERS: ReadonlyArray<{
  readonly adapter: AdapterId;
  readonly provider: PlatformRunnerProvider;
}> = [
  {
    adapter: "claude",
    provider: {
      kind: "anthropic_compatible",
      baseUrl: "https://x",
      authToken: "env:TOK",
    },
  },
  {
    adapter: "codex",
    provider: {
      kind: "openai_compatible",
      baseUrl: "https://y",
      apiKey: "env:KEY",
      wireApi: "responses",
    },
  },
  {
    adapter: "gemini",
    provider: { kind: "google_gemini", apiKey: "env:GEM" },
  },
  {
    adapter: "gemini",
    provider: {
      kind: "google_vertex",
      projectId: "proj",
      location: "us-central1",
      apiKey: "env:K2",
    },
  },
  {
    adapter: "gemini",
    provider: {
      kind: "google_gateway",
      baseUrl: "https://z",
      apiKey: "env:GW",
    },
  },
];

// ProviderKinds with no secret fields (bare `{ kind }`). Anything outside this
// allowlist MUST appear in SECRET_BEARING_RUNNERS above.
const SECRET_FREE_PROVIDER_KINDS: readonly ProviderKind[] = [
  "anthropic",
  "openai",
  "agent_native",
];

describe("summarizeAdapterReadiness — safe runner DTO projection", () => {
  it("groups runners under their own adapter (no cross-adapter bleed)", () => {
    const result = summarizeAdapterReadiness({
      runners: [
        runner("claude", true, "Ready", null, { id: "claude-1" }),
        runner("gemini", true, "Ready", null, { id: "gemini-1" }),
      ],
      diagnostics: readyDiag([
        diagAdapter("claude", true),
        diagAdapter("gemini", true),
      ]),
    });

    const gemini = findAdapter(result, "gemini");
    const claude = findAdapter(result, "claude");

    expect(gemini.runners.map((dto) => dto.id)).toEqual(["gemini-1"]);
    expect(claude.runners.map((dto) => dto.id)).toEqual(["claude-1"]);
    expect(
      gemini.runners.every((dto) => dto.capabilityAgent === "gemini"),
    ).toBe(true);
  });

  it("redaction sweep covers every secret-bearing provider kind", () => {
    const covered = new Set<ProviderKind>(
      SECRET_BEARING_RUNNERS.map((entry) => entry.provider.kind),
    );
    const uncovered = PROVIDER_KINDS.filter(
      (kind) =>
        !SECRET_FREE_PROVIDER_KINDS.includes(kind) && !covered.has(kind),
    );

    expect(uncovered).toEqual([]);
  });

  it("projects only safe fields for every secret-bearing provider — never the secret refs", () => {
    const result = summarizeAdapterReadiness({
      runners: SECRET_BEARING_RUNNERS.map((entry, index) =>
        runner(entry.adapter, true, "Ready", null, {
          id: `secret-${index}`,
          provider: entry.provider,
        }),
      ),
      diagnostics: readyDiag([
        diagAdapter("claude", true),
        diagAdapter("codex", true),
        diagAdapter("gemini", true),
      ]),
    });

    const dtos = result.flatMap((adapter) => adapter.runners);

    expect(dtos).toHaveLength(SECRET_BEARING_RUNNERS.length);
    expect(new Set(dtos.map((dto) => dto.providerKind))).toEqual(
      new Set(SECRET_BEARING_RUNNERS.map((entry) => entry.provider.kind)),
    );

    for (const dto of dtos) {
      expect(Object.keys(dto).sort()).toEqual(SAFE_RUNNER_DTO_KEYS);

      for (const secret of PROVIDER_SECRET_KEYS) {
        expect(dto).not.toHaveProperty(secret);
      }

      expect(JSON.stringify(dto)).not.toContain("env:");
    }
  });

  it("DTO firstReason picks the first non-empty readiness reason", () => {
    const result = summarizeAdapterReadiness({
      runners: [
        runner("opencode", true, "NotReady", ["", "real reason"], {
          id: "oc-1",
        }),
      ],
      diagnostics: readyDiag([diagAdapter("opencode", true)]),
    });

    expect(findAdapter(result, "opencode").runners[0].firstReason).toBe(
      "real reason",
    );
  });

  it("returns runners: [] for an available adapter with no configured runner", () => {
    const result = summarizeAdapterReadiness({
      runners: [],
      diagnostics: readyDiag([diagAdapter("codex", true)]),
    });

    expect(findAdapter(result, "codex").runners).toEqual([]);
  });

  it("maps every configured runner of an adapter into the DTO list", () => {
    const result = summarizeAdapterReadiness({
      runners: [
        runner("claude", true, "Ready", null, { id: "c1" }),
        runner("claude", false, "Unknown", null, { id: "c2" }),
      ],
      diagnostics: readyDiag([diagAdapter("claude", true)]),
    });

    expect(findAdapter(result, "claude").runners.map((dto) => dto.id)).toEqual([
      "c1",
      "c2",
    ]);
  });
});
