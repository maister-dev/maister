import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  validateDocsIndexes,
  validateStageBAnalytics,
} from "./validate-docs-indexes.mjs";

const documents = [
  ["execution-event-plane.md", "EVT-01", "EDGE-EVT-01"],
  ["execution-prompt-lifecycle.md", "PRM-01", "EDGE-PRM-01"],
  ["execution-runtime-objects.md", "OBJ-01", "EDGE-OBJ-01"],
  ["execution-data-cutover.md", "CUT-01", "EDGE-CUT-01"],
];

function documentBody(requirement, edge, traceability = "") {
  return `# Fixture\n\n## Purpose\n\nText.\n\n## Domain entities\n\n- Entity.\n\n## State machine\n\nText.\n\n## Process flows\n\nText.\n\n## Expectations\n\n- **${requirement}:** Contract.\n\n## Edge cases\n\n- **${edge}:** Case.\n\n## Linked artifacts\n\n- [Artifact](artifact.md)\n${traceability}`;
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

  const rows = documents
    .map(
      ([, requirement, edge]) =>
        `| ${requirement} | contract | enforcement | IT-${requirement} | Designed |\n| ${edge} | contract | enforcement | IT-${edge} | Designed |`,
    )
    .join("\n");
  const indexRows = documents
    .map(([name]) => `| Fixture | [${name}](${name}) | fixture |`)
    .join("\n");
  await writeFile(
    join(analytics, "README.md"),
    `# Index\n\n| Domain | File | Scope |\n| --- | --- | --- |\n${indexRows}\n| Artifact | [artifact.md](artifact.md) | fixture |\n`,
  );

  for (const [name, requirement, edge] of documents) {
    const traceability =
      name === "execution-data-cutover.md"
        ? `\n### Stage B traceability\n\n| Requirement | Contract | Enforcement | Primary test | Status |\n| --- | --- | --- | --- | --- |\n${rows}\n`
        : "";
    await writeFile(
      join(analytics, name),
      documentBody(requirement, edge, traceability),
    );
  }
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

test("rejects an unindexed analytics document", async () => {
  await withFixture(async (root) => {
    const readme = join(root, "system-analytics", "README.md");
    const current = await readFile(readme, "utf8");
    await writeFile(readme, current.replace("| Fixture | [execution-event-plane.md](execution-event-plane.md) | fixture |\n", ""));
    const failures = validateDocsIndexes(root).failures.join("\n");
    assert.match(failures, /execution-event-plane.md is not linked/);
  });
});
