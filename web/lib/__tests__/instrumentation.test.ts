import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getDb = vi.hoisted(() => vi.fn());
const findPendingMigrations = vi.hoisted(() => vi.fn());
const findPendingBrainMigrations = vi.hoisted(() => vi.fn());
const assertDatabaseNotAheadOfBinary = vi.hoisted(() => vi.fn());
const startSchedulerTimer = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/check-migrations", () => ({
  assertDatabaseNotAheadOfBinary,
  findPendingBrainMigrations,
  findPendingMigrations,
}));
vi.mock("@/lib/db/client", () => ({
  getDb,
  beginDbShutdown: vi.fn(),
  closeDb: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/runs/resume-recovery", () => ({
  runResumeRecoverySweep: vi.fn().mockResolvedValue(undefined),
  runTakeoverReturnRecoverySweep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/reconcile", () => ({
  runReconcileSweep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/agents/registry", () => ({
  resyncAgents: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/projector/catch-up-sweep", () => ({
  runProjectorCatchUpSweep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/scheduler/timer", () => ({
  startSchedulerTimer,
  stopSchedulerTimer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/packages/catalog", () => ({
  ensureDefaultPackageSources: vi.fn().mockResolvedValue(undefined),
  refreshStaleSources: vi.fn().mockResolvedValue(undefined),
}));

import { register } from "../../instrumentation";
import { applicationLifecycle } from "../server-lifecycle";

const originalRuntime = process.env.NEXT_RUNTIME;

describe("instrumentation DB boot boundary", () => {
  beforeEach(() => {
    process.env.NEXT_RUNTIME = "nodejs";
    getDb.mockReset();
    getDb.mockReturnValue({});
    findPendingMigrations.mockReset();
    findPendingMigrations.mockResolvedValue([]);
    findPendingBrainMigrations.mockReset();
    findPendingBrainMigrations.mockResolvedValue([]);
    assertDatabaseNotAheadOfBinary.mockReset();
    assertDatabaseNotAheadOfBinary.mockResolvedValue(undefined);
    startSchedulerTimer.mockReset();
  });

  afterEach(async () => {
    applicationLifecycle()?.quiesce();
    await applicationLifecycle()?.drain();
    if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalRuntime;
  });

  it("rejects boot when DB client initialization fails", async () => {
    getDb.mockImplementation(() => {
      throw new Error("database unavailable");
    });

    await expect(register()).rejects.toThrow("database unavailable");
  });

  it("rejects boot on a confirmed pending migration", async () => {
    findPendingMigrations.mockResolvedValue([
      "0094_postgres_graph_only_cutover",
    ]);

    await expect(register()).rejects.toThrow(
      /0094_postgres_graph_only_cutover/,
    );
  });

  // S4.7 / D9 step 10: the other direction of the ledger check — a schema from
  // a newer release refuses this binary before it can write a row.
  it("rejects boot when the database is ahead of this binary", async () => {
    assertDatabaseNotAheadOfBinary.mockRejectedValue(
      new Error(
        "[migrations] database is ahead of this binary: 1 applied migration(s) unknown to its journal",
      ),
    );

    await expect(register()).rejects.toThrow(/ahead of this binary/);
    expect(startSchedulerTimer).not.toHaveBeenCalled();
  });

  // The first case to boot fully: `registerNodeRuntime` loads the whole
  // node-runtime graph through dynamic imports, and that one-time module load
  // (~4 s idle) is not this case's behaviour — so it gets its own budget.
  it("starts only the scheduler fallback timer after boot recovery", async () => {
    await register();

    expect(startSchedulerTimer).toHaveBeenCalledOnce();
  }, 30_000);

  it("does nothing on the edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";

    await register();

    expect(getDb).not.toHaveBeenCalled();
    expect(startSchedulerTimer).not.toHaveBeenCalled();
  });
});

const NODEJS_GUARD = 'process.env.NEXT_RUNTIME === "nodejs"';

function unguardedModuleLoads(sourceText: string): string[] {
  const file = ts.createSourceFile(
    "instrumentation.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node, guarded: boolean): void => {
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(file) === NODEJS_GUARD
    ) {
      visit(node.thenStatement, true);
      if (node.elseStatement) visit(node.elseStatement, guarded);

      return;
    }
    const loadsModule =
      (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) ||
      (ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword);

    if (loadsModule && !guarded) found.push(node.getText(file));
    ts.forEachChild(node, (child: ts.Node) => visit(child, guarded));
  };

  visit(file, false);

  return found;
}

describe("instrumentation edge-runtime bundle boundary", () => {
  // Next compiles instrumentation.ts for the Edge runtime at every boot and
  // resolves every module load it can see in the file — an early `return` in
  // register() hides nothing from the bundler. Only the body of the
  // `NEXT_RUNTIME === "nodejs"` branch is dropped from the Edge build, so
  // every import must sit inside it; otherwise the whole server graph (pg,
  // fs, child_process) lands in the Edge bundle and each page compile prints
  // hundreds of "node module in edge runtime" warnings.
  it("keeps every module load inside the nodejs runtime guard", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../instrumentation.ts", import.meta.url)),
      "utf8",
    );

    expect(unguardedModuleLoads(source)).toEqual([]);
  });
});
