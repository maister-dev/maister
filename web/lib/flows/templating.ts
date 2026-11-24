import "server-only";

import type { Logger } from "pino";

import pino from "pino";

import {
  FlowTemplateRenderError,
  renderStrict as renderFlowTemplate,
} from "../../../runtime/flow-template-render";

import { MaisterError } from "@/lib/errors";

const log = pino({
  name: "flow-templating",
  level: process.env.LOG_LEVEL ?? "info",
});

export type RenderOptions = { traceLog?: Logger };

export function renderStrict(
  template: string,
  context: Record<string, unknown>,
  opts: RenderOptions = {},
): string {
  try {
    return renderFlowTemplate(template, context, { ...opts, logger: log });
  } catch (error) {
    if (!(error instanceof FlowTemplateRenderError)) throw error;
    throw new MaisterError("CONFIG", error.message, {
      cause: error.cause instanceof Error ? error.cause : undefined,
    });
  }
}
