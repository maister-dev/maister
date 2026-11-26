import "server-only";

import type { Provider } from "@/lib/repo-source";

import pino from "pino";

import {
  selectPrAdapter as selectProviderAdapter,
  type PrAdapter,
  type PrAdapterContext,
} from "../../../runtime/pull-request";
import { getPrState as readProviderPullRequest } from "../../../runtime/pull-request-state";

export type { PrStateReadResult } from "../../../runtime/pull-request-state";
export {
  EXEC_TIMEOUT_MS,
  GhCliAdapter,
  GlabCliAdapter,
  GiteaApiAdapter,
  parseGiteaRemote,
  type CreateOrUpdatePrArgs,
  type PrAdapter,
  type PrAdapterContext,
  type PrResult,
} from "../../../runtime/pull-request";

const log = pino({
  name: "pr-adapter",
  level: process.env.LOG_LEVEL ?? "info",
});

export function selectPrAdapter(
  provider: Provider,
  ctx: PrAdapterContext,
): PrAdapter {
  return selectProviderAdapter(provider, { ...ctx, logger: log });
}

export function getPrState(args: Parameters<typeof readProviderPullRequest>[0]) {
  return readProviderPullRequest(args, log);
}
