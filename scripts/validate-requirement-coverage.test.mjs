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

test("resolves literal table-driven test titles without counting data as tests", () => {
  const ids = testIdsInSource(
    `it.each([0, 1])("IT-OPR-01 completes %i items", () => {});\n` +
    `test.each([{ note: "IT-OPR-09", values: [1, 2] }])(\n"IT-OPR-02 validates a result", () => {});`,
    ["OPR"],
  );
  assert.deepEqual([...ids].sort(), ["IT-OPR-01", "IT-OPR-02"]);
});

// Regression pin: every M51 requirement must name an enforcing plan task.
test("M51 group has complete task and test coverage", () => {
  const { failures, ids, rows } = checkGroupCoverage(COVERAGE_GROUPS.m51);
  assert.deepEqual(failures, []);
  assert.equal(ids.length, rows.size);
});

test("flat task headers are non-vacuous and missing enforcement fails", () => {
  const plan = "- [ ] **T1. Specify**\n- [x] **T4. Build**\n- [ ] **T18. Qualify**\nProse refers to **T9**.\n";
  assert.deepEqual(planTaskIds(plan), ["T1", "T4", "T18"]);
  const rows = matrixRows(row("LCV-01", "T4", "IT-LCV-01", "Implemented"), PREFIXES);
  assert.deepEqual(rows.get("LCV-01").tasks, ["T4"]);
  const failures = evaluateCoverage({
    ids: ["LCV-01"], rows, tasks: planTaskIds(plan), suiteIds: new Set(),
    prefixes: PREFIXES, implementationPhases: /^T(?:[4-9]|1[0-8])$/,
  }).join("\n");
  assert.match(failures, /T18: implementation task named by no requirement row/);
  assert.match(failures, /IT-LCV-01 resolves to no test/);
});

test("operational group covers all 34 contracts and all 15 implementation tasks", () => {
  const group = COVERAGE_GROUPS["operational-agents"];
  assert.ok(group);
  const { failures, ids, rows, tasks } = checkGroupCoverage(group);
  assert.deepEqual(failures, []);
  assert.equal(ids.length, 34);
  assert.equal(rows.size, 34);
  assert.equal(tasks.filter((task) => group.implementationPhases.test(task)).length, 15);
});

test("agent activity task namespace is non-vacuous and rejects an orphan", () => {
  const plan = "- [x] **UX-T01. Baseline**\n- [ ] **UX-T05. Build**\n- [ ] **UX-T30. Publish**\n";
  assert.deepEqual(planTaskIds(plan), ["UX-T01", "UX-T05", "UX-T30"]);
  const rows = matrixRows(row("UX-01", "UX-T05", "IT-UX-01"), ["UX"]);
  assert.deepEqual(rows.get("UX-01").tasks, ["UX-T05"]);
  const failures = evaluateCoverage({
    ids: ["UX-01"], rows, tasks: planTaskIds(plan), suiteIds: new Set(),
    prefixes: ["UX"], implementationPhases: /^UX-T(?:0[5-9]|[12]\d|30)$/,
  });
  assert.match(failures.join("\n"), /UX-T30: implementation task named by no requirement row/);
});


test("agent activity group names all planned obligations and implementation tasks", () => {
  const result = checkGroupCoverage(COVERAGE_GROUPS["agent-activity"]);
  assert.deepEqual(result.failures, []);
  assert.equal(result.ids.length, 39);
  assert.equal(result.rows.size, 39);
  assert.equal(result.tasks.filter((id) => id.startsWith("UX-T")).length, 33);
});

test("const-asserted parameter tables do not swallow following requirement-bearing tests", () => {
  const source = 'it.each(["live"] as const)("owner %s", () => {});\nit("IT-UX-11 permissions", () => {});\nit("IT-UX-17 continuation", () => {});\nit.each([true])("other %s", () => {});';
  assert.deepEqual([...testIdsInSource(source, ["UX"])], ["IT-UX-11", "IT-UX-17"]);
});
