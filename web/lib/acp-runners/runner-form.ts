import {
  permissionPoliciesForAdapter as adapterPermissionPoliciesForAdapter,
  providerKindsForAdapter as adapterProviderKindsForAdapter,
  type AdapterId,
  type PermissionPolicy,
  type ProviderKind,
} from "@/lib/acp-runners/adapter-support";

export type { AdapterId, PermissionPolicy, ProviderKind };

export interface RunnerDraft {
  id: string;
  adapter: AdapterId;
  model: string;
  env?: Record<string, string>;
  providerKind: ProviderKind;
  baseUrl?: string;
  authToken?: string;
  apiKey?: string;
  projectId?: string;
  location?: string;
  wireApi?: boolean;
  permissionPolicy: PermissionPolicy;
  sidecarId?: string | null;
  enabled: boolean;
}

const ID_RE = /^[A-Za-z0-9._-]+$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_RE = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

function validRunnerEnvValue(value: string): boolean {
  if (value.includes("\0")) return false;

  return !value.startsWith("env:") || ENV_RE.test(value);
}

export function providerKindsForAdapter(adapter: AdapterId): ProviderKind[] {
  return [...adapterProviderKindsForAdapter(adapter)];
}

export function permissionPoliciesForAdapter(
  adapter: AdapterId,
): PermissionPolicy[] {
  return [...adapterPermissionPoliciesForAdapter(adapter)];
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
  if (
    Object.entries(draft.env ?? {}).some(
      ([key, value]) => !ENV_NAME_RE.test(key) || !validRunnerEnvValue(value),
    )
  ) {
    errors.env = "env";
  }
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
  if (
    (draft.providerKind === "google_gemini" ||
      draft.providerKind === "google_vertex" ||
      draft.providerKind === "google_gateway") &&
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

function nonEmptyEnv(
  env: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!env || Object.keys(env).length === 0) return undefined;

  return env;
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
    case "google_gemini":
      return {
        kind: "google_gemini",
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      };
    case "google_vertex":
      return {
        kind: "google_vertex",
        ...(draft.projectId ? { projectId: draft.projectId } : {}),
        ...(draft.location ? { location: draft.location } : {}),
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      };
    case "google_gateway":
      return {
        kind: "google_gateway",
        ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      };
    case "agent_native":
      return { kind: "agent_native" };
  }
}

export function buildCreateBody(draft: RunnerDraft): Record<string, unknown> {
  return {
    id: draft.id,
    adapter: draft.adapter,
    model: draft.model,
    ...(nonEmptyEnv(draft.env) ? { env: draft.env } : {}),
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
  if (JSON.stringify(draft.env ?? {}) !== JSON.stringify(original.env ?? {})) {
    body.env = draft.env ?? {};
  }

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
