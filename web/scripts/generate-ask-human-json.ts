import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { askHumanToolInputSchema } from "../lib/services/agent-question-contract";

const schema = z.toJSONSchema(askHumanToolInputSchema, {
  target: "draft-07",
  io: "input",
  unrepresentable: "any",
});
const target = resolve(process.cwd(), "../runtime/ask-human-input.schema.json");
const content = `${JSON.stringify(schema, null, 2)}\n`;

if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== content)
    throw new Error(
      "Human-ask MCP schema is stale; run pnpm --filter maister-web generate:ask-human-schema",
    );
} else await writeFile(target, content);
