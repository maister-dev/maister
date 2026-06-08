import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// CONTRACT under test — the NOT-YET-EXISTING pure form module that backs the
// admin ACP-runner create/edit modal (`components/settings/acp-runner-modal.tsx`).
//
// `@/lib/acp-runners/runner-form` must be a pure (no DB, no server-only) module
// so the modal can validate drafts client-side and build the POST/PATCH bodies
// the route handlers already accept. This test is RED until the module exists.
//
// Pinned API:
//   type AdapterId = "claude" | "codex";
//   type ProviderKind =
//     | "anthropic" | "anthropic_compatible" | "openai" | "openai_compatible";
//   type PermissionPolicy = "default" | "dangerously_skip_permissions";
//   interface RunnerDraft {
//     id: string; adapter: AdapterId; model: string;
//     providerKind: ProviderKind; baseUrl?: string;
//     authToken?: string; apiKey?: string; wireApi?: boolean;
//     permissionPolicy: PermissionPolicy; sidecarId?: string | null;
//     enabled: boolean;
//   }
//   providerKindsForAdapter(adapter): ProviderKind[]
//   permissionPoliciesForAdapter(adapter): PermissionPolicy[]
//   validateRunnerDraft(draft): { ok: boolean; errors: Record<string, string> }
//   buildCreateBody(draft): object
//   buildPatchBody(draft, original: RunnerDraft): object
// ---------------------------------------------------------------------------

import {
  buildCreateBody,
  buildPatchBody,
  permissionPoliciesForAdapter,
  providerKindsForAdapter,
  validateRunnerDraft,
  type RunnerDraft,
} from "@/lib/acp-runners/runner-form";

function validClaudeDraft(overrides: Partial<RunnerDraft> = {}): RunnerDraft {
  return {
    id: "r",
    adapter: "claude",
    model: "m",
    providerKind: "anthropic",
    permissionPolicy: "default",
    sidecarId: null,
    enabled: true,
    ...overrides,
  };
}

describe("providerKindsForAdapter", () => {
  it("returns the Anthropic provider kinds for claude", () => {
    expect(providerKindsForAdapter("claude")).toEqual([
      "anthropic",
      "anthropic_compatible",
    ]);
  });

  it("returns the OpenAI provider kinds for codex", () => {
    expect(providerKindsForAdapter("codex")).toEqual([
      "openai",
      "openai_compatible",
    ]);
  });
});

describe("permissionPoliciesForAdapter", () => {
  it("allows both permission policies for claude", () => {
    expect(permissionPoliciesForAdapter("claude")).toEqual([
      "default",
      "dangerously_skip_permissions",
    ]);
  });

  it("allows only the default permission policy for codex", () => {
    expect(permissionPoliciesForAdapter("codex")).toEqual(["default"]);
  });
});

describe("validateRunnerDraft", () => {
  it("accepts a valid claude/anthropic draft", () => {
    expect(validateRunnerDraft(validClaudeDraft())).toEqual({
      ok: true,
      errors: {},
    });
  });

  it("rejects an unsafe id", () => {
    const result = validateRunnerDraft(validClaudeDraft({ id: "bad id!" }));

    expect(result.ok).toBe(false);
    expect(result.errors.id).toBeTruthy();
  });

  it("rejects an empty model", () => {
    const result = validateRunnerDraft(validClaudeDraft({ model: "" }));

    expect(result.ok).toBe(false);
    expect(result.errors.model).toBeTruthy();
  });

  it("rejects a raw authToken for anthropic_compatible", () => {
    const result = validateRunnerDraft(
      validClaudeDraft({
        providerKind: "anthropic_compatible",
        authToken: "raw",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.authToken).toBeTruthy();
  });

  it("accepts an env-ref authToken for anthropic_compatible", () => {
    const result = validateRunnerDraft(
      validClaudeDraft({
        providerKind: "anthropic_compatible",
        authToken: "env:ZAI_API_KEY",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.errors.authToken).toBeUndefined();
  });

  it("rejects a malformed baseUrl", () => {
    const result = validateRunnerDraft(
      validClaudeDraft({
        providerKind: "anthropic_compatible",
        baseUrl: "notaurl",
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.baseUrl).toBeTruthy();
  });

  it("rejects dangerously_skip_permissions for codex", () => {
    const result = validateRunnerDraft({
      id: "c",
      adapter: "codex",
      model: "m",
      providerKind: "openai",
      permissionPolicy: "dangerously_skip_permissions",
      sidecarId: null,
      enabled: true,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.permissionPolicy).toBeTruthy();
  });

  it("rejects an anthropic provider for codex", () => {
    const result = validateRunnerDraft({
      id: "c",
      adapter: "codex",
      model: "m",
      providerKind: "anthropic",
      permissionPolicy: "default",
      sidecarId: null,
      enabled: true,
    });

    expect(result.ok).toBe(false);
    expect(result.errors.providerKind).toBeTruthy();
  });
});

describe("buildCreateBody", () => {
  it("emits the nested anthropic_compatible provider body", () => {
    const body = buildCreateBody({
      id: "r",
      adapter: "claude",
      model: "m",
      providerKind: "anthropic_compatible",
      baseUrl: "https://x.y",
      authToken: "env:K",
      permissionPolicy: "default",
      sidecarId: null,
      enabled: true,
    });

    expect(body).toEqual({
      id: "r",
      adapter: "claude",
      model: "m",
      provider: {
        kind: "anthropic_compatible",
        baseUrl: "https://x.y",
        authToken: "env:K",
      },
      permissionPolicy: "default",
      sidecarId: null,
      enabled: true,
    });
  });

  it("emits a bare anthropic provider with no baseUrl/authToken", () => {
    const body = buildCreateBody(validClaudeDraft()) as {
      provider: unknown;
    };

    expect(body.provider).toEqual({ kind: "anthropic" });
  });

  it("maps wireApi:true to the responses literal for openai_compatible", () => {
    const body = buildCreateBody({
      id: "c",
      adapter: "codex",
      model: "m",
      providerKind: "openai_compatible",
      baseUrl: "https://x.y",
      apiKey: "env:K",
      wireApi: true,
      permissionPolicy: "default",
      sidecarId: null,
      enabled: true,
    }) as { provider: { wireApi?: string } };

    expect(body.provider.wireApi).toBe("responses");
  });
});

describe("buildPatchBody", () => {
  it("includes only the changed model field", () => {
    const original = validClaudeDraft();
    const draft = validClaudeDraft({ model: "newm" });

    expect(buildPatchBody(draft, original)).toEqual({ model: "newm" });
  });

  it("returns an empty body when nothing changed", () => {
    const original = validClaudeDraft();

    expect(buildPatchBody(validClaudeDraft(), original)).toEqual({});
  });
});
