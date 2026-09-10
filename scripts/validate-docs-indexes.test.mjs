import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  validateAnalyticsGroup,
  validateDocsIndexes,
  validateM51Analytics,
  validateStageBAnalytics,
} from "./validate-docs-indexes.mjs";

// Both registered groups are built by the fixture. `validateDocsIndexes` runs
// every group, so a fixture that satisfies only one of them fails the other —
// which is the regression this shape exists to prevent.
const STAGE_B = {
  label: "Stage B",
  traceabilityFile: "execution-data-cutover.md",
  documents: [
    ["execution-event-plane.md", "EVT-01", "EDGE-EVT-01"],
    ["execution-prompt-lifecycle.md", "PRM-01", "EDGE-PRM-01"],
    ["execution-runtime-objects.md", "OBJ-01", "EDGE-OBJ-01"],
    ["execution-data-cutover.md", "CUT-01", "EDGE-CUT-01"],
  ],
};

const M51 = {
  label: "M51",
  traceabilityFile: "m51-traceability.md",
  documents: [
    ["work-stages.md", "STG-01", "EDGE-STG-01"],
    ["attention.md", "ATN-01", "EDGE-ATN-01"],
    ["home-navigation.md", "NAV-01", "EDGE-NAV-01"],
    ["notifications.md", "NTF-01", "EDGE-NTF-01"],
  ],
};

const GROUPS = [STAGE_B, M51];

function documentBody(requirement, edge, traceability = "") {
  return `# Fixture\n\n## Purpose\n\nText.\n\n## Domain entities\n\n- Entity.\n\n## State machine\n\nText.\n\n## Process flows\n\nText.\n\n## Expectations\n\n- **${requirement}:** Contract.\n\n## Edge cases\n\n- **${edge}:** Case.\n\n## Linked artifacts\n\n- [Artifact](artifact.md)\n${traceability}`;
}

function traceabilityRows(group) {
  return group.documents
    .map(
      ([, requirement, edge]) =>
        `| ${requirement} | contract | enforcement | IT-${requirement} | Designed |\n| ${edge} | contract | enforcement | IT-${edge} | Designed |`,
    )
    .join("\n");
}

function traceabilityTable(group) {
  return `\n### ${group.label} traceability\n\n| Requirement | Contract | Enforcement | Primary test | Status |\n| --- | --- | --- | --- | --- |\n${traceabilityRows(group)}\n`;
}

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "maister-doc-index-"));
  const analytics = join(root, "system-analytics");
  await mkdir(analytics, { recursive: true });
  await mkdir(join(root, "db"));
  await mkdir(join(root, "screens"));
  await mkdir(join(root, "plans"));
  await writeFile(join(root, "db", "README.md"), "# DB\n");
  await writeFile(join(root, "screens", "README.md"), "# Screens\n");
  await writeFile(join(root, "plans", "README.md"), "# Plans\n");
  await writeFile(join(analytics, "artifact.md"), "# Artifact\n");

  const indexed = ["artifact.md"];

  for (const group of GROUPS) {
    for (const [name, requirement, edge] of group.documents) {
      // Stage B keeps its matrix inside one of its own documents; M51 keeps it
      // in a standalone file, so both shapes are exercised.
      const inlineMatrix =
        name === group.traceabilityFile ? traceabilityTable(group) : "";
      await writeFile(
        join(analytics, name),
        documentBody(requirement, edge, inlineMatrix),
      );
      indexed.push(name);
    }

    if (!group.documents.some(([name]) => name === group.traceabilityFile)) {
      await writeFile(
        join(analytics, group.traceabilityFile),
        `# ${group.label} traceability\n${traceabilityTable(group)}`,
      );
      indexed.push(group.traceabilityFile);
    }
  }

  const indexRows = indexed
    .map((name) => `| Fixture | [${name}](${name}) | fixture |`)
    .join("\n");
  await writeFile(
    join(analytics, "README.md"),
    `# Index\n\n| Domain | File | Scope |\n| --- | --- | --- |\n${indexRows}\n`,
  );

  return root;
}

async function withFixture(run) {
  const root = await fixtureRoot();
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("accepts a complete, indexed Stage B specification fixture", async () => {
  await withFixture(async (root) => {
    assert.deepEqual(validateStageBAnalytics(join(root, "system-analytics")), []);
    assert.deepEqual(validateDocsIndexes(root).failures, []);
  });
});

test("accepts a complete, indexed M51 specification fixture", async () => {
  await withFixture(async (root) => {
    assert.deepEqual(validateM51Analytics(join(root, "system-analytics")), []);
  });
});

test("accepts aligned Markdown traceability tables", async () => {
  await withFixture(async (root) => {
    const cutover = join(
      root,
      "system-analytics",
      "execution-data-cutover.md",
    );
    const current = await readFile(cutover, "utf8");
    const aligned = current.replaceAll(
      "| EVT-01 | contract | enforcement | IT-EVT-01 | Designed |",
      "| EVT-01      | contract | enforcement | IT-EVT-01 | Designed |",
    );

    await writeFile(cutover, aligned);

    assert.deepEqual(
      validateStageBAnalytics(join(root, "system-analytics")),
      [],
    );
  });
});

test("rejects missing R5 sections and excess expectation bullets", async () => {
  await withFixture(async (root) => {
    const analytics = join(root, "system-analytics");
    await writeFile(
      join(analytics, "execution-event-plane.md"),
      documentBody("EVT-01", "EDGE-EVT-01").replace("## State machine\n\nText.\n\n", "").replace(
        "- **EVT-01:** Contract.",
        Array.from({ length: 13 }, () => "- **EVT-01:** Contract.").join("\n"),
      ),
    );
    const failures = validateStageBAnalytics(analytics).join("\n");
    assert.match(failures, /missing R5 section State machine/);
    assert.match(failures, /Expectations has 13 bullets/);
  });
});

test("rejects duplicate requirements, a missing primary test, and broken artifacts", async () => {
  await withFixture(async (root) => {
    const analytics = join(root, "system-analytics");
    const eventPath = join(analytics, "execution-event-plane.md");
    await writeFile(
      eventPath,
      documentBody("EVT-01", "EDGE-EVT-01").replace(
        "[Artifact](artifact.md)",
        "[Artifact](missing.md)",
      ),
    );
    await writeFile(
      join(analytics, "execution-prompt-lifecycle.md"),
      documentBody("EVT-01", "EDGE-PRM-01"),
    );
    const cutover = join(analytics, "execution-data-cutover.md");
    const current = await readFile(cutover, "utf8");
    await writeFile(cutover, current.replace("| EVT-01 | contract | enforcement | IT-EVT-01 | Designed |\n", ""));
    const failures = validateStageBAnalytics(analytics).join("\n");
    assert.match(failures, /duplicate Stage B requirement ID EVT-01/);
    assert.match(failures, /EVT-01: missing traceability row with primary test/);
    assert.match(failures, /broken linked artifact missing.md/);
  });
});

test("rejects a missing M51 analytics document, naming the M51 group", async () => {
  await withFixture(async (root) => {
    const analytics = join(root, "system-analytics");
    await rm(join(analytics, "attention.md"));
    const failures = validateM51Analytics(analytics).join("\n");
    assert.match(failures, /attention\.md: missing M51 analytics document/);
    // The Stage B group must not notice an M51 document at all.
    assert.deepEqual(validateStageBAnalytics(analytics), []);
  });
});

test("rejects an M51 requirement with no row in m51-traceability.md", async () => {
  await withFixture(async (root) => {
    const analytics = join(root, "system-analytics");
    const matrix = join(analytics, "m51-traceability.md");
    const current = await readFile(matrix, "utf8");
    await writeFile(
      matrix,
      current.replace("| STG-01 | contract | enforcement | IT-STG-01 | Designed |\n", ""),
    );
    const failures = validateM51Analytics(analytics).join("\n");
    assert.match(failures, /STG-01: missing traceability row with primary test/);
  });
});

test("rejects an M51 traceability row whose primary test cell is blank", async () => {
  await withFixture(async (root) => {
    const analytics = join(root, "system-analytics");
    const matrix = join(analytics, "m51-traceability.md");
    const current = await readFile(matrix, "utf8");
    await writeFile(
      matrix,
      current.replace(
        "| ATN-01 | contract | enforcement | IT-ATN-01 | Designed |",
        "| ATN-01 | contract | enforcement |   | Designed |",
      ),
    );
    const failures = validateM51Analytics(analytics).join("\n");
    assert.match(failures, /ATN-01: missing traceability row with primary test/);
  });
});

test("labels duplicate ids with their own group", async () => {
  await withFixture(async (root) => {
    const analytics = join(root, "system-analytics");
    await writeFile(
      join(analytics, "attention.md"),
      documentBody("STG-01", "EDGE-ATN-01"),
    );
    const failures = validateM51Analytics(analytics).join("\n");
    assert.match(failures, /duplicate M51 requirement ID STG-01/);
    assert.doesNotMatch(failures, /Stage B/);
  });
});

test("validateAnalyticsGroup reports a group with no documents on disk", async () => {
  await withFixture(async (root) => {
    const failures = validateAnalyticsGroup(join(root, "system-analytics"), {
      label: "Fictional",
      documents: ["nope.md"],
      prefixes: ["ZZZ"],
      traceabilityFile: "nope-traceability.md",
    });
    assert.match(failures.join("\n"), /nope\.md: missing Fictional analytics document/);
  });
});

test("rejects an unindexed analytics document", async () => {
  await withFixture(async (root) => {
    const readme = join(root, "system-analytics", "README.md");
    const current = await readFile(readme, "utf8");
    await writeFile(readme, current.replace("| Fixture | [execution-event-plane.md](execution-event-plane.md) | fixture |\n", ""));
    const failures = validateDocsIndexes(root).failures.join("\n");
    assert.match(failures, /execution-event-plane.md is not linked/);
  });
});
