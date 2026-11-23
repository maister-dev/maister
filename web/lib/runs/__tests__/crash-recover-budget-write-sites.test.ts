import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { CRASH_RECOVER_BUDGET_RESET } from "../crash-recover";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, "..", "..", "..");

// ADR-176 D4 — the budget is INTENT-scoped, and that property lives entirely in
// where the reset is applied. `resume_started_at` has two write sites and five
// release sites; two of the release sites are reparks, so chasing releases
// cannot make a fresh intent start from zero while resetting at the WRITE can.
//
// A behavioural test cannot see another write site someone adds later — it
// would simply not be covered. This one reads the source, so a new stamp of the
// marker without the reset fails here rather than silently shortening some
// future run's budget.
function markerWrites(
  file: string,
  source: string,
): { offset: number; resetsBudget: boolean }[] {
  const syntax = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const writes: { offset: number; resetsBudget: boolean }[] = [];

  function inspectUpdate(update: ts.Expression): void {
    if (ts.isConditionalExpression(update)) {
      inspectUpdate(update.whenTrue);
      inspectUpdate(update.whenFalse);

      return;
    }
    if (!ts.isObjectLiteralExpression(update)) return;
    const stamp = update.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText(syntax) === "resumeStartedAt" &&
        property.initializer.kind !== ts.SyntaxKind.NullKeyword,
    );

    if (!stamp) return;
    writes.push({
      offset: stamp.getStart(syntax),
      resetsBudget: update.properties.some(
        (property) =>
          ts.isSpreadAssignment(property) &&
          ts.isIdentifier(property.expression) &&
          property.expression.text === "CRASH_RECOVER_BUDGET_RESET",
      ),
    });
  }

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "set"
    ) {
      const [update] = node.arguments;

      if (update) inspectUpdate(update);
    }
    ts.forEachChild(node, visit);
  }

  visit(syntax);

  return writes;
}

describe("crash-recover budget reset at every claim-marker write site", () => {
  it("resets both columns", () => {
    expect(CRASH_RECOVER_BUDGET_RESET).toEqual({
      crashRecoverAttempts: 0,
      crashRecoverNextRetryAt: null,
    });
  });

  it.each([
    ["lib/runs/recover.ts", 1],
    ["lib/scheduler.ts", 1],
  ] as const)(
    "%s stamps the marker only alongside the reset",
    async (file, expectedCount) => {
      const source = await readFile(path.join(WEB_DIR, file), "utf8");
      const writes = markerWrites(file, source);

      expect(writes).toHaveLength(expectedCount);

      for (const write of writes) {
        expect(
          write.resetsBudget,
          `${file}: a \`resumeStartedAt\` stamp near offset ${write.offset} does not spread CRASH_RECOVER_BUDGET_RESET — ` +
            "a fresh recover intent would inherit the previous intent's spent budget",
        ).toBe(true);
      }
    },
  );
});
