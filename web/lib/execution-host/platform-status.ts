import "server-only";

import { cache } from "react";

import { executionHosts } from "./client";

// ADR-166 T4.6: the chrome's host status, React-cached per request so every
// server component of one render reads the same answer (was the wire module's
// `getPlatformStatus`). Both read the local host's admin surface.
export const getPlatformStatus = cache(() =>
  executionHosts.local().platformStatus(),
);

export const getPlatformDiagnostics = cache(() =>
  executionHosts.local().diagnostics(),
);
