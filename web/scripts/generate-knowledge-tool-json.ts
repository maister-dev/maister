import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { knowledgeToolInputSchemas } from "../lib/brain/knowledge-tool-contract";

const schema = Object.fromEntries(Object.entries(knowledgeToolInputSchemas).map(([name, input]) => [name, z.toJSONSchema(input, { target: "draft-07", io: "input" })]));
const target = resolve(process.cwd(), "../runtime/knowledge-tool-input.schema.json");
const content = `${JSON.stringify(schema, null, 2)}\n`;

if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== content)
    throw new Error("Knowledge tool schemas are stale; run pnpm --filter maister-web generate:knowledge-tool-schema");
} else await writeFile(target, content);
