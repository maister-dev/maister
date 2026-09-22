import test from "node:test";
import assert from "node:assert/strict";

import {
  checkAdrIndexRows,
  parseAdrIndexRows,
  parseAdrStubs,
  splitTableRow,
} from "./validate-docs-adr-anchors.mjs";

// The hub keeps an index table AND a `### ADR-NNN:` stub per ADR. Before this
// check nothing compared them, which is how ADR-177's row vanished in a
// renumber while its stub, its body file and their title/status stayed in sync
// and every existing gate stayed green.

const ROW_177 =
  "| [ADR-177](#adr-177-evidence-first-crash-classification) | Evidence-first crash classification | Implemented | 2026-09-21 |";

function hub({ rows = [ROW_177], stubs = null } = {}) {
  const stubBlock =
    stubs ??
    "### ADR-177: Evidence-first crash classification\n\n**Status:** Implemented\n**Date:** 2026-09-21\n";
  return `# Decisions\n\n| ADR | Title | Status | Date |\n| --- | --- | --- | --- |\n${rows.join("\n")}\n\n---\n\n${stubBlock}\n`;
}

test("splitTableRow keeps an ESCAPED pipe inside a cell", () => {
  // ADR-069's real title: `version_binding` (pinned\|latest). A plain
  // split("|") reads this row as five cells and invents a failure.
  const line =
    "| [ADR-069](#adr-069-x) | `version_binding` (pinned\\|latest) + resolve | Implemented | 2026-06-08 |";
  const cells = splitTableRow(line);

  assert.equal(cells.length, 6);
  assert.equal(cells[2], "`version_binding` (pinned|latest) + resolve");
});

test("parseAdrIndexRows reads anchor, title, status and date", () => {
  const row = parseAdrIndexRows(hub()).get("177");

  assert.deepEqual(row, {
    anchor: "adr-177-evidence-first-crash-classification",
    title: "Evidence-first crash classification",
    status: "Implemented",
    date: "2026-09-21",
  });
});

test("parseAdrStubs reads the stub title, status and date", () => {
  assert.deepEqual(parseAdrStubs(hub()).get("177"), {
    title: "Evidence-first crash classification",
    status: "Implemented",
    date: "2026-09-21",
  });
});

test("a well-formed hub produces no failures", () => {
  assert.deepEqual(checkAdrIndexRows(hub()), []);
});

test("a stub with NO index row fails — the ADR-177 renumber defect", () => {
  const failures = checkAdrIndexRows(hub({ rows: [] }));

  assert.equal(failures.length, 1);
  assert.match(failures[0], /ADR-177 .*stub but no row in the index table/);
});

test("an index row with NO stub fails", () => {
  const failures = checkAdrIndexRows(
    hub({ rows: [ROW_177, "| [ADR-901](#adr-901-ghost) | Ghost | x | y |"] }),
  );

  assert.equal(failures.length, 1);
  assert.match(failures[0], /ADR-901 has an index-table row but no/);
});

test("a row TITLE that differs from the stub fails", () => {
  const failures = checkAdrIndexRows(
    hub({ rows: [ROW_177.replace("classification |", "classifcation |")] }),
  );

  assert.ok(failures.some((f) => /index-row title differs/.test(f)), failures);
});

test("a row DATE that differs from the stub fails", () => {
  const failures = checkAdrIndexRows(
    hub({ rows: [ROW_177.replace("2026-09-21 |", "2026-09-22 |")] }),
  );

  assert.deepEqual(failures.filter((f) => /date differs/.test(f)).length, 1);
});

test("a row ANCHOR that does not slugify from the stub heading fails", () => {
  const failures = checkAdrIndexRows(
    hub({
      rows: [
        ROW_177.replace(
          "#adr-177-evidence-first-crash-classification",
          "#adr-177-evidence-first",
        ),
      ],
    }),
  );

  assert.ok(failures.some((f) => /does not slugify/.test(f)), failures);
});

// The exemption, pinned. The row's status column is deliberately an
// ABBREVIATION of the stub's: ADR-053's stub status is a paragraph with links
// while its row reads "Accepted _(partially superseded)_", and ten rows
// abbreviate this way today. A future tidy-up that "completes" the contract by
// comparing status would go red on all ten — this case says that is intended.
test("a row STATUS that differs from the stub does NOT fail", () => {
  const failures = checkAdrIndexRows(
    hub({
      rows: [
        ROW_177.replace("| Implemented |", "| Implemented _(ef)_ |"),
      ],
    }),
  );

  assert.deepEqual(failures, []);
});

test("a stub with no **Date:** line is accepted, and its date is not compared", () => {
  const failures = checkAdrIndexRows(
    hub({
      stubs:
        "### ADR-177: Evidence-first crash classification\n\n**Status:** Implemented\n",
    }),
  );

  assert.deepEqual(failures, []);
});
