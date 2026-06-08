export type AdapterId = "claude" | "codex";
export type ProviderKind =
  | "anthropic"
  | "anthropic_compatible"
  | "openai"
  | "openai_compatible";
export type PermissionPolicy = "default" | "dangerously_skip_permissions";

export interface RunnerDraft {
  id: string;
  adapter: AdapterId;
  model: string;
  providerKind: ProviderKind;
  baseUrl?: string;
  authToken?: string;
  apiKey?: string;
  wireApi?: boolean;
  permissionPolicy: PermissionPolicy;
  sidecarId?: string | null;
  enabled: boolean;
}

const ID_RE = /^[A-Za-z0-9._-]+$/;
const ENV_RE = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

export function providerKindsForAdapter(adapter: AdapterId): ProviderKind[] {
  return adapter === "claude"
    ? ["anthropic", "anthropic_compatible"]
    : ["openai", "openai_compatible"];
}

export function permissionPoliciesForAdapter(
  adapter: AdapterId,
): PermissionPolicy[] {
  return adapter === "claude"
    ? ["default", "dangerously_skip_permissions"]
    : ["default"];
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);

    return true;
  } catch {
    return false;
  }
}

export function validateRunnerDraft(draft: RunnerDraft): {
  ok: boolean;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};

  if (!ID_RE.test(draft.id)) errors.id = "id";
  if (draft.model.trim().length === 0) errors.model = "model";
  if (!providerKindsForAdapter(draft.adapter).includes(draft.providerKind)) {
    errors.providerKind = "providerKind";
  }
  if (
    !permissionPoliciesForAdapter(draft.adapter).includes(
      draft.permissionPolicy,
    )
  ) {
    errors.permissionPolicy = "permissionPolicy";
  }
  if (
    draft.providerKind === "anthropic_compatible" &&
    draft.authToken &&
    !ENV_RE.test(draft.authToken)
  ) {
    errors.authToken = "authToken";
  }
  if (
    draft.providerKind === "openai_compatible" &&
    draft.apiKey &&
    !ENV_RE.test(draft.apiKey)
  ) {
    errors.apiKey = "apiKey";
  }
  if (draft.baseUrl && !isValidUrl(draft.baseUrl)) {
    errors.baseUrl = "baseUrl";
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

function providerObject(draft: RunnerDraft): Record<string, unknown> {
  switch (draft.providerKind) {
    case "anthropic":
      return { kind: "anthropic" };
    case "anthropic_compatible":
      return {
        kind: "anthropic_compatible",
        ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
        ...(draft.authToken ? { authToken: draft.authToken } : {}),
      };
    case "openai":
      return { kind: "openai" };
    case "openai_compatible":
      return {
        kind: "openai_compatible",
        ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        ...(draft.wireApi ? { wireApi: "responses" } : {}),
      };
  }
}

export function buildCreateBody(draft: RunnerDraft): Record<string, unknown> {
  return {
    id: draft.id,
    adapter: draft.adapter,
    model: draft.model,
    provider: providerObject(draft),
    permissionPolicy: draft.permissionPolicy,
    sidecarId: draft.sidecarId ?? null,
    enabled: draft.enabled,
  };
}

export function buildPatchBody(
  draft: RunnerDraft,
  original: RunnerDraft,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (draft.model !== original.model) body.model = draft.model;

  const draftProvider = providerObject(draft);

  if (
    JSON.stringify(draftProvider) !== JSON.stringify(providerObject(original))
  ) {
    body.provider = draftProvider;
  }
  if (draft.permissionPolicy !== original.permissionPolicy) {
    body.permissionPolicy = draft.permissionPolicy;
  }
  if ((draft.sidecarId ?? null) !== (original.sidecarId ?? null)) {
    body.sidecarId = draft.sidecarId ?? null;
  }
  if (draft.enabled !== original.enabled) body.enabled = draft.enabled;

  return body;
}
