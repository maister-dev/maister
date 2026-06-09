import "server-only";

// The MaisterError class + taxonomy live in the client-safe `errors-core` so
// client bundles (the flow-graph editor reducers) can throw/branch on them
// without importing this server-only module. This re-export keeps the existing
// server-side `@/lib/errors` import surface and its server-only boundary intact.
export {
  MaisterError,
  isMaisterError,
  type MaisterErrorCode,
} from "@/lib/errors-core";
