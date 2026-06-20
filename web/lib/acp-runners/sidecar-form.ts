export interface SidecarDraft {
  id: string;
  lifecycle: "managed" | "external";
  configPath?: string;
  baseUrl?: string;
  healthcheckUrl?: string;
  authTokenRef?: string;
  enabled: boolean;
}

const ID_RE = /^[A-Za-z0-9._-]+$/;
const ENV_RE = /^env:[A-Za-z_][A-Za-z0-9_]*$/;

export function emptySidecarDraft(): SidecarDraft {
  return { id: "", lifecycle: "managed", enabled: true };
}

function isValidUrl(value: string): boolean {
  try {
    new URL(value);

    return true;
  } catch {
    return false;
  }
}

export function validateSidecarDraft(draft: SidecarDraft): {
  ok: boolean;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};

  if (!ID_RE.test(draft.id)) errors.id = "id";
  if (draft.baseUrl && !isValidUrl(draft.baseUrl)) errors.baseUrl = "baseUrl";
  if (draft.healthcheckUrl && !isValidUrl(draft.healthcheckUrl)) {
    errors.healthcheckUrl = "healthcheckUrl";
  }
  if (draft.authTokenRef && !ENV_RE.test(draft.authTokenRef)) {
    errors.authTokenRef = "authTokenRef";
  }
  // The supervisor reads configPath from disk after ~ expansion; reject any ".."
  // here too, mirroring sidecarConfigPathSchema on the create/update routes.
  if (draft.configPath && draft.configPath.includes("..")) {
    errors.configPath = "configPath";
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

function commandPresetFor(
  lifecycle: SidecarDraft["lifecycle"],
): "ccr_start" | null {
  return lifecycle === "managed" ? "ccr_start" : null;
}

export function buildCreateBody(draft: SidecarDraft): Record<string, unknown> {
  return {
    id: draft.id,
    kind: "ccr",
    lifecycle: draft.lifecycle,
    commandPreset: commandPresetFor(draft.lifecycle),
    configPath: draft.configPath || null,
    baseUrl: draft.baseUrl || null,
    healthcheckUrl: draft.healthcheckUrl || null,
    authTokenRef: draft.authTokenRef || null,
    enabled: draft.enabled,
  };
}

export function buildPatchBody(
  draft: SidecarDraft,
  original: SidecarDraft,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (draft.lifecycle !== original.lifecycle) {
    body.lifecycle = draft.lifecycle;
    body.commandPreset = commandPresetFor(draft.lifecycle);
  }
  if ((draft.configPath || null) !== (original.configPath || null)) {
    body.configPath = draft.configPath || null;
  }
  if ((draft.baseUrl || null) !== (original.baseUrl || null)) {
    body.baseUrl = draft.baseUrl || null;
  }
  if ((draft.healthcheckUrl || null) !== (original.healthcheckUrl || null)) {
    body.healthcheckUrl = draft.healthcheckUrl || null;
  }
  if ((draft.authTokenRef || null) !== (original.authTokenRef || null)) {
    body.authTokenRef = draft.authTokenRef || null;
  }
  // Only emit enabled when it actually changed — a config-only edit must never
  // send enabled:false and trip the PATCH disable usage-guard.
  if (draft.enabled !== original.enabled) body.enabled = draft.enabled;

  return body;
}
