import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import {
  askHumanToolInputSchema,
  scopedHumanAskBodySchema,
} from "../lib/services/agent-question-contract";

for (const [file, input] of [
  ["ask-human-input.schema.json", askHumanToolInputSchema],
  ["scoped-ask-human-input.schema.json", scopedHumanAskBodySchema],
] as const) {
  const schema = z.toJSONSchema(input, {
    target: "draft-07",
    io: "input",
    unrepresentable: "any",
  });
  const target = resolve(process.cwd(), "../runtime", file);
  const content = JSON.stringify(schema, null, 2) + "\n";

  if (process.argv.includes("--check")) {
    if ((await readFile(target, "utf8")) !== content)
      throw new Error("Human-ask schema is stale: " + file);
  } else await writeFile(target, content);
}
