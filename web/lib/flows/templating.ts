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

type DefaultExpression = {
  path: string;
  literal: string;
};

type DefaultResolution = {
  placeholder: string;
  value: string;
};

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

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findMustacheClose(template: string, start: number): number {
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = start + 2; index < template.length - 1; index += 1) {
    const char = template[index];

    if (quote !== null) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "}" && template[index + 1] === "}") {
      return index;
    }
  }

  return -1;
}

function readQuotedLiteral(input: string): { literal: string; end: number } | null {
  const quote = input[0];

  if (quote !== "'" && quote !== '"') return null;

  let literal = "";
  let escaped = false;

  for (let index = 1; index < input.length; index += 1) {
    const char = input[index];

    if (escaped) {
      if (char === "n") literal += "\n";
      else if (char === "r") literal += "\r";
      else if (char === "t") literal += "\t";
      else literal += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === quote) {
      return { literal, end: index + 1 };
    }

    literal += char;
  }

  return null;
}

function parseDefaultExpression(tag: string): DefaultExpression | null {
  const match = tag.match(
    /^([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\?\?\s*/,
  );

  if (!match) return null;

  const literalInput = tag.slice(match[0].length);
  const parsed = readQuotedLiteral(literalInput);

  if (!parsed) return null;

  if (literalInput.slice(parsed.end).trim() !== "") return null;

  return {
    path: match[1],
    literal: parsed.literal,
  };
}

function resolvePath(
  context: Record<string, unknown>,
  path: string,
): { found: true; value: unknown } | { found: false } {
  const parts = path.split(".");
  let current: unknown = context;

  for (const part of parts) {
    if (!isObjectLike(current) || !(part in current)) {
      return { found: false };
    }

    const value = current[part];

    if (value === undefined) {
      return { found: false };
    }

    current = value;
  }

  return { found: true, value: current };
}

function renderScalar(value: unknown): string {
  if (value === null || value === undefined) return "";

  return String(value);
}

function makePlaceholder(template: string, index: number, start: number): string {
  let suffix = 0;
  let placeholder = `__MAISTER_TEMPLATE_DEFAULT_${index}_${template.length}_${start}__`;

  while (template.includes(placeholder)) {
    suffix += 1;
    placeholder = `__MAISTER_TEMPLATE_DEFAULT_${index}_${template.length}_${start}_${suffix}__`;
  }

  return placeholder;
}

function protectDefaultExpressions(
  template: string,
  context: Record<string, unknown>,
  opts: RenderOptions,
): { template: string; resolutions: DefaultResolution[] } {
  let output = "";
  let cursor = 0;
  const resolutions: DefaultResolution[] = [];

  while (cursor < template.length) {
    const start = template.indexOf("{{", cursor);

    if (start === -1) {
      output += template.slice(cursor);
      break;
    }

    const close = findMustacheClose(template, start);

    if (close === -1) {
      output += template.slice(cursor);
      break;
    }

    const rawTag = template.slice(start + 2, close).trim();
    const expression = parseDefaultExpression(rawTag);

    if (!expression) {
      output += template.slice(cursor, close + 2);
      cursor = close + 2;
      continue;
    }

    const resolved = resolvePath(context, expression.path);
    const usedDefault = !resolved.found;
    const value = resolved.found ? renderScalar(resolved.value) : expression.literal;
    const placeholder = makePlaceholder(template, resolutions.length, start);

    log.debug(
      { path: expression.path, defaulted: usedDefault },
      "resolved default operator",
    );
    if (opts.traceLog) {
      opts.traceLog.debug(
        {
          path: expression.path,
          defaulted: usedDefault,
          value: previewValue(value),
        },
        "resolved default operator",
      );
    }

    output += template.slice(cursor, start);
    output += placeholder;
    resolutions.push({ placeholder, value });
    cursor = close + 2;
  }

  return { template: output, resolutions };
}

function restoreDefaultExpressions(
  rendered: string,
  resolutions: DefaultResolution[],
): string {
  let output = rendered;

  for (const resolution of resolutions) {
    output = output.split(resolution.placeholder).join(resolution.value);
  }

  return output;
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
    const protectedTemplate = protectDefaultExpressions(template, context, opts);
    const rendered = Mustache.render(protectedTemplate.template, view);

    return restoreDefaultExpressions(rendered, protectedTemplate.resolutions);
  } catch (err) {
    if (err instanceof MaisterError) throw err;
    const msg = err instanceof Error ? err.message : String(err);

    throw new MaisterError("CONFIG", `mustache render failed: ${msg}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }
}
