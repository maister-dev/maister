import type { SafeErrorCause } from "./safe-error-cause";

export type SessionCreateFailure = Readonly<{
  version: 1;
  stage: "spawn" | "acp_handshake";
  causeChain: readonly SafeErrorCause[];
}>;
