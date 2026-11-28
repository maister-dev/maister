import "server-only";

import pino from "pino";

const log = pino({
  name: "i18n-client-messages",
  level: process.env.LOG_LEVEL ?? "info",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolvePath(
  messages: Record<string, unknown>,
  dotted: string,
): { found: true; value: unknown } | { found: false } {
  const segments = dotted.split(".");
  let cursor: unknown = messages;

  for (const segment of segments) {
    if (
      !isRecord(cursor) ||
      !Object.prototype.hasOwnProperty.call(cursor, segment)
    ) {
      return { found: false };
    }
    cursor = cursor[segment];
  }

  if (cursor === undefined) {
    return { found: false };
  }

  return { found: true, value: cursor };
}

function handleUnknownPath(path: string): void {
  if (process.env.NODE_ENV === "production") {
    log.warn({ path }, "unknown client i18n message path omitted");

    return;
  }

  throw new Error(`Unknown client i18n message path: ${path}`);
}

/**
 * Picks top-level namespaces and dotted subtrees from a locale message catalog
 * for serialization to the root `NextIntlClientProvider`.
 *
 * Whole namespaces and dotted leaves are assigned by reference without mutating
 * `messages`. Unknown paths throw outside production and are omitted with a
 * WARN log in production (CMSG-06, CMSG-07).
 */
export function pickMessages(
  messages: Record<string, unknown>,
  paths: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ownedContainers = new WeakSet<object>();

  ownedContainers.add(out);

  for (const path of paths) {
    const resolved = resolvePath(messages, path);

    if (!resolved.found) {
      handleUnknownPath(path);
      continue;
    }

    const segments = path.split(".");

    if (segments.length === 1) {
      out[segments[0]] = resolved.value;
      continue;
    }

    let target: Record<string, unknown> = out;
    let coveredByAncestor = false;

    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i];
      const existing = target[segment];

      if (existing === undefined) {
        const container: Record<string, unknown> = {};

        ownedContainers.add(container);
        target[segment] = container;
        target = container;
      } else if (isRecord(existing) && ownedContainers.has(existing)) {
        target = existing;
      } else {
        // An ancestor whole namespace was already copied by reference from
        // `messages`; leave it intact without mutating the source catalog.
        coveredByAncestor = true;
        break;
      }
    }

    if (!coveredByAncestor) {
      target[segments[segments.length - 1]] = resolved.value;
    }
  }

  if (log.isLevelEnabled("debug")) {
    log.debug(
      {
        paths: paths.length,
        bytes: Buffer.byteLength(JSON.stringify(out), "utf8"),
      },
      "[i18n.client-messages] provided",
    );
  }

  return out;
}
