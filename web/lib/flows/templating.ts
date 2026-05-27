import "server-only";

import Mustache from "mustache";
import pino, { type Logger } from "pino";

import { MaisterError } from "@/lib/errors";

Mustache.escape = (s) => String(s);

const log = pino({
  name: "flow-templating",
  level: process.env.LOG_LEVEL ?? "info",
});

const MAX_TRACE_VALUE_LEN = 200;

function previewValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length <= MAX_TRACE_VALUE_LEN) return value;

  return `${value.slice(0, MAX_TRACE_VALUE_LEN)}…`;
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) !== null &&
    !(v instanceof Date) &&
    !(v instanceof RegExp)
  );
}

type WrapOpts = {
  parentPath: string;
  traceLog?: Logger;
};

function wrap(target: Record<string, unknown>, opts: WrapOpts): unknown {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === "symbol") {
        return Reflect.get(obj, prop, receiver);
      }
      if (prop === "toString" || prop === "toJSON") {
        return Reflect.get(obj, prop, receiver);
      }

      const path = opts.parentPath
        ? `${opts.parentPath}.${prop}`
        : (prop as string);

      if (!(prop in obj)) {
        throw new MaisterError("CONFIG", `undefined template var: ${path}`);
      }

      const value = obj[prop as string];

      if (value === undefined) {
        throw new MaisterError("CONFIG", `undefined template var: ${path}`);
      }

      if (opts.traceLog) {
        opts.traceLog.debug({ path, value: previewValue(value) }, "resolved");
      }

      if (isPlainRecord(value)) {
        return wrap(value, { parentPath: path, traceLog: opts.traceLog });
      }

      if (Array.isArray(value)) {
        return value;
      }

      return value;
    },
    has(obj, prop) {
      return prop in obj;
    },
  });
}

export type RenderOptions = {
  traceLog?: Logger;
};

export function renderStrict(
  template: string,
  context: Record<string, unknown>,
  opts: RenderOptions = {},
): string {
  if (template === "") return "";

  log.debug({ len: template.length }, "render start");

  const view = wrap(context, {
    parentPath: "",
    traceLog: opts.traceLog,
  });

  try {
    return Mustache.render(template, view);
  } catch (err) {
    if (err instanceof MaisterError) throw err;
    const msg = err instanceof Error ? err.message : String(err);

    throw new MaisterError("CONFIG", `mustache render failed: ${msg}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }
}
