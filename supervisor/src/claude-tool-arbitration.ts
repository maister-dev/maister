import type { NewSessionRequest } from "@agentclientprotocol/sdk/unstable";

/** Native safe-tool shortcuts must still reach the platform permission seam. */
export function claudeToolArbitrationMeta(): NewSessionRequest["_meta"] {
  return {
    claudeCode: {
      options: {
        allowDangerouslySkipPermissions: false,
        settings: { permissions: { ask: ["*"] } },
      },
    },
  };
}
