// ---------------------------------------------------------------------------
// UT-I18N-01 — a parameterized message is never resolved without its values.
//
// `t("pageLabel")` on a message reading `"Page {page}"` does not degrade: it
// throws `FORMATTING_ERROR: The intl string context variable "page" was not
// provided`, and in a Server Component that takes the whole render down. It is
// invisible until somebody loads the page — typecheck passes, lint passes, and
// no unit test touches the call site.
//
// Two shapes are legitimate, and both pass here:
//   - `t("key", { page })` — resolve it, with its values.
//   - `t.raw("key")`       — hand the TEMPLATE to a component that substitutes
//                            it itself. `NumberedPagination` does exactly that
//                            (`formatTemplate(labels.page, { page: item })`),
//                            and so does the agent-memory drawer
//                            (`labels.size.replace("{size}", …)`).
//
// Five call sites were wrong when this guard was written: three pagination
// labels, the runs-list pagination label, and the agent memory size. The first
// surfaced as a 500 on the project board, found in a Playwright web-server log
// rather than by any assertion.
//
// If this fails: pass the values, or switch to `t.raw()` when the consumer
// interpolates. Do NOT strip the `{...}` from the message — that moves the
// defect into the copy.
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";

const WEB_ROOT = path.resolve(__dirname, "../..");
const ROOTS = ["app", "components", "lib"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
  "__tests__",
]);

/** `{name}` and the ICU `{count, plural, …}` head alike. */
const PARAM = /\{(\w+)\s*[,}]/u;
const BIND =
  /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:getTranslations|useTranslations)\(\s*["']([\w.]+)["']\s*\)/gu;
const BIND_ROOT =
  /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:getTranslations|useTranslations)\(\s*\)/gu;
/** One argument only: `t("key")`. A second argument means values were passed. */
const CALL = /(?<![\w.])(\w+)\(\s*["']([\w.]+)["']\s*\)/gu;

function messageAt(dotted: string): string | null {
  let node: unknown = en;

  for (const part of dotted.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }

  return typeof node === "string" ? node : null;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;

    const full = path.join(dir, entry);

    if (statSync(full).isDirectory()) {
      yield* sourceFiles(full);
      continue;
    }
    if (/\.(ts|tsx)$/u.test(entry)) yield full;
  }
}

function unparameterizedCalls(): string[] {
  const offenders: string[] = [];

  for (const root of ROOTS) {
    for (const file of sourceFiles(path.join(WEB_ROOT, root))) {
      const src = readFileSync(file, "utf8");
      const namespaces = new Map<string, string>();

      for (const [, variable, namespace] of src.matchAll(BIND)) {
        namespaces.set(variable, namespace);
      }
      for (const [, variable] of src.matchAll(BIND_ROOT)) {
        namespaces.set(variable, "");
      }
      if (namespaces.size === 0) continue;

      src.split("\n").forEach((line, index) => {
        // The sanctioned escape hatch: the consumer interpolates.
        if (line.includes(".raw(")) return;

        for (const [, variable, key] of line.matchAll(CALL)) {
          const namespace = namespaces.get(variable);

          if (namespace === undefined) continue;

          const full = namespace ? `${namespace}.${key}` : key;
          const message = messageAt(full);

          if (message !== null && PARAM.test(message)) {
            offenders.push(
              `${path.relative(WEB_ROOT, file)}:${index + 1} — ${variable}("${key}") -> ${full} = ${JSON.stringify(message)}`,
            );
          }
        }
      });
    }
  }

  return offenders.sort();
}

describe("UT-I18N-01 parameterized messages carry their values", () => {
  it("has no translator call that formats a template without its values", () => {
    expect(unparameterizedCalls()).toEqual([]);
  });

  it("can still see the shape it forbids", () => {
    // A gate whose search space is empty is indistinguishable from a broken
    // one: the catalog must still CONTAIN parameterized messages.
    const catalog = en as unknown as Record<string, unknown>;
    const parameterized = Object.values(catalog).filter(
      (group) =>
        typeof group === "object" &&
        group !== null &&
        Object.values(group as Record<string, unknown>).some(
          (value) => typeof value === "string" && PARAM.test(value),
        ),
    );

    expect(parameterized.length).toBeGreaterThan(0);
  });
});
