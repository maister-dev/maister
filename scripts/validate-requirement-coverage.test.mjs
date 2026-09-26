import assert from "node:assert/strict";
import test from "node:test";

import {
  COVERAGE_GROUPS,
  checkGroupCoverage,
  declaredIds,
  evaluateCoverage,
  matrixRows,
  planTaskIds,
  testIdsInSource,
} from "./validate-requirement-coverage.mjs";

const PREFIXES = ["LCV", "LAU"];
const PHASES = /^T[1-6]\./;

function doc(requirement, edge) {
  return `# D\n\n## Expectations\n\n- **${requirement}:** Contract.\n\n## Edge cases\n\n- **${edge}:** Case.\n\n## Linked artifacts\n`;
}

function row(id, tasks, primary, status = "Planned") {
  return `| ${id} | contract | ${tasks} | ${primary} | ${status} |`;
}

function evaluate({ matrix, plan, suite = new Set() }) {
  return evaluateCoverage({
    ids: declaredIds([doc("LCV-01", "EDGE-LCV-01"), doc("LAU-01", "EDGE-LAU-01")], PREFIXES),
    rows: matrixRows(matrix, PREFIXES),
    tasks: planTaskIds(plan),
    suiteIds: suite,
    prefixes: PREFIXES,
    implementationPhases: PHASES,
  });
}

const PLAN = "**T0.1 [x] — Spec.**\n**T1.1 [ ] — Build.**\n**T2.1 [ ] — Build more.**\n**T7.1 [ ] — Qualify.**\n";
const FULL_MATRIX = [
  row("LCV-01", "T1.1", "IT-LCV-01"),
  row("EDGE-LCV-01", "T1.1", "IT-EDGE-LCV-01"),
  row("LAU-01", "T2.1", "IT-LAU-01"),
  row("EDGE-LAU-01", "T2.1, T7.1", "IT-EDGE-LAU-01"),
].join("\n");

test("holds when every id and every implementation task is covered", () => {
  assert.deepEqual(evaluate({ matrix: FULL_MATRIX, plan: PLAN }), []);
});

test("a Planned row's primary test need not exist yet; an Implemented one must", () => {
  const implemented = FULL_MATRIX.replace(
    row("LCV-01", "T1.1", "IT-LCV-01"),
    row("LCV-01", "T1.1", "IT-LCV-01", "Implemented"),
  );
  assert.deepEqual(evaluate({ matrix: FULL_MATRIX, plan: PLAN }), []);
  assert.match(
    evaluate({ matrix: implemented, plan: PLAN }).join("\n"),
    /LCV-01: primary test IT-LCV-01 resolves to no test in the suite/,
  );
  assert.deepEqual(
    evaluate({ matrix: implemented, plan: PLAN, suite: new Set(["IT-LCV-01"]) }),
    [],
  );
});

test("rejects an implementation task no row names, and a row naming an undefined task", () => {
  const orphaned = FULL_MATRIX.replace(
    row("LAU-01", "T2.1", "IT-LAU-01"),
    row("LAU-01", "T3.9", "IT-LAU-01"),
  ).replace(row("EDGE-LAU-01", "T2.1, T7.1", "IT-EDGE-LAU-01"), row("EDGE-LAU-01", "T7.1", "IT-EDGE-LAU-01"));
  const failures = evaluate({ matrix: orphaned, plan: PLAN }).join("\n");
  assert.match(failures, /T2\.1: implementation task named by no requirement row/);
  assert.match(failures, /LAU-01: names task T3\.9, which the plan does not define/);
  assert.doesNotMatch(failures, /T0\.1|T7\.1: implementation task/);
});

test("rejects a declared id absent from the matrix and a matrix row no document declares", () => {
  const matrix = FULL_MATRIX.replace(row("LCV-01", "T1.1", "IT-LCV-01"), row("LCV-02", "T1.1", "IT-LCV-02"));
  const failures = evaluate({ matrix, plan: PLAN }).join("\n");
  assert.match(failures, /LCV-01: declared in a requirement document but absent from the matrix/);
  assert.match(failures, /LCV-02: matrix row for an id no requirement document declares/);
});

test("only describe/it/test titles count as resolvable test ids", () => {
  const ids = testIdsInSource(
    '// IT-LCV-09 is mentioned in a comment\ndescribe("IT-LCV-01 conversation", () => { it("IT-EDGE-LCV-01 two tabs", () => {}); });',
    PREFIXES,
  );
  assert.deepEqual([...ids].sort(), ["IT-EDGE-LCV-01", "IT-LCV-01"]);
});

// Regression pin: generalizing the M51 gate must not change M51's result. At the
// base commit the M51 matrix has exactly one pre-existing defect — the
// EDGE-ATN-08 row cites "ADR-171 D7" instead of a plan task. When that row is
// repaired, update this expectation to [].
test("M51 group keeps the exact result of the retired validate-m51-coverage gate", () => {
  const { failures, ids, rows } = checkGroupCoverage(COVERAGE_GROUPS.m51);
  assert.deepEqual(failures, ["EDGE-ATN-08: matrix row names no enforcing task"]);
  assert.equal(ids.length, rows.size);
});
