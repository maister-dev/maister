import type { NewSessionRequest } from "@agentclientprotocol/sdk/unstable";

/** Only explicit model pins override Claude's native environment/settings defaults. */
export function claudeModelOptions(model: string | undefined): {
  readonly model?: string;
} {
  const value = model?.trim();

  return value && value !== "default" ? { model: value } : {};
}

/** Native safe-tool shortcuts must still reach the platform permission seam. */
export function claudeToolArbitrationOptions(): {
  readonly allowDangerouslySkipPermissions: false;
  readonly settings: { readonly permissions: { readonly ask: string[] } };
} {
  return {
    allowDangerouslySkipPermissions: false,
    settings: { permissions: { ask: ["*"] } },
  };
}
export function claudeToolArbitrationMeta(): NewSessionRequest["_meta"] {
  return { claudeCode: { options: claudeToolArbitrationOptions() } };
}
